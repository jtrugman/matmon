// Matmon Universal CSV, the fallback template for brokerages without a
// native importer. Users download `public/matmon-template.csv`, fill it in
// by hand (Human Interest 401(k) is the canonical use case), and re-upload.
//
// Header signature (case-insensitive, comma-separated):
//   Date, Action, Symbol, Description, Quantity, Price, Amount, Fees,
//   Account, Brokerage, Account Type, Currency, Notes
//
// Action allow-list (strict; unknown rows warn + skip rather than guess):
//   buy, sell, dividend, interest, div_reinvest, cash_in, cash_out,
//   contribution, withdrawal, transfer_in, transfer_out, fee
//
// The template surface uses friendly names (e.g. contribution, withdrawal,
// trad_401k) that map to the smaller internal allow-list (cash_in, cash_out,
// 401k) before persistence. That way the spreadsheet a non-technical user
// fills in stays self-explanatory while the storage layer keeps its existing
// Action and AccountTypeId enums.
//
// Multi-account grouping: rows are bucketed by (Brokerage, Account). If two
// or more buckets exist, accountsDetected is emitted so the onboarding/picker
// flow splits the file into one upload per account.
//
// rowHash mixes (Date, Action, Symbol, Quantity, Price, Account, Brokerage)
// so two different accounts in the same file can carry identical-looking
// rows without colliding.
import type {
  Action,
  AccountTypeId,
  BrokerageImporter,
  DetectedAccount,
  ImporterResult,
  ParsedTransaction,
} from './types';
import { parseDate, parseNumber, rowHash } from './util';

/**
 * The universal template accepts a broader, friendlier action vocabulary than
 * the internal Action enum. The mapping normalizes the user-typed value:
 *   contribution -> cash_in
 *   withdrawal   -> cash_out
 * Everything else is a 1:1 passthrough that we still validate against the
 * allow-list so typos like "purchase" or "div" warn + skip.
 */
const UNIVERSAL_ACTION_MAP: Record<string, Action> = {
  buy: 'buy',
  sell: 'sell',
  dividend: 'dividend',
  interest: 'interest',
  div_reinvest: 'div_reinvest',
  cash_in: 'cash_in',
  cash_out: 'cash_out',
  contribution: 'cash_in',
  withdrawal: 'cash_out',
  transfer_in: 'transfer_in',
  transfer_out: 'transfer_out',
  fee: 'fee',
};

/**
 * Template surface for account types. Users see and type these in the
 * spreadsheet. We normalize them down to the internal AccountTypeId enum
 * before insertion so existing storage and reporting paths keep working
 * unchanged. trad_401k and roth_401k both fold into 401k since the storage
 * layer doesn't distinguish them today; the Notes column is the right place
 * for that nuance until the schema grows.
 */
const ACCOUNT_TYPE_MAP: Record<string, AccountTypeId> = {
  taxable: 'taxable',
  brokerage: 'taxable',
  trad_ira: 'trad_ira',
  roth_ira: 'roth_ira',
  trad_401k: '401k',
  roth_401k: '401k',
  '401k': '401k',
  hsa: 'hsa',
  '529': 'other',
  other: 'other',
};

function normalizeAction(raw: string): Action | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return UNIVERSAL_ACTION_MAP[key] ?? null;
}

function normalizeAccountType(raw: string): AccountTypeId | 'unknown' {
  if (!raw) return 'unknown';
  const key = raw.trim().toLowerCase();
  if (!key) return 'unknown';
  return ACCOUNT_TYPE_MAP[key] ?? 'unknown';
}

/**
 * Pull the trailing 4-digit window from a freeform Account string. The
 * template doesn't require account numbers, but if a user happens to type
 * "Roth IRA 1234" we keep the digits as a fingerprint for dedupe on re-import.
 */
function lastFourFrom(account: string): string {
  if (!account) return '';
  const digits = account.replace(/\D/g, '');
  return digits.slice(-4);
}

