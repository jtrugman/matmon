// Fidelity History export
// Header style: "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),..."
// Multi-account exports add "Account" and "Account Number" columns.
// Action examples: "YOU BOUGHT", "YOU SOLD", "DIVIDEND RECEIVED", "REINVESTMENT",
//                  "Electronic Funds Transfer Received", "DISTRIBUTION VANGUARD..."
//
// Matmon ONLY accepts the multi-account export. Single-account exports omit
// the Account Number column entirely, which breaks the dedup fingerprint we
// use to keep accounts organized across re-imports. See
// `detectSingleAccountFidelityRejection` below for the rejection path.

import type {
  AccountTypeId,
  BrokerageImporter,
  DetectedAccount,
  ImporterResult,
  ParsedTransaction,
} from './types';
import { INTERNAL_TRANSFER_TAG } from '../performance';
import { mapAction, parseDate, parseNumber, rowHash } from './util';

/**
 * User-facing rejection message for the single-account Fidelity export case.
 * The numbered steps walk the user through Fidelity's UI to download the
 * correct multi-account export.
 *
 * Mirrors the Schwab balances-export rejection pattern in `./index.ts`. The
 * UI surfaces this string verbatim via `ImporterResult.rejectionReason`.
 */
export const FIDELITY_SINGLE_ACCOUNT_REJECTION_MESSAGE =
  'This looks like a single-account Fidelity export. Matmon needs the ' +
  'multi-account export instead. It includes the account number we need ' +
  'to keep your accounts organized.\n\n' +
  'To get the right export in Fidelity:\n' +
  '1. Click your name in the top-right\n' +
  '2. Select Accounts & Trade, then Activity & Orders\n' +
  '3. Choose "All Accounts" from the account dropdown\n' +
  '4. Click Download';

/** Machine-readable rejection tag for the single-account Fidelity case. */
export const FIDELITY_SINGLE_ACCOUNT_REJECTION_KIND = 'wrong-fidelity-export';

/**
 * Returns true when the parsed CSV looks like a Fidelity transaction history
 * export but omits the Account Number column AND has no per-row Account
 * values. Callers should already have determined the file fingerprints as a
 * Fidelity export (e.g. via `fidelityImporter.matches`) before consulting
 * this helper.
 *
 * The check is intentionally strict: the file must have NO `Account`,
 * `Account Name`, or `Account Number` column AND no per-row Account value
 * across ALL rows. Files that ship the multi-account columns (even with a
 * single row) pass through to the normal parse path.
 */
export function detectSingleAccountFidelityRejection(
  headers: string[],
  rows: Record<string, string>[],
): boolean {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  // Multi-account exports always carry one of these column names. If any is
  // present in the header row, the file is the multi-account shape (even
  // when the column is empty on some rows).
  const hasAccountColumn =
    lowerHeaders.includes('account') ||
    lowerHeaders.includes('account name') ||
    lowerHeaders.includes('account number') ||
    lowerHeaders.includes('account #');
  if (hasAccountColumn) return false;

  // Belt-and-suspenders: scan the parsed rows for any populated Account /
  // Account Name / Account Number cell. Papa-folded malformed exports
  // occasionally hide the account string in a non-canonical column (e.g.
  // when a stray header row collapses field names). If any row carries a
  // non-empty value under one of these labels, treat the file as
  // multi-account-shaped and let the normal parser handle it.
  for (const row of rows) {
    const accountName = (row['Account'] || row['Account Name'] || '').trim();
    const accountNumber = (row['Account Number'] || row['Account #'] || '').trim();
    if (accountName || accountNumber) return false;
  }

  // Header omits Account columns AND no row carries an Account value:
  // this is the single-account export shape. Reject.
  return true;
}

