import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { PageHead } from '../components/PageHead';
import { importCsv } from '../lib/importers';
import {
  insertTransactions,
  listAccounts,
  upsertAccountByFingerprint,
  upsertPrice,
} from '../lib/db/repos';
import { slugifyAccountId } from '../lib/db/accountId';
import { prefetchLogos } from '../lib/logos';
import { backfillHistoricalPrices, filterBackfillSymbols } from '../lib/quotes/backfill';
import type { DetectedAccount, ImporterResult, ParsedTransaction } from '../lib/importers/types';

/**
 * UniversalTemplateView
 *
 * The dedicated "beta-unlock" surface for brokerages that Matmon doesn't yet
 * support natively. Reached via the "Don't see your brokerage?" link on
 * OnboardingView (AddAccount step) and AddAccountView (drop step). Replaces
 * the older inline `UniversalTemplatePanel` collapsible.
 *
 * Three top-to-bottom sections:
 *   1. Hero. One paragraph framing the page, plus a back link to wherever the
 *      user came from.
 *   2. Download. Big primary button that pulls the template asset out of
 *      `public/matmon-template.csv`.
 *   3. Schema reference. Two-column table of every column name plus a
 *      one-liner description, followed by the strict Action and Account Type
 *      allow-lists. Mirrors the matmonUniversal importer exactly so users
 *      filling in the spreadsheet can't accidentally type a value that gets
 *      silently skipped.
 *   4. Upload. Dropzone styled identically to the AddAccount primary
 *      dropzone. Successful uploads route the user to the same review step
 *      the regular CSV path uses; once confirmed we hand control back to the
 *      caller via `onComplete`.
 *
 * Visual language matches the rest of the app on purpose: PageHead title,
 * `.card` panels, `.btn`/`.btn-primary` buttons, `.dropzone`. No new design
 * primitives are introduced.
 */

/**
 * Strict allow-lists, kept verbatim from `matmonUniversal.ts`. Showing them
 * inline lets a user filling out the template in Excel confirm at a glance
 * which Action or Account Type values they can type without the import step
 * silently dropping the row.
 */
const ACTION_VALUES = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'div_reinvest',
  'cash_in',
  'cash_out',
  'contribution',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'fee',
];

const ACCOUNT_TYPE_VALUES = [
  'taxable',
  'brokerage',
  'trad_ira',
  'roth_ira',
  'trad_401k',
  'roth_401k',
  '401k',
  'hsa',
  '529',
  'other',
];

type ColumnDoc = { name: string; required: boolean; description: string };

const COLUMN_DOCS: ColumnDoc[] = [
  { name: 'Date', required: true, description: 'Trade or activity date. ISO (2024-01-15) or US (1/15/2024).' },
  { name: 'Action', required: true, description: 'What happened. See the allow-list below.' },
  { name: 'Symbol', required: false, description: 'Ticker. Required for buy/sell/dividend, blank for pure cash.' },
  { name: 'Description', required: false, description: 'Free text. Saved with the transaction for context.' },
  { name: 'Quantity', required: false, description: 'Shares or units. Decimals OK for fractional shares.' },
  { name: 'Price', required: false, description: 'Per-share price in the currency below.' },
  { name: 'Amount', required: false, description: 'Net cash flow. Signed value, used for cash and dividends.' },
  { name: 'Fees', required: false, description: 'Commission or fees on the transaction.' },
  { name: 'Account', required: true, description: 'Account name. Rows with the same Account are grouped.' },
  { name: 'Brokerage', required: true, description: 'Provider name as you want it displayed in Matmon.' },
  { name: 'Account Type', required: false, description: 'Tax wrapper. See the allow-list below.' },
  { name: 'Currency', required: false, description: 'ISO code. Defaults to USD when blank.' },
  { name: 'Notes', required: false, description: 'Free text. Saved with the transaction for context.' },
];

