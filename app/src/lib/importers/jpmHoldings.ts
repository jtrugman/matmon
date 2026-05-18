// JP Morgan Self-Directed POSITIONS export (lots view). This is the "holdings-only"
// flavor of JPM where the file lists current tax lots (one row per lot) instead of
// a transaction history. Most JPM Self-Directed users only have access to this
// export, so we synthesize transfer_in transactions per lot using the lot's
// acquisition date and unit-cost as cost basis, which lets us reconstruct an
// approximation of the portfolio without true transaction history.
//
// Header style (70+ columns; only a subset is used):
//   "Account name,Account number,Account type,Sub account,...,Description,Ticker,
//    CUSIP,Quantity,...,Price,...,Cost,...,Acquisition Date,...,Unit Cost,...,Acct Type"
//
// The file ends with a FOOTNOTES section: a row literally containing "FOOTNOTES"
// in the first column, followed by single-letter rows like A, C, P, W, X with a
// prose explanation in column 2. We skip every row that doesn't have a Ticker
// (the cleanest, header-agnostic way to filter those footnote rows out).

import type {
  AccountTypeId,
  BrokerageImporter,
  DetectedAccount,
  ImporterResult,
  ParsedTransaction,
} from './types';
import { parseDate, parseNumber, rowHash } from './util';

/**
 * Heuristic mapping from JPM Self-Directed account-name strings to matmon account
 * types. The "-Ret" suffix on Self-Directed-Ret indicates a retirement account;
 * JPM doesn't distinguish traditional vs Roth in this column, so we default to
 * trad_ira and let the user correct it during the import flow if needed.
 */
function guessAccountType(accountName: string, acctType: string): AccountTypeId | 'unknown' {
  const n = accountName.toLowerCase();
  const t = (acctType || '').toLowerCase();
  if (/roth/.test(n)) return 'roth_ira';
  // "-Ret" suffix is JPM's marker for a retirement account. Default to trad_ira;
  // user can refine to roth_ira during account setup if applicable.
  if (/-ret\b|retirement|\bira\b/.test(n)) return 'trad_ira';
  if (/401\s?\(?k\)?|403\s?\(?b\)?/.test(n)) return '401k';
  if (/health savings|\bhsa\b/.test(n)) return 'hsa';
  if (/self-directed|brokerage|individual|joint|taxable/.test(n) || /brokerage/.test(t)) {
    return 'taxable';
  }
  return 'unknown';
}

/**
 * A row is treated as a footnote (and skipped) if it has no Ticker. JPM's
 * FOOTNOTES section uses single-letter labels in the first column with prose
 * in the second; those rows have no Ticker, so this filter catches them without
 * us having to special-case "FOOTNOTES" or every individual footnote label.
 */
function isDataRow(row: Record<string, string>): boolean {
  const accountName = (row['Account name'] || '').trim();
  if (!accountName) return false;
  if (accountName.toUpperCase() === 'FOOTNOTES') return false;
  const ticker = (row['Ticker'] || '').trim();
  if (!ticker) return false;
  return true;
}

