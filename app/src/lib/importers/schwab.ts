// Charles Schwab History export (also covers legacy TD Ameritrade transaction history).
// Header style: "Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount"
// Action examples: "Buy", "Sell", "Cash Dividend", "Reinvest Shares", "Reinvest Dividend"

import type { BrokerageImporter, ImporterResult, ParsedTransaction } from './types';
import { mapAction, parseDate, parseNumber, rowHash } from './util';

export const schwabImporter: BrokerageImporter = {
  id: 'schwab',
  displayName: 'Charles Schwab',
  capability: 'transactions',
  matches(headers) {
    const h = headers.map(x => x.toLowerCase());
    const hasDate = h.includes('date');
    const hasAction = h.includes('action');
    const hasSymbol = h.includes('symbol');
    const hasFeesComm = h.some(x => x.includes('fees & comm') || x === 'commission' || x.includes('fees and comm'));
    return hasDate && hasAction && hasSymbol && hasFeesComm;
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
      const actionStr = row['Action'] || '';
      const action = mapAction(actionStr);
      if (!action) {
        if (actionStr.trim()) {
          unmapped.add(actionStr.trim());
          actionsUnknown++;
        }
        continue;
      }
      actionsMapped++;
      // Schwab date can be "08/15/2024" or "08/15/2024 as of 08/14/2024"
      const dateStr = (row['Date'] || '').split(' as of ')[0];
      const date = parseDate(dateStr);
      if (isNaN(+date)) continue;

      const symbol = (row['Symbol'] || '').trim() || null;
      const quantity = parseNumber(row['Quantity']);
      const price = parseNumber(row['Price']);
      const fees = parseNumber(row['Fees & Comm'] || row['Fees & Commissions'] || row['Commission'] || row['Fees and Comm']);
      const amount = parseNumber(row['Amount']);

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
        brokerage: 'Charles Schwab',
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
