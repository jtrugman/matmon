import { useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { PageHead } from '../components/PageHead';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { importCsv, parseWithColumnMap, type ColumnMap } from '../lib/importers';
import {
  insertTransactions,
  listAccounts,
  upsertAccountByFingerprint,
  upsertPrice,
} from '../lib/db/repos';
import { slugifyAccountId } from '../lib/db/accountId';
import { prefetchLogos } from '../lib/logos';
import { pickFunNames } from '../lib/funNames';
import { backfillHistoricalPrices, filterBackfillSymbols } from '../lib/quotes/backfill';
import type { DetectedAccount, ImporterResult, ParsedTransaction } from '../lib/importers/types';

const COLUMN_MAP_STORAGE_KEY = 'matmon.columnMaps.v1';

type ColumnMapField = {
  key: keyof ColumnMap;
  label: string;
  required: boolean;
  hints: string[];
};

const COLUMN_MAP_FIELDS: ColumnMapField[] = [
  {
    key: 'date',
    label: 'Date',
    required: true,
    hints: ['date', 'trade date', 'run date', 'as of', 'settle'],
  },
  {
    key: 'action',
    label: 'Action',
    required: true,
    hints: ['action', 'transaction', 'type', 'activity', 'kind'],
  },
  { key: 'symbol', label: 'Symbol', required: false, hints: ['symbol', 'ticker', 'security'] },
  { key: 'quantity', label: 'Quantity', required: false, hints: ['quantity', 'qty', 'shares', 'units'] },
  { key: 'price', label: 'Price', required: false, hints: ['price', 'unit price', 'per share'] },
  { key: 'fees', label: 'Fees', required: false, hints: ['fee', 'commission', 'comm'] },
  { key: 'amount', label: 'Amount', required: false, hints: ['amount', 'net amount', 'total', 'value'] },
  { key: 'notes', label: 'Notes', required: false, hints: ['note', 'description', 'memo', 'desc'] },
];

function parseCsvHeaders(text: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => h.trim(),
    preview: 1,
  });
  return parsed.meta.fields || [];
}

function shapeKeyFor(headers: string[]): string {
  return JSON.stringify([...headers].sort());
}

function loadSavedMap(headers: string[]): ColumnMap | null {
  try {
    const raw = localStorage.getItem(COLUMN_MAP_STORAGE_KEY);
    if (!raw) return null;
    const store = JSON.parse(raw) as Record<string, ColumnMap>;
    return store[shapeKeyFor(headers)] || null;
  } catch {
    return null;
  }
}

