// Fidelity History export
// Header style: "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),..."
// Multi-account exports add "Account" and "Account Number" columns.
// Action examples: "YOU BOUGHT", "YOU SOLD", "DIVIDEND RECEIVED", "REINVESTMENT",
//                  "Electronic Funds Transfer Received", "DISTRIBUTION VANGUARD..."

import type {
  AccountTypeId,
  BrokerageImporter,
  DetectedAccount,
  ImporterResult,
  ParsedTransaction,
} from './types';
import { mapAction, parseDate, parseNumber, rowHash } from './util';

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
  const action = mapAction(actionStr);
  if (!action) {
    return { tx: null, actionStr, mapped: false };
  }
  const date = parseDate(runDate);
  if (isNaN(+date)) return { tx: null, actionStr, mapped: true };

  // Fidelity often emits a literal " " (single space) for cash-only rows; treat
  // any symbol that trims to empty as null so it doesn't pollute symbol lists.
  const symbol = (row['Symbol'] || '').trim() || null;
  const quantity = parseNumber(row['Quantity']);
  const price = parseNumber(row['Price ($)'] || row['Price']);
  const fees = parseNumber(row['Commission ($)'] || row['Fees ($)'] || row['Fees']);
  const amount = parseNumber(row['Amount ($)'] || row['Amount'] || '0');

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
      notes: row['Description'] || '',
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
  matches(headers, firstRow) {
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
        accountTypeHint: guessAccountType(bucket.name),
        transactions: bucket.transactions,
      }));
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
      },
      transactions: txs,
      unmappedActionStrings: Array.from(unmapped),
      ...(accountsDetected ? { accountsDetected } : {}),
    };
  },
};