/** Heuristic mapping from Fidelity account-name strings to matmon account types. */
function guessAccountType(accountName: string): AccountTypeId | 'unknown' {
  const n = accountName.toLowerCase();
  if (/health savings|\bhsa\b/.test(n)) return 'hsa';
  if (/roth/.test(n)) return 'roth_ira';
  if (/traditional ira|\btrad ira\b|rollover ira|\bira\b/.test(n)) return 'trad_ira';
  if (/401\s?\(?k\)?|403\s?\(?b\)?/.test(n)) return '401k';
  if (/individual|brokerage|joint|taxable|cma|cash management/.test(n)) return 'taxable';
  return 'unknown';
}

function parseRow(row: Record<string, string>): {
  tx: ParsedTransaction | null;
  actionStr: string;
  mapped: boolean;
} {
  const runDate = row['Run Date'] || row['Trade Date'] || row['Settlement Date'] || row['Date'];
  const actionStr = row['Action'] || row['Type'] || '';

  // Fidelity often emits a literal " " (single space) for cash-only rows; treat
  // any symbol that trims to empty as null so it doesn't pollute symbol lists.
  const symbol = (row['Symbol'] || '').trim() || null;
  const quantity = parseNumber(row['Quantity']);
  let price = parseNumber(row['Price ($)'] || row['Price']);
  const fees = parseNumber(row['Commission ($)'] || row['Fees ($)'] || row['Fees']);
  const amount = parseNumber(row['Amount ($)'] || row['Amount'] || '0');

  let action = mapAction(actionStr);
  if (!action) {
    // Defensive recovery path: a row with a BLANK Action cell, no Symbol, and
    // a non-zero Amount is almost certainly a cash movement (deposit /
    // withdrawal) Fidelity emitted with a missing Action label. Inferring
    // cash_in / cash_out from the amount sign keeps the cash flow visible to
    // XIRR and the Accounts "money in" rollup; without this fallback the row
    // would be dropped entirely and the user's "I deposited $X" would silently
    // vanish.
    //
    // We only recover when actionStr is truly empty (after trimming). A row
    // with an UNKNOWN-but-non-empty action string still hits the original
    // unmapped path so the user sees the unmapped-string warning instead of
    // a silently re-categorized cash movement. That distinction matters: if
    // Fidelity ships a new "Tax Withholding" action with no symbol attached,
    // we want to surface it as unmapped rather than mis-bucket it as cash_out.
    if (!actionStr.trim() && !symbol && amount !== 0) {
      action = amount > 0 ? 'cash_in' : 'cash_out';
    } else {
      return { tx: null, actionStr, mapped: false };
    }
  }
  const date = parseDate(runDate);
  if (isNaN(+date)) return { tx: null, actionStr, mapped: true };

  // ── Defensive guard: never tag a no-symbol row as `buy` ────────────────
  // Fidelity action descriptions like "YOU BOUGHT" are normally only used on
  // rows with a real symbol. But the action mapper has a permissive
  // /you bought|buy|purchase|bought|sweep in/i rule, so a future Fidelity
  // export variant whose Action column happens to contain the substring "buy"
  // (e.g. some new "buy-back" or "buyout" cash-only event) could spill into
  // the buy bucket with no symbol attached. That breaks the holdings replay
  // in portfolio.ts (which expects buys to have a symbol + qty + price) and
  // pollutes the Transactions table with phantom positions.
  //
  // When we'd otherwise emit a buy with no symbol, re-categorize as a cash
  // movement based on the Amount sign. Positive amount means money came in
  // (cash_in); negative means money left (cash_out). This is purely a sanity
  // backstop; the primary path is still the ACTION_MAP regex in util.ts.
  if (action === 'buy' && !symbol) {
    action = amount >= 0 ? 'cash_in' : 'cash_out';
  }

  // ── Fidelity share-distribution detection ─────────────────────────────
  // Action description "DISTRIBUTION <NAME> (TICKER) (Cash)" with Type=Shares
  // is a fund capital-gains distribution PAID AS ADDITIONAL SHARES. The
  // mapper turns "DISTRIBUTION" into the generic `dividend` action, which
  // (correctly for cash distributions) does NOT add to qty/cost. But when
  // the Type column says "Shares" and we see a real Quantity + Amount + no
  // explicit Price, the distribution increased the holder's share count and
  // the cost basis equals the distributed Amount.
  //
  // We re-tag these as `transfer_in` (NOT `div_reinvest`) because:
  //   1. The user did NOT receive cash; they received shares whose cost basis
  //      equals the distribution amount.
  //   2. Counting this as a dividend would falsely fire the $100/$1,000
  //      dividends-earned milestones for users who never received a cash
  //      dividend that large. Lifetime-dividend rollups would also report a
  //      wildly inflated total.
  //   3. The downstream portfolio.ts holdings replay treats `transfer_in` as
  //      "add to qty + cost basis" identically to `buy` and `div_reinvest`,
  //      so the position math is unchanged.
  //
  // The opposite case (Type=Cash distribution, qty=0) keeps the `dividend`
  // tag and contributes nothing to qty/cost, which is the right behavior
  // for an unreinvested cash distribution.
  const typeCol = (row['Type'] || '').trim().toLowerCase();
  let internalDistribution = false;
  if (
    action === 'dividend' &&
    /distribution/i.test(actionStr) &&
    typeCol === 'shares' &&
    symbol &&
    Math.abs(quantity) > 0 &&
    Math.abs(amount) > 0
  ) {
    action = 'transfer_in';
    internalDistribution = true;
    // Implicit per-share price: cost basis of the distribution / shares
    // received. The Price column is blank on these rows in Fidelity's export.
    if (!price || price === 0) {
      price = Math.abs(amount) / Math.abs(quantity);
    }
  }

  // Notes carry the brokerage's "Description" for display, plus an XIRR-only
  // sentinel for the internal-distribution case so flowsFromTransactions can
  // recognize this row as a fund-internal share gain (no external money
  // crossed the portfolio boundary) and EXCLUDE it from cash flows. Without
  // the sentinel, the +$7,808 distribution-as-transfer_in for a leveraged
  // VGT split-distribution would otherwise be counted as a real ACAT
  // transfer and crash the all-time XIRR into deeply-negative territory.
  const baseNotes = row['Description'] || '';
  const notes = internalDistribution
    ? (baseNotes ? `${baseNotes} ` : '') + INTERNAL_TRANSFER_TAG
    : baseNotes;

  return {
    tx: {
      date,
      symbol,
      action,
      quantity: Math.abs(quantity),
      price,
      fees: Math.abs(fees),
      amount,
      currency: 'USD',
      notes,
      rawHash: rowHash([runDate, actionStr, symbol, quantity, price, row['Account Number'] || '']),
    },
    actionStr,
    mapped: true,
  };
}

