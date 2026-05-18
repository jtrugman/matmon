// JP Morgan Self-Directed / JPM Wealth / Chase Brokerage history export.
// Header style: "Trade Date,Settle Date,Transaction Type,Quantity,Symbol,Description,Price,Net Amount"
// Variants seen: "Posting Date", "Activity Type"

import type { BrokerageImporter, ImporterResult, ParsedTransaction } from './types';
import { mapAction, parseDate, parseNumber, rowHash } from './util';

export const jpmImporter: BrokerageImporter = {
  id: 'jpmorgan',
  displayName: 'JP Morgan',
  capability: 'transactions',
  matches(headers, firstRow) {
    const h = headers.map(x => x.toLowerCase());
    const hasTradeDate = h.includes('trade date') || h.includes('posting date');
    const hasTxnType = h.some(x => x.includes('transaction type') || x.includes('activity type') || x === 'type');
    const hasSymbol = h.includes('symbol') || h.includes('security symbol');
    const hasNetAmount = h.some(x => x.includes('net amount') || x === 'amount');
    if (!(hasTradeDate && hasTxnType && hasSymbol && hasNetAmount)) return false;
    // Differentiate from Schwab/Fidelity that share some headers.
    const looksLikeJpm = h.some(x => x.includes('settle date')) || JSON.stringify(firstRow).toLowerCase().includes('j.p. morgan');
    return looksLikeJpm || true;
  },
  parse(rows): ImporterResult {
    const txs: ParsedTransaction[] = [];
    const unmapped = new Set<string>();
    const symbols = new Set<string>();
    let actionsMapped = 0;
    let actionsUnknown = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    for (const row of rows) {
      const actionStr =
        row['Transaction Type'] || row['Activity Type'] || row['Type'] || row['Transaction'] || '';
      const action = mapAction(actionStr);
      if (!action) {
        if (actionStr.trim()) {
          unmapped.add(actionStr.trim());
          actionsUnknown++;
        }
        continue;
      }
      actionsMapped++;
      const dateStr = row['Trade Date'] || row['Posting Date'] || row['Date'];
      const date = parseDate(dateStr);
      if (isNaN(+date)) continue;

      const symbol = (row['Symbol'] || row['Security Symbol'] || '').trim() || null;
      const quantity = parseNumber(row['Quantity'] || row['Shares']);
      const price = parseNumber(row['Price']);
      const fees = parseNumber(row['Fees'] || row['Commission'] || row['Charges']);
      const amount = parseNumber(row['Net Amount'] || row['Amount']);

      if (symbol) symbols.add(symbol);
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      txs.push({
        date,
        symbol,
        action,
        quantity: Math.abs(quantity),
        price,
        fees: Math.abs(fees),
        amount,
        currency: 'USD',
        notes: row['Description'] || '',
        rawHash: rowHash([dateStr, actionStr, symbol, quantity, price]),
      });
    }

    return {
      inferences: {
        brokerage: 'JP Morgan',
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
    };
  },
};