const ACCOUNT_TYPE_OPTIONS = [
  { id: 'taxable', label: 'Taxable brokerage' },
  { id: 'trad_ira', label: 'Traditional IRA' },
  { id: 'roth_ira', label: 'Roth IRA' },
  { id: '401k', label: '401(k)' },
  { id: 'hsa', label: 'HSA' },
  { id: 'other', label: 'Other' },
];

type Reviewing = {
  fileName: string;
  csvText: string;
  result: ImporterResult;
  /** Brokerage-assigned identifier for multi-account picks. */
  accountNumber?: string;
  detectedName?: string;
};

type MultiAccountPicker = {
  fileName: string;
  csvText: string;
  brokerage: string;
  accounts: DetectedAccount[];
  marketPrices?: Array<{ symbol: string; price: number; asOf: Date }>;
};

type Rejection = {
  fileName: string;
  reason: string;
};

type Props = {
  /** Wherever the user came from. Rendered as the "Back to..." link copy. */
  backLabel?: string;
  /** Click handler for the back link. The parent decides where to route. */
  onBack: () => void;
  /** Fired after a successful confirm so the caller can refresh the portfolio
   *  cache (AddAccount) or finish onboarding (Onboarding). */
  onComplete?: () => void | Promise<void>;
};

/** Last 4 digits of a possibly-masked account number string. */
function lastFour(accountNumber?: string): string {
  if (!accountNumber) return '';
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}

function labelFor(id: string): string {
  return ACCOUNT_TYPE_OPTIONS.find(o => o.id === id)?.label ?? id;
}

