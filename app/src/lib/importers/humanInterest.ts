// Human Interest 401(k). Their export is "holdings-only" in many cases: a list of fund
// positions with current balance and contribution totals, no transaction-level history.
// Header style: "Fund Name,Ticker,Shares,Unit Price,Market Value,Employee Contributions,Employer Contributions,..."

import type { BrokerageImporter, ImporterResult, ParsedTransaction } from './types';
import { parseDate, parseNumber, rowHash } from './util';

export const humanInterestImporter: BrokerageImporter = {
  id: 'humanInterest',
  displayName: 'Human Interest',
  capability: 'holdings-only',
  matches(headers, firstRow) {
    const h = headers.map(x => x.toLowerCase());
    const hasFund = h.some(x => x.includes('fund') || x.includes('investment'));
    const hasShares = h.includes('shares') || h.includes('units');
    const hasContrib = h.some(x => x.includes('employee contribution') || x.includes('employer contribution'));
    if (hasFund && hasShares && hasContrib) return true;
    // Looser: any row containing "Human Interest" branding
    return JSON.stringify(firstRow).toLowerCase().includes('human interest');
  },
  parse(rows): ImporterResult {
    // For holdings-only providers we synthesize "transfer_in" transactions on a
    // pseudo-date (today) to represent the current position; the inferences flag
    // the file as holdings-only so the UI surfaces that.
    const txs: ParsedTransaction[] = [];
    const symbols = new Set<string>();
    const today = new Date();
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    for (const row of rows) {
      const symbol = (row['Ticker'] || row['Symbol'] || row['Fund Ticker'] || '').trim().toUpperCase();
      const shares = parseNumber(row['Shares'] || row['Units']);
      const price = parseNumber(row['Unit Price'] || row['Price'] || row['NAV']);
      if (!symbol || shares <= 0) continue;

      const date = parseDate(row['As Of'] || row['Date'] || '') || today;
      const useDate = isNaN(+date) ? today : date;
      symbols.add(symbol);
      if (!minDate || useDate < minDate) minDate = useDate;
      if (!maxDate || useDate > maxDate) maxDate = useDate;

      txs.push({
        date: useDate,
        symbol,
        action: 'transfer_in',
        quantity: shares,
        price,
        fees: 0,
        amount: shares * price,
        currency: 'USD',
        notes: 'Synthesized from Human Interest holdings-only export',
        rawHash: rowHash([symbol, shares, price, +useDate]),
      });
    }

    return {
      inferences: {
        brokerage: 'Human Interest',
        accountType: '401k',
        currency: 'USD',
        dateRange: { start: minDate, end: maxDate },
        transactionCount: txs.length,
        uniqueSymbols: symbols.size,
        actionsMapped: txs.length,
        actionsUnknown: 0,
      },
      transactions: txs,
      unmappedActionStrings: [],
    };
  },
};