function persistMap(headers: string[], map: ColumnMap) {
  try {
    const raw = localStorage.getItem(COLUMN_MAP_STORAGE_KEY);
    const store = raw ? (JSON.parse(raw) as Record<string, ColumnMap>) : {};
    store[shapeKeyFor(headers)] = map;
    localStorage.setItem(COLUMN_MAP_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be unavailable; failure to persist is non-fatal.
  }
}

function autoGuessMap(headers: string[]): Partial<ColumnMap> {
  const guess: Partial<ColumnMap> = {};
  const used = new Set<string>();
  for (const field of COLUMN_MAP_FIELDS) {
    const match = headers.find(h => {
      if (used.has(h)) return false;
      const lower = h.toLowerCase();
      return field.hints.some(hint => lower.includes(hint));
    });
    if (match) {
      guess[field.key] = match;
      used.add(match);
    }
  }
  return guess;
}

const ACCOUNT_TYPE_OPTIONS = [
  { id: 'taxable', label: 'Taxable brokerage' },
  { id: 'trad_ira', label: 'Traditional IRA' },
  { id: 'roth_ira', label: 'Roth IRA' },
  { id: '401k', label: '401(k)' },
  { id: 'hsa', label: 'HSA' },
  { id: 'other', label: 'Other' },
];

/** Pull the trailing 4-digit window from a brokerage account number that may
 *  be presented as "...2180", "XXXX-1234", or a plain integer. Returns the
 *  empty string when the input has fewer than 4 digits or is missing. */
function lastFour(accountNumber?: string): string {
  if (!accountNumber) return '';
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}

/** Canonical default account name. For multi-account picks we know the
 *  detected name + account number, so we build "1234 JP Morgan
 *  Self-Directed-Ret". For single-account uploads (or column-mapper flows) we
 *  fall back to "<Brokerage> <Type label>" since no account number is known. */
function canonicalAccountName(
  brokerage: string,
  accountType: string,
  detectedName?: string,
  accountNumber?: string,
): string {
  if (detectedName) {
    const last4 = lastFour(accountNumber);
    return [last4, brokerage, detectedName].filter(Boolean).join(' ').trim();
  }
  return `${brokerage} ${labelFor(accountType)}`.trim();
}

type Reviewing = {
  fileName: string;
  csvText: string;
  result: ImporterResult;
  importerId: string | null;
  /** When the review step was reached by picking one account out of a
   *  multi-account file, we keep the brokerage-assigned account number and the
   *  detected name around so the canonical default ("1234 JP Morgan
   *  Self-Directed-Ret") can include the last-4 disambiguator. Undefined for
   *  single-account files and column-mapper flows. */
  detectedName?: string;
  accountNumber?: string;
};

type Mapping = {
  fileName: string;
  csvText: string;
  headers: string[];
};

type Rejection = {
  fileName: string;
  reason: string;
};

type MultiAccountPicker = {
  fileName: string;
  csvText: string;
  brokerage: string;
  importerId: string | null;
  accounts: DetectedAccount[];
  /** File-level market prices (JPM positions exports surface these). Shared
   *  across every account in the multi-account file. */
  marketPrices?: Array<{ symbol: string; price: number; asOf: Date }>;
};

export function AddAccountView({
  prefillBrokerage: _prefillBrokerage,
  onReloadPortfolio,
  onUseUniversalTemplate,
}: {
  prefillBrokerage?: string;
  onReloadPortfolio?: () => void | Promise<void>;
  /** Navigate to the dedicated Universal Template page. The Add Account view
   *  surfaces this through the "Don't see your brokerage?" link beside the
   *  primary dropzone. Undefined in isolated tests; the link is hidden when
   *  not provided. */
  onUseUniversalTemplate?: () => void;
} = {}) {
  const [step, setStep] = useState<'drop' | 'map' | 'pickAccounts' | 'review' | 'done'>('drop');
  const [customName, setCustomName] = useState('');
  // The first suggestion in the shuffled set so the initial UI doesn't show a
  // pill that isn't in the rendered list.
  const funNames = useMemo(() => pickFunNames(Date.now() % 9973, 5), []);
  const [selectedFunName, setSelectedFunName] = useState(funNames[0]);
  // Default to 'default' (the canonical brokerage+type name) so a single click
  // on Add gets the user a perfectly reasonable account name without typing.
  const [nameMode, setNameMode] = useState<'fun' | 'custom' | 'default'>('default');
  const [dragging, setDragging] = useState(false);
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [columnMap, setColumnMap] = useState<Partial<ColumnMap>>({});
  const [customBrokerage, setCustomBrokerage] = useState('Custom');
  const [accountType, setAccountType] = useState('taxable');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [multiAccount, setMultiAccount] = useState<MultiAccountPicker | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Canonical default name uses the detected account number (last 4) when the
  // review step was reached via the multi-account picker. Falls back to
  // "<Brokerage> <Type label>" for single-account / column-mapper flows.
  const techName = reviewing
    ? canonicalAccountName(
        reviewing.result.inferences.brokerage,
        accountType,
        reviewing.detectedName,
        reviewing.accountNumber,
      )
    : canonicalAccountName('Fidelity', accountType);
  const finalName =
    nameMode === 'custom' ? customName || '(Untitled)' : nameMode === 'default' ? techName : selectedFunName;

  function handleCsv(text: string, fileName: string) {
    setRejection(null);
    setMultiAccount(null);
    const result = importCsv(text);

    // Hard reject: the importer recognized this as a wrong-shape export
    // (e.g. Schwab balances snapshot). Don't advance.
    if (result.rejectionReason) {
      setRejection({ fileName, reason: result.rejectionReason });
      setStep('drop');
      return;
    }

    if (result.importerId === null) {
      const headers = parseCsvHeaders(text);
      if (headers.length > 0) {
        const saved = loadSavedMap(headers);
        if (saved && saved.date && saved.action) {
          // Re-import of a known shape, skip the wizard and use the saved map.
          const remembered = parseWithColumnMap(text, saved, { brokerage: customBrokerage });
          setReviewing({ fileName, csvText: text, result: remembered, importerId: null });
          setStep('review');
          return;
        }
        setMapping({ fileName, csvText: text, headers });
        setColumnMap(autoGuessMap(headers));
        setCustomBrokerage('Custom');
        setStep('map');
        return;
      }
    }

    // Multi-account export: let the user pick one (or import all) before
    // proceeding to the name/review step.
    if (result.accountsDetected && result.accountsDetected.length > 1) {
      setMultiAccount({
        fileName,
        csvText: text,
        brokerage: result.inferences.brokerage,
        importerId: result.importerId,
        accounts: result.accountsDetected,
        ...(result.marketPrices ? { marketPrices: result.marketPrices } : {}),
      });
      setStep('pickAccounts');
      return;
    }

    setReviewing({ fileName, csvText: text, result, importerId: result.importerId });
    if (result.inferences.accountType !== 'unknown') {
      setAccountType(result.inferences.accountType);
    }
    setStep('review');
  }

  /** Pick a single account out of a multi-account export and route to review. */
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
      // Carry the file-level market prices through so confirmImport can
      // persist them even when the user picks a single account out of a
      // multi-account JPM positions file.
      ...(multiAccount.marketPrices ? { marketPrices: multiAccount.marketPrices } : {}),
    };
    setReviewing({
      fileName: `${multiAccount.fileName} (${detected.name})`,
      csvText: multiAccount.csvText,
      result: subset,
      importerId: multiAccount.importerId,
      // Carry the picked account's identifying info through to the review
      // step. The canonical "<last4> <brokerage> <name>" default and the
      // upsertAccountByFingerprint dedupe both rely on accountNumber.
      detectedName: detected.name,
      accountNumber: detected.accountNumber,
    });
    if (detected.accountTypeHint !== 'unknown') setAccountType(detected.accountTypeHint);
    // Auto-name from brokerage + account type so the user can just confirm.
    const auto = `${multiAccount.brokerage} ${detected.name}`.trim();
    setCustomName(auto);
    setNameMode('custom');
    setStep('review');
  }

  /** Loop through every detected account and insert them all in one go. */
  async function importAllAccounts() {
    if (!multiAccount) return;
    setImportStatus(`Saving ${multiAccount.accounts.length} accounts…`);
    let totalInserted = 0;
    let totalSkipped = 0;
    // Snapshot existing IDs once; extend locally so multiple new accounts in
    // this batch dedupe against each other too.
    const existingIds: string[] = [];
    try {
      const existing = await listAccounts();
      for (const row of existing) existingIds.push(row.id);
    } catch {
      /* worst case we just dedupe against [] */
    }
    for (const acc of multiAccount.accounts) {
      const last4 = acc.last4 || lastFour(acc.accountNumber);
      // Build the canonical auto-name with the last4 prefix so identically
      // named accounts (e.g. two "Self-Directed" JPM accounts that only differ
      // by last4) get distinct human-readable rows. This also doubles as the
      // recovery hook for upsertAccountByFingerprint: lastFourFromName(name)
      // pulls the digit token back out so a future re-import matches the
      // existing row even though we don't persist last4 as a column.
      const autoName = [last4, multiAccount.brokerage, acc.name]
        .filter(Boolean)
        .join(' ')
        .trim();
      const desiredId = slugifyAccountId(autoName, multiAccount.brokerage, existingIds);
      // upsertAccountByFingerprint collapses re-imports of the same brokerage
      // account back onto the canonical row. For a multi-account file imported
      // twice in a row, the second pass returns the canonical IDs and the
      // rowHash dedupe inside insertTransactions skips every row.
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
    // Market prices are file-level and shared across every account in the
    // multi-account import, so we upsert them once at the end. upsertPrice is
    // idempotent in (symbol, date), so the loop is safe to re-run.
    if (multiAccount.marketPrices && multiAccount.marketPrices.length > 0) {
      for (const mp of multiAccount.marketPrices) {
        try {
          await upsertPrice(mp.symbol, mp.asOf, mp.price);
        } catch {
          /* one bad price shouldn't block the rest of the import */
        }
      }
    }
    // Best-effort logo prefetch across every ticker we just imported.
    const tickers: string[] = [];
    let earliestTxDate = new Date();
    for (const acc of multiAccount.accounts) {
      for (const t of acc.transactions) {
        if (t.symbol) tickers.push(t.symbol);
        if (t.date < earliestTxDate) earliestTxDate = t.date;
      }
    }
    if (tickers.length > 0) void prefetchLogos(tickers);

    // Backfill historical daily closes. Same rationale as the single-account
    // path: blocking here means the post-import chart shows real values.
    const backfillSymbols = filterBackfillSymbols(tickers);
    if (backfillSymbols.length > 0) {
      setImportStatus(
        `Saved ${multiAccount.accounts.length} accounts. Imported ${totalInserted} transactions, skipped ${totalSkipped} duplicates. Fetching price history…`,
      );
      try {
        await backfillHistoricalPrices(backfillSymbols, earliestTxDate);
      } catch (e) {
        console.error('[matmon] price backfill threw during import', e);
      }
    }

    setImportStatus(
      `Saved ${multiAccount.accounts.length} accounts. Imported ${totalInserted} transactions, skipped ${totalSkipped} duplicates.`,
    );
    setStep('done');
  }

  function confirmColumnMap() {
    if (!mapping) return;
    if (!columnMap.date || !columnMap.action) return;
    const fullMap: ColumnMap = {
      date: columnMap.date,
      action: columnMap.action,
      symbol: columnMap.symbol,
      quantity: columnMap.quantity,
      price: columnMap.price,
      fees: columnMap.fees,
      amount: columnMap.amount,
      notes: columnMap.notes,
    };
    const brokerage = customBrokerage.trim() || 'Custom';
    const result = parseWithColumnMap(mapping.csvText, fullMap, { brokerage });
    persistMap(mapping.headers, fullMap);
    setReviewing({
      fileName: mapping.fileName,
      csvText: mapping.csvText,
      result,
      importerId: null,
    });
    setStep('review');
  }

  function onFile(file: File) {
    file.text().then(t => handleCsv(t, file.name));
  }

  async function confirmImport() {
    if (!reviewing) return;
    setImportStatus('Saving…');
    const existingIds: string[] = [];
    try {
      const existing = await listAccounts();
      for (const row of existing) existingIds.push(row.id);
    } catch {
      /* worst case we just dedupe against [] */
    }
    const desiredId = slugifyAccountId(finalName, reviewing.result.inferences.brokerage, existingIds);
    // last4 is the canonical fingerprint we dedupe on. It comes from the
    // multi-account picker (reviewing.accountNumber) when the user drilled into
    // one specific account, otherwise from the importer's single-account
    // inference (reviewing.result.inferences.last4).
    const last4 =
      lastFour(reviewing.accountNumber) || (reviewing.result.inferences.last4 ?? '');
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
    // Persist any market prices the importer attached (e.g. JPM positions).
    // This is what lets the portfolio aggregator value the position at market
    // instead of falling back to the cost-basis price embedded in each lot's
    // synthesized transfer_in transaction.
    if (reviewing.result.marketPrices && reviewing.result.marketPrices.length > 0) {
      for (const mp of reviewing.result.marketPrices) {
        try {
          await upsertPrice(mp.symbol, mp.asOf, mp.price);
        } catch {
          /* a single bad price shouldn't block the import */
        }
      }
    }
    // Background-fetch logos for every ticker in this import. Skipped if a
    // logo for a given ticker is already cached.
    const tickers = reviewing.result.transactions.map(t => t.symbol).filter((s): s is string => Boolean(s));
    if (tickers.length > 0) void prefetchLogos(tickers);

    // Backfill historical daily closes for every symbol so the per-holding
    // chart and the portfolio NAV chart both have real mark-to-market
    // history to draw. We AWAIT so the "Reload to see it" CTA lands on a
    // populated chart instead of a flat line that fills in seconds later.
    const backfillSymbols = filterBackfillSymbols(tickers);
    if (backfillSymbols.length > 0) {
      let earliest = new Date();
      for (const t of reviewing.result.transactions) {
        if (t.date < earliest) earliest = t.date;
      }
      setImportStatus(
        `Saved ${finalName}. Imported ${counts.inserted} new, skipped ${counts.skipped} duplicates. Fetching price history…`,
      );
      try {
        await backfillHistoricalPrices(backfillSymbols, earliest);
      } catch (e) {
        console.error('[matmon] price backfill threw during import', e);
      }
    }

    setImportStatus(
      `Saved ${finalName}. Imported ${counts.inserted} new transactions, skipped ${counts.skipped} duplicates.`,
    );
    setStep('done');
  }

  return (
    <div>
      <PageHead
        title="Add an account"
        meta={
          <div>
            <div>
              Step{' '}
              {step === 'drop'
                ? '1'
                : step === 'map'
                  ? '2'
                  : step === 'pickAccounts'
                    ? '2'
                    : step === 'review'
                      ? mapping
                        ? '3'
                        : multiAccount
                          ? '3'
                          : '2'
                      : '✓'}{' '}
              of {mapping || multiAccount ? '3' : '2'}
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              {step === 'drop'
                ? 'Upload a CSV'
                : step === 'map'
                  ? 'Match the columns'
                  : step === 'pickAccounts'
                    ? 'Pick which accounts to import'
                    : step === 'review'
                      ? 'Confirm & name'
                      : 'Saved locally'}
            </div>
          </div>
        }
        actions={
          step === 'map' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep('drop')}>
                Back
              </button>
              <button
                className="btn btn-primary"
                onClick={confirmColumnMap}
                disabled={!columnMap.date || !columnMap.action}
              >
                Continue
              </button>
            </div>
          ) : step === 'review' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                onClick={() => setStep(mapping ? 'map' : multiAccount ? 'pickAccounts' : 'drop')}
              >
                Back
              </button>
              <button className="btn btn-primary" onClick={confirmImport}>
                Add {finalName}
              </button>
            </div>
          ) : null
        }
      />

      {step === 'drop' && rejection && (
        <div
          className="card"
          role="alert"
          style={{
            marginBottom: 18,
            borderColor: 'var(--accent-ink, #c33)',
            background: 'var(--accent-soft, #fdecec)',
            padding: '16px 18px',
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.06em',
              color: 'var(--accent-ink, #c33)',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Wrong export type
          </div>
          <div style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.55 }}>
            <strong>{rejection.fileName}:</strong> {rejection.reason}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              className="btn"
              onClick={() => {
                setRejection(null);
                fileInputRef.current?.click();
              }}
            >
              Try a different file
            </button>
          </div>
        </div>
      )}

      {step === 'drop' && (
        <>
          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
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
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
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
              >
                <path d="M24 30V8" />
                <path d="M14 18l10-10 10 10" />
                <path d="M8 32v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" />
              </svg>
            </div>
            <div className="dropzone-title">Drop a CSV here</div>
            <div className="dropzone-sub">
              Or click to browse. Your file is read locally and never leaves this machine.
            </div>
          </div>

          {onUseUniversalTemplate && (
            <div
              data-testid="universal-template-link"
              style={{
                marginTop: 14,
                display: 'flex',
                justifyContent: 'center',
                fontSize: 13,
                color: 'var(--ink-3)',
              }}
            >
              <button
                type="button"
                onClick={onUseUniversalTemplate}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  color: 'var(--ink-3)',
                  fontSize: 13,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textUnderlineOffset: 4,
                  fontFamily: 'inherit',
                }}
              >
                Don't see your brokerage? Use our universal template →
              </button>
            </div>
          )}

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-title-row">
              <div className="card-title">Brokerages we know · v0.1</div>
              <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                4 supported · more coming
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { name: 'Fidelity', note: 'Drag a History export.' },
                { name: 'Charles Schwab', note: 'Includes legacy TDA.' },
                { name: 'JP Morgan', note: 'Self-Directed & Wealth.' },
                { name: 'Human Interest', note: '401(k) · holdings-only OK.' },
              ].map(b => (
                <div
                  key={b.name}
                  className="brokerage-card"
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <BrokerageLogo name={b.name} />
                  <div style={{ minWidth: 0 }}>
                    <div className="brokerage-name">{b.name}</div>
                    <div className="brokerage-note">{b.note}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.55 }}>
              Don't see yours? Drop the CSV anyway, we'll fall back to the column-mapping wizard and remember
              the shape for next time.
            </div>
          </div>
        </>
      )}

      {step === 'map' && mapping && (
        <ColumnMapperStep
          mapping={mapping}
          map={columnMap}
          setMap={setColumnMap}
          brokerage={customBrokerage}
          setBrokerage={setCustomBrokerage}
        />
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
          <div className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.55 }}>
            Pick one to name it yourself, or use "Import all" to add every account with auto-generated names.
          </div>
          <div style={{ marginTop: 14 }}>
            <button
              className="btn"
              onClick={() => {
                setMultiAccount(null);
                setStep('drop');
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {step === 'review' && reviewing && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-title-row">
              <div>
                <div className="card-title">File</div>
                <div
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--ink)', marginTop: 4 }}
                >
                  {reviewing.fileName}
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', marginTop: 2 }}
                >
                  {reviewing.result.inferences.brokerage} ·{' '}
                  {Math.round(reviewing.csvText.length / 1024).toLocaleString()} KB ·{' '}
                  {reviewing.result.transactions.length} rows · read locally
                </div>
              </div>
            </div>

            <CsvPreview text={reviewing.csvText} />

            <div
              style={{
                marginTop: 14,
                padding: 12,
                background: 'var(--paper-3)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--ink-3)',
                lineHeight: 1.5,
              }}
            >
              <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>Privacy ·</span> the CSV is parsed in
              this app only. The file isn't uploaded anywhere; transactions land in your local SQLite DB.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="card">
              <div className="card-title-row">
                <div className="card-title">What we figured out</div>
                {reviewing.importerId === null && (
                  <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                    Unknown format · check columns
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 24, rowGap: 12 }}>
                <InferenceRow k="Brokerage" v={reviewing.result.inferences.brokerage} />
                <InferenceRow k="Currency" v={reviewing.result.inferences.currency} />
                <InferenceRow
                  k="Date range"
                  v={
                    reviewing.result.inferences.dateRange.start
                      ? `${formatRange(reviewing.result.inferences.dateRange.start)} to ${formatRange(reviewing.result.inferences.dateRange.end!)}`
                      : 'Unknown'
                  }
                />
                <InferenceRow k="Transactions" v={`${reviewing.result.inferences.transactionCount} parsed`} />
                <InferenceRow k="Symbols" v={`${reviewing.result.inferences.uniqueSymbols} unique`} />
                <InferenceRow
                  k="Action mapping"
                  v={`${reviewing.result.inferences.actionsMapped} mapped · ${reviewing.result.inferences.actionsUnknown} unknown`}
                />
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
                    Account type
                  </span>
                  <select
                    value={accountType}
                    onChange={e => setAccountType(e.target.value)}
                    className="settings-select compact"
                    style={{ marginTop: 4 }}
                  >
                    {ACCOUNT_TYPE_OPTIONS.map(o => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {reviewing.result.unmappedActionStrings.length > 0 && (
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
                  Unrecognized actions: {reviewing.result.unmappedActionStrings.slice(0, 5).join(', ')}
                  {reviewing.result.unmappedActionStrings.length > 5 && '…'}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-title-row">
                <div className="card-title">Name this account</div>
                <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  Technical: {techName}
                </span>
              </div>

              <input
                type="text"
                value={
                  nameMode === 'default' ? techName : nameMode === 'custom' ? customName : selectedFunName
                }
                onChange={e => {
                  setNameMode('custom');
                  setCustomName(e.target.value);
                }}
                placeholder="Type a name, or pick a suggestion below"
                className="name-input"
                style={{ marginTop: 6 }}
              />

              <div
                style={{
                  marginTop: 14,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  letterSpacing: '0.06em',
                  color: 'var(--ink-4)',
                }}
              >
                Suggestions
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {funNames.map(n => (
                  <button
                    key={n}
                    onClick={() => {
                      setSelectedFunName(n);
                      setNameMode('fun');
                    }}
                    className={`name-suggest ${nameMode === 'fun' && selectedFunName === n ? 'active' : ''}`}
                  >
                    {n}
                  </button>
                ))}
                <button
                  onClick={() => setNameMode('default')}
                  className={`name-suggest boring ${nameMode === 'default' ? 'active' : ''}`}
                  title="Use the canonical brokerage + account-type name"
                >
                  {techName}
                </button>
              </div>

              <div
                style={{
                  marginTop: 18,
                  padding: '12px 14px',
                  background: 'var(--accent-soft)',
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: 'var(--accent-ink)',
                  lineHeight: 1.5,
                }}
              >
                Got it. This <strong>{labelFor(accountType).toLowerCase()}</strong> at{' '}
                <strong>{reviewing.result.inferences.brokerage}</strong> will show up as{' '}
                <strong>"{finalName}"</strong>.
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="card" style={{ padding: '36px 32px', textAlign: 'center' }}>
          <div
            style={{ fontFamily: 'var(--font-display)', fontSize: 32, color: 'var(--ink)', marginBottom: 10 }}
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
                setStep('drop');
                setReviewing(null);
                setMapping(null);
                setColumnMap({});
                setImportStatus(null);
                setRejection(null);
                setMultiAccount(null);
              }}
            >
              Add another
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                // Prefer the in-memory reload callback so we keep the quote
                // cache warm. Fall back to a hard reload when the host didn't
                // provide one (e.g. an isolated test renders the view).
                if (onReloadPortfolio) {
                  void onReloadPortfolio();
                } else {
                  window.location.reload();
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

function labelFor(id: string): string {
  return ACCOUNT_TYPE_OPTIONS.find(o => o.id === id)?.label ?? id;
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

function formatRange(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
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

function ColumnMapperStep({
  mapping,
  map,
  setMap,
  brokerage,
  setBrokerage,
}: {
  mapping: Mapping;
  map: Partial<ColumnMap>;
  setMap: (m: Partial<ColumnMap>) => void;
  brokerage: string;
  setBrokerage: (b: string) => void;
}) {
  const samplePreview = useMemo(() => {
    if (!map.date || !map.action) return null;
    try {
      const result = parseWithColumnMap(
        mapping.csvText,
        {
          date: map.date,
          action: map.action,
          symbol: map.symbol,
          quantity: map.quantity,
          price: map.price,
          fees: map.fees,
          amount: map.amount,
          notes: map.notes,
        },
        { brokerage: brokerage.trim() || 'Custom' },
      );
      return {
        first: result.transactions[0] || null,
        count: result.transactions.length,
        unmappedActions: result.unmappedActionStrings,
      };
    } catch {
      return null;
    }
  }, [mapping.csvText, map, brokerage]);

  function updateField(key: keyof ColumnMap, value: string) {
    const next = { ...map };
    if (value === '') delete next[key];
    else next[key] = value;
    setMap(next);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      <div className="card">
        <div className="card-title-row">
          <div>
            <div className="card-title">Map your columns</div>
            <div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              {mapping.fileName} · {mapping.headers.length} headers found
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label
            className="muted"
            style={{
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Brokerage label
          </label>
          <input
            type="text"
            value={brokerage}
            onChange={e => setBrokerage(e.target.value)}
            placeholder="Custom"
            aria-label="Brokerage label"
            className="name-input"
            style={{ marginTop: 6 }}
          />
        </div>

        <div
          style={{
            marginTop: 16,
            display: 'grid',
            gridTemplateColumns: '1fr 1.4fr',
            columnGap: 12,
            rowGap: 10,
            alignItems: 'center',
          }}
        >
          {COLUMN_MAP_FIELDS.map(field => {
            const selectId = `col-map-${field.key}`;
            return (
              <FieldRow
                key={field.key}
                id={selectId}
                field={field}
                value={map[field.key] || ''}
                onChange={v => updateField(field.key, v)}
                headers={mapping.headers}
              />
            );
          })}
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 10,
            background: 'var(--paper-3)',
            borderRadius: 8,
            fontSize: 11.5,
            color: 'var(--ink-3)',
            lineHeight: 1.5,
          }}
        >
          Fields with an asterisk are required. We remember the mapping for any CSV that has the same headers,
          so you only do this once per file shape.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-title-row">
            <div className="card-title">CSV preview</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              First 5 rows
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            <CsvPreview text={mapping.csvText} />
          </div>
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">What this would produce</div>
            {samplePreview && (
              <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {samplePreview.count} transactions
              </span>
            )}
          </div>
          {!map.date || !map.action ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
              Pick a column for both <strong>Date</strong> and <strong>Action</strong> to see a sample.
            </div>
          ) : !samplePreview || !samplePreview.first ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
              No rows could be parsed with the current map. Try a different Action column, or check that the
              values look like buy/sell/dividend.
            </div>
          ) : (
            <div
              style={{
                marginTop: 12,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                columnGap: 18,
                rowGap: 10,
              }}
            >
              <PreviewRow k="Date" v={samplePreview.first.date.toLocaleDateString('en-US')} />
              <PreviewRow k="Action" v={samplePreview.first.action} />
              <PreviewRow k="Symbol" v={samplePreview.first.symbol || '(none)'} />
              <PreviewRow k="Quantity" v={String(samplePreview.first.quantity)} />
              <PreviewRow k="Price" v={String(samplePreview.first.price)} />
              <PreviewRow
                k="Amount"
                v={samplePreview.first.amount === null ? '(none)' : String(samplePreview.first.amount)}
              />
            </div>
          )}
          {samplePreview && samplePreview.unmappedActions.length > 0 && (
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
              Unrecognized actions: {samplePreview.unmappedActions.slice(0, 5).join(', ')}
              {samplePreview.unmappedActions.length > 5 && '…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  id,
  field,
  value,
  onChange,
  headers,
}: {
  id: string;
  field: ColumnMapField;
  value: string;
  onChange: (v: string) => void;
  headers: string[];
}) {
  return (
    <>
      <label
        htmlFor={id}
        style={{
          fontSize: 13,
          color: 'var(--ink)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {field.label}
        {field.required && <span style={{ color: 'var(--accent-ink, #c33)' }}>*</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="settings-select compact"
        aria-label={`${field.label} column`}
      >
        <option value="">(none)</option>
        {headers.map(h => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </>
  );
}

function PreviewRow({ k, v }: { k: string; v: string }) {
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
  // Use Papa.parse so quoted cells containing commas (e.g. "APPLE INC, CL A")
  // render correctly. The old naive text.split(',') broke any row with a
  // quoted comma-bearing field and produced misaligned preview cells.
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
        … {Math.max(0, totalLines - 7)} more rows
      </div>
    </div>
  );
}