function formatRange(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function dateRangeOf(txs: ParsedTransaction[]): { start: Date | null; end: Date | null } {
  if (txs.length === 0) return { start: null, end: null };
  let min = txs[0].date;
  let max = txs[0].date;
  for (const t of txs) {
    if (t.date < min) min = t.date;
    if (t.date > max) max = t.date;
  }
  return { start: min, end: max };
}

export function UniversalTemplateView({ backLabel = 'Add Account', onBack, onComplete }: Props) {
  type Step = 'intro' | 'pickAccounts' | 'review' | 'done';
  const [step, setStep] = useState<Step>('intro');
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [multiAccount, setMultiAccount] = useState<MultiAccountPicker | null>(null);
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  const [accountType, setAccountType] = useState('taxable');
  const [accountName, setAccountName] = useState('');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Snapshot the imported result so the review summary stays stable while the
  // user is editing the name / type. (Same pattern as AddAccountView.)
  const reviewSummary = useMemo(() => {
    if (!reviewing) return null;
    const { result } = reviewing;
    return {
      brokerage: result.inferences.brokerage,
      currency: result.inferences.currency,
      dateRange: result.inferences.dateRange,
      transactionCount: result.inferences.transactionCount,
      uniqueSymbols: result.inferences.uniqueSymbols,
      actionsMapped: result.inferences.actionsMapped,
      actionsUnknown: result.inferences.actionsUnknown,
      unmappedActions: result.unmappedActionStrings,
    };
  }, [reviewing]);

  function handleCsv(text: string, fileName: string) {
    setRejection(null);
    setMultiAccount(null);
    const result = importCsv(text);

    if (result.rejectionReason) {
      setRejection({ fileName, reason: result.rejectionReason });
      return;
    }

    if (result.importerId === null) {
      // The universal template view is the explicit "I want to use the
      // template" path. If a user drops something that isn't the universal
      // template (or any other supported brokerage), nudge them at the
      // template instead of falling through to the column-mapping wizard,
      // which is a different concept living on the AddAccount page.
      setRejection({
        fileName,
        reason:
          'This file does not match the universal template header. Download the template above, fill it in, and upload it again. For unknown-but-real brokerage CSVs, use Add Account instead.',
      });
      return;
    }

    if (result.accountsDetected && result.accountsDetected.length > 1) {
      setMultiAccount({
        fileName,
        csvText: text,
        brokerage: result.inferences.brokerage,
        accounts: result.accountsDetected,
        ...(result.marketPrices ? { marketPrices: result.marketPrices } : {}),
      });
      setStep('pickAccounts');
      return;
    }

    const type =
      result.inferences.accountType === 'unknown' ? 'taxable' : result.inferences.accountType;
    setAccountType(type);
    setAccountName(`${result.inferences.brokerage} ${labelFor(type)}`.trim());
    setReviewing({ fileName, csvText: text, result });
    setStep('review');
  }

  function chooseAccount(detected: DetectedAccount) {
    if (!multiAccount) return;
    const subset: ImporterResult = {
      inferences: {
        brokerage: multiAccount.brokerage,
        accountType: detected.accountTypeHint,
        currency: 'USD',
        dateRange: dateRangeOf(detected.transactions),
        transactionCount: detected.transactions.length,
        uniqueSymbols: new Set(detected.transactions.map(t => t.symbol).filter(Boolean) as string[]).size,
        actionsMapped: detected.transactions.length,
        actionsUnknown: 0,
      },
      transactions: detected.transactions,
      unmappedActionStrings: [],
      ...(multiAccount.marketPrices ? { marketPrices: multiAccount.marketPrices } : {}),
    };
    const type = detected.accountTypeHint === 'unknown' ? 'taxable' : detected.accountTypeHint;
    setAccountType(type);
    const last4 = lastFour(detected.accountNumber);
    const auto = [last4, multiAccount.brokerage, detected.name].filter(Boolean).join(' ').trim();
    setAccountName(auto);
    setReviewing({
      fileName: `${multiAccount.fileName} (${detected.name})`,
      csvText: multiAccount.csvText,
      result: subset,
      accountNumber: detected.accountNumber,
      detectedName: detected.name,
    });
    setStep('review');
  }

  async function importAllAccounts() {
    if (!multiAccount) return;
    setImportStatus(`Saving ${multiAccount.accounts.length} accounts...`);
    let totalInserted = 0;
    let totalSkipped = 0;
    const existingIds: string[] = [];
    try {
      const existing = await listAccounts();
      for (const row of existing) existingIds.push(row.id);
    } catch {
      // Worst case the dedupe set is empty; account creation still succeeds.
    }
    for (const acc of multiAccount.accounts) {
      const last4 = acc.last4 || lastFour(acc.accountNumber);
      const autoName = [last4, multiAccount.brokerage, acc.name].filter(Boolean).join(' ').trim();
      const desiredId = slugifyAccountId(autoName, multiAccount.brokerage, existingIds);
      const { id } = await upsertAccountByFingerprint(
        {
          id: desiredId,
          name: autoName,
          brokerage: multiAccount.brokerage,
          account_type: acc.accountTypeHint === 'unknown' ? 'other' : acc.accountTypeHint,
          currency: 'USD',
          created_at: new Date().toISOString(),
        },
        last4,
      );
      existingIds.push(id);
      const counts = await insertTransactions(id, acc.transactions);
      totalInserted += counts.inserted;
      totalSkipped += counts.skipped;
    }
    if (multiAccount.marketPrices && multiAccount.marketPrices.length > 0) {
      for (const mp of multiAccount.marketPrices) {
        try {
          await upsertPrice(mp.symbol, mp.asOf, mp.price);
        } catch {
          // One bad price shouldn't block the rest of the import.
        }
      }
    }
    const tickers: string[] = [];
    let earliest = new Date();
    for (const acc of multiAccount.accounts) {
      for (const t of acc.transactions) {
        if (t.symbol) tickers.push(t.symbol);
        if (t.date < earliest) earliest = t.date;
      }
    }
    if (tickers.length > 0) void prefetchLogos(tickers);

    const backfillSymbols = filterBackfillSymbols(tickers);
    if (backfillSymbols.length > 0) {
      setImportStatus(
        `Saved ${multiAccount.accounts.length} accounts. Imported ${totalInserted} transactions, skipped ${totalSkipped} duplicates. Fetching price history...`,
      );
      try {
        await backfillHistoricalPrices(backfillSymbols, earliest);
      } catch (e) {
        console.error('[matmon] price backfill threw during universal import', e);
      }
    }
    setImportStatus(
      `Saved ${multiAccount.accounts.length} accounts. Imported ${totalInserted} transactions, skipped ${totalSkipped} duplicates.`,
    );
    setStep('done');
  }

  function onFile(file: File) {
    file.text().then(t => handleCsv(t, file.name));
  }

  async function confirmImport() {
    if (!reviewing) return;
    setImportStatus('Saving...');
    const existingIds: string[] = [];
    try {
      const existing = await listAccounts();
      for (const row of existing) existingIds.push(row.id);
    } catch {
      // Worst case the dedupe set is empty.
    }
    const finalName = accountName.trim() || `${reviewing.result.inferences.brokerage} brokerage`;
    const desiredId = slugifyAccountId(
      finalName,
      reviewing.result.inferences.brokerage,
      existingIds,
    );
    const last4 = lastFour(reviewing.accountNumber) || (reviewing.result.inferences.last4 ?? '');
    const { id } = await upsertAccountByFingerprint(
      {
        id: desiredId,
        name: finalName,
        brokerage: reviewing.result.inferences.brokerage,
        account_type: accountType,
        currency: reviewing.result.inferences.currency,
        created_at: new Date().toISOString(),
      },
      last4,
    );
    const counts = await insertTransactions(id, reviewing.result.transactions);
    if (reviewing.result.marketPrices && reviewing.result.marketPrices.length > 0) {
      for (const mp of reviewing.result.marketPrices) {
        try {
          await upsertPrice(mp.symbol, mp.asOf, mp.price);
        } catch {
          // Per-price failures shouldn't block the rest.
        }
      }
    }
    const tickers = reviewing.result.transactions
      .map(t => t.symbol)
      .filter((s): s is string => Boolean(s));
    if (tickers.length > 0) void prefetchLogos(tickers);

    const backfillSymbols = filterBackfillSymbols(tickers);
    if (backfillSymbols.length > 0) {
      let earliest = new Date();
      for (const t of reviewing.result.transactions) {
        if (t.date < earliest) earliest = t.date;
      }
      setImportStatus(
        `Saved ${finalName}. Imported ${counts.inserted} new, skipped ${counts.skipped} duplicates. Fetching price history...`,
      );
      try {
        await backfillHistoricalPrices(backfillSymbols, earliest);
      } catch (e) {
        console.error('[matmon] price backfill threw during universal import', e);
      }
    }
    setImportStatus(
      `Saved ${finalName}. Imported ${counts.inserted} new transactions, skipped ${counts.skipped} duplicates.`,
    );
    setStep('done');
  }

  return (
    <div data-testid="universal-template-view">
      <PageHead
        eyebrow={
          <button
            type="button"
            data-testid="universal-template-back"
            onClick={onBack}
            className="btn btn-ghost"
            style={{ height: 24, padding: '0 8px', fontSize: 11.5, marginLeft: -8 }}
          >
            ← Back to {backLabel}
          </button>
        }
        title="Universal template"
        meta={
          <div>
            <div>Beta unlock</div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              For brokerages without a native importer
            </div>
          </div>
        }
      />

      {step === 'intro' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <HeroCard />

          <DownloadCard />

          <SchemaCard />

          <UploadCard
            dragging={dragging}
            setDragging={setDragging}
            fileInputRef={fileInputRef}
            onFile={onFile}
            rejection={rejection}
            onClearRejection={() => setRejection(null)}
          />
        </div>
      )}

      {step === 'pickAccounts' && multiAccount && (
        <div className="card" style={{ padding: '22px 24px' }}>
          <div className="card-title-row">
            <div>
              <div className="card-title">We found {multiAccount.accounts.length} accounts in this file</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {multiAccount.fileName} · {multiAccount.brokerage}
              </div>
            </div>
            <button className="btn btn-primary" onClick={importAllAccounts}>
              Import all {multiAccount.accounts.length}
            </button>
          </div>
          <div
            style={{
              marginTop: 18,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 12,
            }}
          >
            {multiAccount.accounts.map(acc => {
              const typeLabel =
                acc.accountTypeHint === 'unknown' ? 'Unknown type' : labelFor(acc.accountTypeHint);
              return (
                <button
                  key={acc.key}
                  className="brokerage-card"
                  onClick={() => chooseAccount(acc)}
                  style={{ textAlign: 'left', cursor: 'pointer', padding: 14 }}
                  aria-label={`Import ${acc.name} only`}
                >
                  <div className="brokerage-name">{acc.name}</div>
                  <div className="brokerage-note" style={{ marginTop: 4 }}>
                    {typeLabel} · {acc.transactions.length} transactions
                  </div>
                  <div
                    className="muted"
                    style={{
                      marginTop: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {acc.accountNumber || '(no account number)'}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 14 }}>
            <button
              className="btn"
              onClick={() => {
                setMultiAccount(null);
                setStep('intro');
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {step === 'review' && reviewing && reviewSummary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-title-row">
                <div>
                  <div className="card-title">File</div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: 'var(--ink)',
                      marginTop: 4,
                    }}
                  >
                    {reviewing.fileName}
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', marginTop: 2 }}
                  >
                    {reviewSummary.brokerage} ·{' '}
                    {Math.round(reviewing.csvText.length / 1024).toLocaleString()} KB ·{' '}
                    {reviewing.result.transactions.length} rows · read locally
                  </div>
                </div>
              </div>
              <CsvPreview text={reviewing.csvText} />
            </div>

            <div className="card">
              <div className="card-title-row">
                <div className="card-title">What we figured out</div>
              </div>
              <div
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 24, rowGap: 12 }}
              >
                <InferenceRow k="Brokerage" v={reviewSummary.brokerage} />
                <InferenceRow k="Currency" v={reviewSummary.currency} />
                <InferenceRow
                  k="Date range"
                  v={
                    reviewSummary.dateRange.start
                      ? `${formatRange(reviewSummary.dateRange.start)} to ${formatRange(reviewSummary.dateRange.end!)}`
                      : 'Unknown'
                  }
                />
                <InferenceRow k="Transactions" v={`${reviewSummary.transactionCount} parsed`} />
                <InferenceRow k="Symbols" v={`${reviewSummary.uniqueSymbols} unique`} />
                <InferenceRow
                  k="Action mapping"
                  v={`${reviewSummary.actionsMapped} mapped · ${reviewSummary.actionsUnknown} unknown`}
                />
              </div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  Account type
                </span>
                <select
                  value={accountType}
                  onChange={e => setAccountType(e.target.value)}
                  className="settings-select compact"
                  aria-label="Account type"
                  style={{ marginTop: 4 }}
                >
                  {ACCOUNT_TYPE_OPTIONS.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  Account name
                </span>
                <input
                  type="text"
                  value={accountName}
                  onChange={e => setAccountName(e.target.value)}
                  className="name-input"
                  aria-label="Account name"
                />
              </div>

              {reviewSummary.unmappedActions.length > 0 && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 10,
                    background: 'var(--paper-3)',
                    borderRadius: 8,
                    fontSize: 11.5,
                    color: 'var(--ink-3)',
                  }}
                >
                  Unrecognized actions: {reviewSummary.unmappedActions.slice(0, 5).join(', ')}
                  {reviewSummary.unmappedActions.length > 5 && '...'}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="btn"
              onClick={() => {
                setReviewing(null);
                setStep(multiAccount ? 'pickAccounts' : 'intro');
              }}
            >
              Back
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn btn-primary" onClick={confirmImport}>
              Add {accountName.trim() || 'account'}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="card" style={{ padding: '36px 32px', textAlign: 'center' }}>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 32,
              color: 'var(--ink)',
              marginBottom: 10,
            }}
          >
            Saved.
          </div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 480, margin: '0 auto' }}>
            {importStatus}
          </div>
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 10 }}>
            <button
              className="btn"
              onClick={() => {
                // Stay on the template page so a user with multiple unsupported
                // accounts can keep filling in and uploading the template.
                setStep('intro');
                setReviewing(null);
                setMultiAccount(null);
                setRejection(null);
                setImportStatus(null);
              }}
            >
              Add another
            </button>
            <button
              className="btn btn-primary"
              data-testid="universal-template-finish"
              onClick={() => {
                if (onComplete) {
                  void onComplete();
                } else {
                  onBack();
                }
              }}
            >
              Reload to see it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HeroCard() {
  return (
    <div
      className="card"
      data-testid="universal-template-hero"
      style={{ padding: '24px 26px', background: 'var(--paper-2)' }}
    >
      <div className="card-title" style={{ marginBottom: 10 }}>
        Don't see your brokerage? No problem.
      </div>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          letterSpacing: '-0.005em',
          color: 'var(--ink)',
          margin: 0,
          lineHeight: 1.2,
        }}
      >
        Fill in our template and we'll import it like any other CSV.
      </h2>
      <p
        style={{
          marginTop: 12,
          marginBottom: 0,
          fontSize: 14,
          color: 'var(--ink-2)',
          lineHeight: 1.6,
          maxWidth: 720,
        }}
      >
        Matmon supports Fidelity, Charles Schwab, JP Morgan, and Human Interest natively. If your brokerage
        isn't on that list, download the universal CSV template below, open it in Excel or Google Sheets,
        fill in your transactions, and upload it back. We'll process it the same way we process every other
        import: locally, never over the network.
      </p>
    </div>
  );
}