export const fidelityImporter: BrokerageImporter = {
  id: 'fidelity',
  displayName: 'Fidelity',
  capability: 'transactions',
  matches(headers, _firstRow) {
    const h = headers.map(x => x.toLowerCase());
    const hasRunDate = h.includes('run date');
    const hasAction = h.includes('action');
    const hasSymbol = h.includes('symbol');
    // Fidelity exports also include "Account" or "Account Name" and "Settlement Date"
    const fidSignal = h.some(x => x.includes('settlement date')) || h.some(x => x.includes('amount ($)'));
    return (hasRunDate && hasAction && hasSymbol) || (hasAction && hasSymbol && fidSignal);
  },
  parse(rows): ImporterResult {
    const txs: ParsedTransaction[] = [];
    const unmapped = new Set<string>();
    const symbols = new Set<string>();
    const warnings: string[] = [];
    let actionsMapped = 0;
    let actionsUnknown = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    // Multi-account bucket: keyed by "${Account}::${Account Number}".
    const accountBuckets = new Map<
      string,
      { name: string; accountNumber: string; transactions: ParsedTransaction[] }
    >();
    let sawAccountColumn = false;

    for (const row of rows) {
      const accountName = (row['Account'] || row['Account Name'] || '').trim();
      const accountNumber = (row['Account Number'] || '').trim();
      if (accountName || accountNumber) sawAccountColumn = true;

      const { tx, actionStr, mapped } = parseRow(row);
      if (!mapped) {
        if (actionStr.trim()) {
          unmapped.add(actionStr.trim());
          actionsUnknown++;
        }
        continue;
      }
      if (!tx) continue;
      actionsMapped++;

      if (tx.symbol) symbols.add(tx.symbol);
      if (!minDate || tx.date < minDate) minDate = tx.date;
      if (!maxDate || tx.date > maxDate) maxDate = tx.date;
      txs.push(tx);

      if (accountName || accountNumber) {
        const key = `${accountName}::${accountNumber}`;
        let bucket = accountBuckets.get(key);
        if (!bucket) {
          bucket = { name: accountName || '(Unnamed account)', accountNumber, transactions: [] };
          accountBuckets.set(key, bucket);
        }
        bucket.transactions.push(tx);
      }
    }

    // Only emit accountsDetected when the file actually has multiple distinct accounts.
    let accountsDetected: DetectedAccount[] | undefined;
    if (sawAccountColumn && accountBuckets.size >= 2) {
      accountsDetected = Array.from(accountBuckets.entries()).map(([key, bucket]) => ({
        key,
        name: bucket.name,
        accountNumber: bucket.accountNumber,
        last4: lastFourOf(bucket.accountNumber),
        accountTypeHint: guessAccountType(bucket.name),
        transactions: bucket.transactions,
      }));
    }

    // Single-account uploads still benefit from carrying the detected account
    // number forward so upsertAccountByFingerprint can dedupe re-imports.
    // Pick the dominant account-number string (the bucket with the most
    // transactions). For files with no Account Number column at all (older
    // Fidelity exports) both fields stay empty and the upsert falls back to
    // matching by (brokerage, name).
    let inferAccountNumber = '';
    if (sawAccountColumn && accountBuckets.size === 1) {
      const only = Array.from(accountBuckets.values())[0];
      inferAccountNumber = only.accountNumber || '';
    } else if (sawAccountColumn && accountBuckets.size >= 2) {
      // Multi-account file: we still emit accountsDetected above, so the
      // single-account inference fields stay empty (the picker / per-account
      // path uses the DetectedAccount.last4 instead). We deliberately leave
      // inferAccountNumber as its initial empty string here.
    } else {
      // No "Account" / "Account Number" column was found anywhere in the rows.
      // Fidelity's "single-account" History export uses this shape and OMITS
      // the account number from every row, so the canonical (Account, Account
      // Number) signal is unavailable.
      //
      // We still try one last fallback: scrape all parsed row keys + values
      // for anything that looks like a Fidelity account-number literal. When
      // a malformed export ships the account number as a stray header row
      // above the data table ("Brokerage Account Number Z0XXXXXXXX"), Papa
      // folds that line into the field-name list or into a __parsed_extra
      // column on every row. scrapeAccountNumber() finds those cases.
      //
      // KNOWN LIMITATION: when Fidelity's single-account export does NOT carry
      // the account number anywhere (the common case as of 2026-05), this
      // scrape returns empty and last4 stays unset. The upstream upsert then
      // falls back to (brokerage, name) matching, which is correct but means a
      // user who imports both the single-account file AND the multi-account
      // file gets two rows for the same brokerage account unless they pick
      // matching display names. We surface a warning so the UI can prompt the
      // user to either rename the account during import or skip the duplicate.
      inferAccountNumber = scrapeAccountNumber(rows);
      if (!inferAccountNumber && txs.length > 0) {
        warnings.push(
          'Fidelity single-account export omits the account number; the importer ' +
            'could not extract a last-4 fingerprint. If you also import the ' +
            'multi-account export later, name this account to match (using the ' +
            'last 4 digits from the brokerage statement) so dedupe collapses ' +
            'both files onto one account row.',
        );
      }
    }

    return {
      inferences: {
        brokerage: 'Fidelity',
        accountType: 'unknown',
        currency: 'USD',
        dateRange: { start: minDate, end: maxDate },
        transactionCount: txs.length,
        uniqueSymbols: symbols.size,
        actionsMapped,
        actionsUnknown,
        accountNumber: inferAccountNumber,
        last4: lastFourOf(inferAccountNumber),
      },
      transactions: txs,
      unmappedActionStrings: Array.from(unmapped),
      ...(accountsDetected ? { accountsDetected } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

/**
 * Best-effort scan of parsed-row keys and values for a Fidelity-shaped account
 * number. Used as a last-resort fallback for export variants that don't ship
 * the canonical "Account Number" column. We look for:
 *
 *   - a leading capital letter followed by 7-9 digits (Fidelity brokerage shape)
 *   - a string of 8-10 digits standing alone (Fidelity HSA shape)
 *   - the literal phrase "Account Number <id>" anywhere in a row
 *
 * Returns the first plausible match. Rejects obvious false positives like
 * dates (10/2026 etc.) and dollar amounts by requiring the candidate to be
 * surrounded by word boundaries and to not contain a slash or decimal point.
 *
 * For the May-2026 Fidelity single-account History export, this scrape returns
 * the empty string (the file genuinely has no account number embedded), and
 * the importer surfaces a warning telling the user about the limitation.
 */
function scrapeAccountNumber(rows: Record<string, string>[]): string {
  // Letter-prefixed alphanumeric (Fidelity brokerage account shape) or pure-
  // digit 8-10 char run (Fidelity HSA shape). We require word boundaries so
  // we don't pick up middle chunks of CUSIPs (9 chars but alphanumeric: e.g.
  // "037833100" is Apple's CUSIP and would otherwise match the digit branch).
  // To distinguish: if the rest of the cell is a known brokerage-account
  // label, accept; else reject any pure-digit run that appears alongside
  // obviously-CUSIP context (a Symbol/Ticker column on the same row).
  const ACCT_LETTER = /\b([A-Z]\d{7,9})\b/;
  const ACCT_LABEL = /account\s*(?:number|#)\s*[:-]?\s*([A-Z0-9]{6,12})/i;

  for (const row of rows) {
    // First sweep: explicit "Account Number <id>" / "Account #: <id>" labels.
    for (const v of Object.values(row)) {
      const s = typeof v === 'string' ? v : '';
      const m = s.match(ACCT_LABEL);
      if (m && m[1]) return m[1].toUpperCase();
    }
    // Also scan the KEYS of the row: when Papa folds a stray "Brokerage
    // Account Number <id>" header row into the field-name list, the
    // candidate hides in the key set instead of the values.
    for (const k of Object.keys(row)) {
      const m = k.match(ACCT_LABEL);
      if (m && m[1]) return m[1].toUpperCase();
      const mLetter = k.match(ACCT_LETTER);
      if (mLetter && mLetter[1]) return mLetter[1].toUpperCase();
    }
    // Second sweep: letter-prefixed alphanumeric anywhere in a value. We do
    // this in a second pass so explicit labels win over loose pattern matches.
    for (const v of Object.values(row)) {
      const s = typeof v === 'string' ? v : '';
      // Skip anything that looks like a date or money amount.
      if (/[/$,.]/.test(s)) continue;
      const m = s.match(ACCT_LETTER);
      if (m && m[1]) return m[1].toUpperCase();
    }
  }
  return '';
}

/**
 * Pull the trailing 4-digit window from a brokerage account number that may
 * arrive as "...2180", "XXXX1234", or a plain integer. Returns the empty
 * string when the input has fewer than 4 digits or is missing.
 */
function lastFourOf(accountNumber: string | undefined): string {
  if (!accountNumber) return '';
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}