export const jpmHoldingsImporter: BrokerageImporter = {
  id: 'jpmHoldings',
  displayName: 'JP Morgan',
  capability: 'holdings-only',
  matches(headers) {
    const set = new Set(headers.map(x => x.trim()));
    // CUSIP + Acquisition Date + Unit Cost is the JPM-positions fingerprint; no
    // other importer in the registry has all three together with Account name.
    return (
      set.has('Account name') &&
      set.has('Account number') &&
      set.has('Ticker') &&
      set.has('CUSIP') &&
      set.has('Acquisition Date') &&
      set.has('Quantity') &&
      set.has('Unit Cost')
    );
  },
  parse(rows): ImporterResult {
    const txs: ParsedTransaction[] = [];
    const symbols = new Set<string>();
    const today = new Date();
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    // Track the most-recent (by Pricing Date) market price seen per ticker. The
    // JPM positions export repeats the same Price + Pricing Date on every lot
    // for a given symbol, but we still pick the newest just in case different
    // lot rows disagree (e.g. multi-day exports). One entry per unique ticker
    // is what downstream consumers want.
    const marketPriceBySymbol = new Map<string, { price: number; asOf: Date }>();

    // Multi-account bucket: keyed by "${Account name}::${Account number}".
    const accountBuckets = new Map<
      string,
      {
        name: string;
        accountNumber: string;
        acctType: string;
        transactions: ParsedTransaction[];
      }
    >();

    for (const row of rows) {
      if (!isDataRow(row)) continue;

      const accountName = (row['Account name'] || '').trim();
      const accountNumber = (row['Account number'] || '').trim();
      const acctType = (row['Acct Type'] || row['Account type'] || '').trim();
      const ticker = (row['Ticker'] || '').trim().toUpperCase();
      const description = (row['Description'] || '').trim();
      const acquisitionDateStr = (row['Acquisition Date'] || '').trim();

      const quantity = Math.abs(parseNumber(row['Quantity']));
      const unitCost = parseNumber(row['Unit Cost']);

      // Skip zero-quantity rows; they're not lots we can model as transfer_in.
      if (quantity <= 0) continue;

      // Acquisition Date can be empty on cash sweeps and average-cost lots that
      // JPM didn't tag with a buy date. Fall back to "today" so the position
      // still shows up; the user can correct the date during import review.
      let date: Date;
      if (acquisitionDateStr) {
        const parsed = parseDate(acquisitionDateStr);
        date = isNaN(+parsed) ? today : parsed;
      } else {
        date = today;
      }

      symbols.add(ticker);
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      // Capture the current market price for this symbol. JPM exports the live
      // mark in the "Price" column and the timestamp in "Pricing Date" (which
      // is usually "MM/DD/YYYY HH:MM:SS"). We keep the newest entry per symbol
      // so the portfolio layer can value the position at market, not at cost.
      const marketPrice = parseNumber(row['Price']);
      if (marketPrice > 0) {
        const pricingDateStr = (row['Pricing Date'] || '').trim();
        // parseDate handles "MM/DD/YYYY ..." (it stops at the slash separator).
        // If unparseable, fall back to "today" so we still get a usable entry.
        let asOf: Date;
        if (pricingDateStr) {
          const parsed = parseDate(pricingDateStr);
          asOf = isNaN(+parsed) ? today : parsed;
        } else {
          asOf = today;
        }
        const existing = marketPriceBySymbol.get(ticker);
        if (!existing || asOf >= existing.asOf) {
          marketPriceBySymbol.set(ticker, { price: marketPrice, asOf });
        }
      }

      const tx: ParsedTransaction = {
        date,
        symbol: ticker,
        action: 'transfer_in',
        quantity,
        // Use the lot's Unit Cost (original cost basis per share) rather than
        // the current Price column, so reconstructed cost basis matches reality.
        price: unitCost,
        fees: 0,
        // Money out of pocket at acquisition (negative cash flow).
        amount: -(quantity * unitCost),
        currency: 'USD',
        notes: description ? `${description} (lot import)` : 'JP Morgan position lot import',
        rawHash: rowHash([accountNumber, ticker, acquisitionDateStr, quantity, unitCost]),
      };
      txs.push(tx);

      const key = `${accountName}::${accountNumber}`;
      let bucket = accountBuckets.get(key);
      if (!bucket) {
        bucket = {
          name: accountName || '(Unnamed account)',
          accountNumber,
          acctType,
          transactions: [],
        };
        accountBuckets.set(key, bucket);
      }
      bucket.transactions.push(tx);
    }

    let accountsDetected: DetectedAccount[] | undefined;
    if (accountBuckets.size >= 2) {
      accountsDetected = Array.from(accountBuckets.entries()).map(([key, bucket]) => ({
        key,
        name: bucket.name,
        accountNumber: bucket.accountNumber,
        last4: lastFourOf(bucket.accountNumber),
        accountTypeHint: guessAccountType(bucket.name, bucket.acctType),
        transactions: bucket.transactions,
      }));
    }

    // Single-account files still report a sensible accountType inference and
    // also carry the detected account number through so upsertAccountByFingerprint
    // can dedupe re-imports of the same single-account positions file.
    let inferredType: AccountTypeId | 'unknown' = 'unknown';
    let inferAccountNumber = '';
    if (accountBuckets.size === 1) {
      const only = Array.from(accountBuckets.values())[0];
      inferredType = guessAccountType(only.name, only.acctType);
      inferAccountNumber = only.accountNumber || '';
    }

    const marketPrices = Array.from(marketPriceBySymbol.entries()).map(([symbol, v]) => ({
      symbol,
      price: v.price,
      asOf: v.asOf,
    }));

    return {
      inferences: {
        brokerage: 'JP Morgan',
        accountType: inferredType,
        currency: 'USD',
        dateRange: { start: minDate, end: maxDate },
        transactionCount: txs.length,
        uniqueSymbols: symbols.size,
        actionsMapped: txs.length,
        actionsUnknown: 0,
        accountNumber: inferAccountNumber,
        last4: lastFourOf(inferAccountNumber),
      },
      transactions: txs,
      unmappedActionStrings: [],
      ...(accountsDetected ? { accountsDetected } : {}),
      ...(marketPrices.length > 0 ? { marketPrices } : {}),
    };
  },
};

/**
 * Trailing 4-digit window of an account number (e.g. "XXXX1234" -> "1234").
 * Returns the empty string when the input has fewer than 4 digits or is missing.
 */
function lastFourOf(accountNumber: string | undefined): string {
  if (!accountNumber) return '';
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}