function DownloadCard() {
  return (
    <div className="card" data-testid="universal-template-download-card" style={{ padding: '22px 24px' }}>
      <div className="card-title-row">
        <div className="card-title">Step 1 · Download</div>
        <span
          className="muted"
          style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
        >
          matmon-template.csv
        </span>
      </div>
      <p
        style={{
          marginTop: 4,
          marginBottom: 16,
          fontSize: 13.5,
          color: 'var(--ink-2)',
          lineHeight: 1.55,
          maxWidth: 640,
        }}
      >
        One row per transaction. Required columns are Date, Action, Account, and Brokerage. The schema
        reference below shows every column and what we expect.
      </p>
      <a
        href="/matmon-template.csv"
        download="matmon-template.csv"
        data-testid="universal-template-download"
        className="btn btn-primary"
        style={{
          textDecoration: 'none',
          height: 36,
          padding: '0 18px',
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: 13.5,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ marginRight: 8 }}
        >
          <path d="M8 1.5v9" />
          <path d="M4 7l4 4 4-4" />
          <path d="M2 13h12" />
        </svg>
        Download universal template
      </a>
    </div>
  );
}

function SchemaCard() {
  return (
    <div className="card" data-testid="universal-template-schema" style={{ padding: '22px 24px' }}>
      <div className="card-title-row">
        <div className="card-title">Step 2 · Schema reference</div>
        <span
          className="muted"
          style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
        >
          13 columns
        </span>
      </div>
      <p
        style={{
          marginTop: 4,
          marginBottom: 16,
          fontSize: 13.5,
          color: 'var(--ink-2)',
          lineHeight: 1.55,
          maxWidth: 640,
        }}
      >
        Header row is fixed; column order isn't. Required columns are marked with an asterisk. Unknown
        Action or Account Type values are skipped at import time rather than guessed.
      </p>
      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--paper-3)' }}>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  fontSize: 10.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--line)',
                  width: 140,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Column
              </th>
              <th
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  fontSize: 10.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--line)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {COLUMN_DOCS.map(c => (
              <tr key={c.name}>
                <td
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--line-soft)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--ink)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.name}
                  {c.required && <span style={{ color: 'var(--accent-ink, #c33)' }}> *</span>}
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--line-soft)',
                    fontSize: 12.5,
                    color: 'var(--ink-2)',
                    lineHeight: 1.55,
                  }}
                >
                  {c.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <AllowList title="Action values" values={ACTION_VALUES} />
        <AllowList title="Account Type values" values={ACCOUNT_TYPE_VALUES} />
      </div>
    </div>
  );
}