/**
 * The matches() check is strict on the required column set so we don't claim
 * a file the column-mapping wizard or another importer should handle. We
 * require the columns that uniquely identify the universal template; the
 * other columns (quantity, price, fees, currency, notes, description) are
 * optional from the parser's point of view.
 */
const REQUIRED_HEADERS = ['date', 'action', 'symbol', 'amount', 'account', 'brokerage'];

export const matmonUniversalImporter: BrokerageImporter = {
  id: 'matmonUniversal',
  displayName: 'Matmon Universal',
  capability: 'transactions',
  matches(headers) {
    const headerSet = new Set(headers.map(h => h.toLowerCase().trim()));
    return REQUIRED_HEADERS.every(r => headerSet.has(r));
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

    type Bucket = {
      name: string;
      brokerage: string;
      accountNumber: string;
      accountTypeHint: AccountTypeId | 'unknown';
      transactions: ParsedTransaction[];
    };
    const accountBuckets = new Map<string, Bucket>();

    // Track which brokerage label is dominant so the single-account inference
    // surfaces something useful. The template lets a single file carry rows
    // from multiple brokerages (e.g. a user typing in two manual accounts
    // before they switch to a real importer); we pick whichever brokerage
    // has the most rows for the top-level "brokerage" inference.
    const brokerageCounts = new Map<string, number>();

    rows.forEach((row, rowIndex) => {
      const dateStr = row['Date'] || row['date'] || '';
      const actionStr = row['Action'] || row['action'] || '';
      const symbol = (row['Symbol'] || row['symbol'] || '').trim().toUpperCase() || null;
      const description = row['Description'] || row['description'] || '';
      const quantityStr = row['Quantity'] || row['quantity'] || '';
      const priceStr = row['Price'] || row['price'] || '';
      const amountStr = row['Amount'] || row['amount'] || '';
      const feesStr = row['Fees'] || row['fees'] || '';
      const accountName = (row['Account'] || row['account'] || '').trim();
      const brokerage = (row['Brokerage'] || row['brokerage'] || '').trim() || 'Custom';
      const accountTypeRaw = (row['Account Type'] || row['account type'] || '').trim();
      const currency = (row['Currency'] || row['currency'] || '').trim().toUpperCase() || 'USD';
      const notes = row['Notes'] || row['notes'] || description || '';

      // Skip wholly blank lines silently (Papa already strips empty lines, but
      // a row with every cell whitespace would still arrive here as a no-op).
      const anyContent =
        dateStr || actionStr || symbol || amountStr || quantityStr || priceStr || accountName;
      if (!anyContent) return;

      const action = normalizeAction(actionStr);
      if (!action) {
        // Empty or unknown action: warn + skip. We don't try to guess; the
        // allow-list is part of the template's contract with the user.
        if (actionStr.trim()) {
          unmapped.add(actionStr.trim());
          warnings.push(
            `Row ${rowIndex + 2}: unknown action "${actionStr.trim()}", skipped. ` +
              `Expected one of: ${Object.keys(UNIVERSAL_ACTION_MAP).join(', ')}.`,
          );
          actionsUnknown++;
        } else {
          warnings.push(`Row ${rowIndex + 2}: missing action, skipped.`);
        }
        return;
      }
      actionsMapped++;

      const date = parseDate(dateStr);
      if (isNaN(+date)) {
        warnings.push(
          `Row ${rowIndex + 2}: could not parse date "${dateStr}", skipped. ` +
            `Use YYYY-MM-DD (2024-01-15), MM/DD/YYYY (1/15/2024), or DD/MM/YYYY (15/01/2024).`,
        );
        return;
      }

      const quantity = Math.abs(parseNumber(quantityStr));
      const price = parseNumber(priceStr);
      const fees = Math.abs(parseNumber(feesStr));
      // Amount may legitimately be empty (e.g. a buy where price + quantity
      // imply it); leave it as null so downstream replay derives the cash
      // flow from quantity * price + fees. When the user provided an explicit
      // amount we honor the sign without doubling it for cash_out / sell etc.
      const amount = amountStr.trim() === '' ? null : parseNumber(amountStr);

      if (symbol) symbols.add(symbol);
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      const tx: ParsedTransaction = {
        date,
        symbol,
        action,
        quantity,
        price,
        fees,
        amount,
        currency,
        notes: notes || '',
        rawHash: rowHash([dateStr, actionStr, symbol, quantity, price, accountName, brokerage]),
      };
      txs.push(tx);

      brokerageCounts.set(brokerage, (brokerageCounts.get(brokerage) ?? 0) + 1);

      const bucketKey = `${brokerage}::${accountName}`;
      let bucket = accountBuckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          name: accountName || '(Unnamed account)',
          brokerage,
          accountNumber: '',
          accountTypeHint: normalizeAccountType(accountTypeRaw),
          transactions: [],
        };
        accountBuckets.set(bucketKey, bucket);
      } else if (bucket.accountTypeHint === 'unknown' && accountTypeRaw) {
        // First seen with a known type wins; later rows can refine an
        // unknown bucket but never overwrite a known one.
        bucket.accountTypeHint = normalizeAccountType(accountTypeRaw);
      }
      bucket.transactions.push(tx);
    });

    // Pick the dominant brokerage label for top-level inference (matches the
    // way Fidelity / JPM importers do single-account inference).
    let dominantBrokerage = 'Custom';
    let dominantCount = -1;
    for (const [brokerage, count] of brokerageCounts.entries()) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantBrokerage = brokerage;
      }
    }

    // Dominant account-type hint mirrors the dominant-brokerage logic: pick
    // the type that appears in the most rows so a single-account import
    // (the common case for a user typing in one Human Interest 401(k))
    // surfaces "401k" instead of "unknown".
    const typeCounts = new Map<AccountTypeId | 'unknown', number>();
    for (const bucket of accountBuckets.values()) {
      typeCounts.set(
        bucket.accountTypeHint,
        (typeCounts.get(bucket.accountTypeHint) ?? 0) + bucket.transactions.length,
      );
    }
    let dominantType: AccountTypeId | 'unknown' = 'unknown';
    let dominantTypeCount = -1;
    for (const [type, count] of typeCounts.entries()) {
      if (count > dominantTypeCount && type !== 'unknown') {
        dominantTypeCount = count;
        dominantType = type;
      }
    }
    if (dominantTypeCount < 0 && typeCounts.has('unknown')) {
      dominantType = 'unknown';
    }

    // Multi-account file: surface each bucket so the onboarding/picker flow
    // splits the upload into one row per account. The user-typed Account
    // string IS the canonical name (we don't have an account number to
    // build a "1234 Brokerage Name" canonical form).
    let accountsDetected: DetectedAccount[] | undefined;
    if (accountBuckets.size >= 2) {
      accountsDetected = Array.from(accountBuckets.entries()).map(([key, bucket]) => ({
        key,
        name: bucket.name,
        accountNumber: bucket.accountNumber,
        last4: lastFourFrom(bucket.name),
        accountTypeHint: bucket.accountTypeHint,
        transactions: bucket.transactions,
      }));
    }

    return {
      inferences: {
        brokerage: dominantBrokerage,
        accountType: dominantType,
        currency: 'USD',
        dateRange: { start: minDate, end: maxDate },
        transactionCount: txs.length,
        uniqueSymbols: symbols.size,
        actionsMapped,
        actionsUnknown,
        // Single-account uploads in the template don't include an account
        // number column; we leave these empty so upsertAccountByFingerprint
        // falls back to matching by (brokerage, name).
        accountNumber: '',
        last4: '',
      },
      transactions: txs,
      unmappedActionStrings: Array.from(unmapped),
      ...(warnings.length ? { warnings } : {}),
      ...(accountsDetected ? { accountsDetected } : {}),
    };
  },
};