function AllowList({ title, values }: { title: string; values: string[] }) {
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--paper-3)',
        borderRadius: 8,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {values.map(v => (
          <code
            key={v}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--ink-2)',
              background: 'var(--paper)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '2px 6px',
            }}
          >
            {v}
          </code>
        ))}
      </div>
    </div>
  );
}

function UploadCard({
  dragging,
  setDragging,
  fileInputRef,
  onFile,
  rejection,
  onClearRejection,
}: {
  dragging: boolean;
  setDragging: (b: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFile: (f: File) => void;
  rejection: Rejection | null;
  onClearRejection: () => void;
}) {
  return (
    <div className="card" data-testid="universal-template-upload-card" style={{ padding: '22px 24px' }}>
      <div className="card-title-row">
        <div className="card-title">Step 3 · Upload</div>
      </div>
      <p
        style={{
          marginTop: 4,
          marginBottom: 16,
          fontSize: 13.5,
          color: 'var(--ink-2)',
          lineHeight: 1.55,
          maxWidth: 640,
        }}
      >
        Once your template is filled in, drop the file here. We'll read it locally, group transactions by
        Account, and route you to the same confirm step the regular CSV flow uses.
      </p>

      {rejection && (
        <div
          role="alert"
          style={{
            marginBottom: 14,
            padding: '12px 14px',
            border: '1px solid var(--accent-ink, #c33)',
            background: 'var(--accent-soft, #fdecec)',
            borderRadius: 10,
          }}
        >
          <div
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.06em',
              color: 'var(--accent-ink, #c33)',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Couldn't read this file
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.55 }}>
            <strong>{rejection.fileName}:</strong> {rejection.reason}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={() => {
                onClearRejection();
                fileInputRef.current?.click();
              }}
            >
              Try a different file
            </button>
          </div>
        </div>
      )}

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        data-testid="universal-template-dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          data-testid="universal-template-file-input"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <div className="dropzone-glyph">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M24 30V8" />
            <path d="M14 18l10-10 10 10" />
            <path d="M8 32v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" />
          </svg>
        </div>
        <div className="dropzone-title">Drop your filled template here</div>
        <div className="dropzone-sub">
          Or click to browse. Read locally, never uploaded.
        </div>
      </div>
    </div>
  );
}

function InferenceRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        className="muted"
        style={{
          fontSize: 10.5,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {k}
      </span>
      <span style={{ fontSize: 13, color: 'var(--ink)' }}>{v}</span>
    </div>
  );
}

function CsvPreview({ text }: { text: string }) {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    preview: 7,
  });
  const rows = (parsed.data as string[][]).filter(r => r.length > 0);
  const header = rows[0] || [];
  const data = rows.slice(1);
  const totalLines = text.split(/\r?\n/).filter(Boolean).length;
  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--line)',
        borderRadius: 10,
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--paper-3)' }}>
            {header.map((h, i) => (
              <th
                key={i}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--line)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td
                  key={j}
                  style={{
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--line-soft)',
                    color: 'var(--ink-2)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 160,
                  }}
                >
                  {c || <span className="dim">--</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{
          padding: '6px 10px',
          background: 'var(--paper-3)',
          color: 'var(--ink-4)',
          fontSize: 10.5,
          letterSpacing: '0.04em',
          borderTop: '1px solid var(--line)',
          textAlign: 'center',
        }}
      >
        ... {Math.max(0, totalLines - 7)} more rows
      </div>
    </div>
  );
}
