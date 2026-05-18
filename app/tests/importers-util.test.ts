import { describe, expect, it } from 'vitest';
import { mapAction, parseDate, parseNumber, rowHash } from '../src/lib/importers/util';

describe('parseNumber', () => {
  it('strips $ , and spaces', () => {
    expect(parseNumber('$1,234.56')).toBe(1234.56);
    expect(parseNumber(' 9,876 ')).toBe(9876);
  });

  it('treats parentheses as accounting negative', () => {
    expect(parseNumber('($120.00)')).toBe(-120);
    expect(parseNumber('(50)')).toBe(-50);
  });

  it('returns 0 for empty, dash, and null', () => {
    expect(parseNumber('')).toBe(0);
    expect(parseNumber('-')).toBe(0);
    expect(parseNumber(null)).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
  });

  it('returns 0 for unparseable strings rather than NaN', () => {
    expect(parseNumber('not-a-number')).toBe(0);
  });

  it('passes through explicit negatives', () => {
    expect(parseNumber('-1500')).toBe(-1500);
  });
});

describe('parseDate', () => {
  // parseDate now builds Dates via Date.UTC so a CSV imported in UTC+10 at
  // midnight doesn't shift to the previous calendar day in storage. Tests
  // assert against UTC accessors for the same reason.
  it('parses ISO YYYY-MM-DD', () => {
    const d = parseDate('2024-08-15');
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(15);
  });

  it('parses US MM/DD/YYYY', () => {
    const d = parseDate('08/15/2024');
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(7);
    expect(d.getUTCDate()).toBe(15);
  });

  it('parses MM/DD/YY with 2000s pivot for <50', () => {
    const d = parseDate('05/17/26');
    expect(d.getUTCFullYear()).toBe(2026);
  });

  it('parses MM/DD/YY with 1900s pivot for >=50', () => {
    const d = parseDate('05/17/95');
    expect(d.getUTCFullYear()).toBe(1995);
  });

  it('parses MM-DD-YYYY dashes', () => {
    const d = parseDate('11-09-2023');
    expect(d.getUTCMonth()).toBe(10);
    expect(d.getUTCDate()).toBe(9);
    expect(d.getUTCFullYear()).toBe(2023);
  });

  it('falls back to Date constructor for other formats', () => {
    const d = parseDate('Aug 15, 2024');
    expect(d.getFullYear()).toBe(2024);
  });

  it('returns Invalid Date for empty/null', () => {
    expect(isNaN(+parseDate(''))).toBe(true);
    expect(isNaN(+parseDate(null))).toBe(true);
  });

  it('does not drift across timezones (uses Date.UTC)', () => {
    // Regression: the previous local-tz `new Date(y, m-1, d)` could place
    // 2024-01-01 on Dec 31 2023 for users in UTC+10. Compare against the
    // explicit UTC timestamp to lock the behavior.
    const d = parseDate('2024-01-01');
    expect(+d).toBe(Date.UTC(2024, 0, 1));
  });
});

describe('mapAction', () => {
  it('maps Fidelity-style strings', () => {
    expect(mapAction('YOU BOUGHT')).toBe('buy');
    expect(mapAction('YOU SOLD')).toBe('sell');
    expect(mapAction('DIVIDEND RECEIVED')).toBe('dividend');
    expect(mapAction('REINVESTMENT')).toBe('div_reinvest');
  });

  it('maps Schwab-style strings', () => {
    expect(mapAction('Buy')).toBe('buy');
    expect(mapAction('Sell')).toBe('sell');
    expect(mapAction('Cash Dividend')).toBe('dividend');
    expect(mapAction('Reinvest Dividend')).toBe('div_reinvest');
    expect(mapAction('Reinvest Shares')).toBe('div_reinvest');
  });

  it('maps JPM-style strings', () => {
    expect(mapAction('Purchase')).toBe('buy');
    expect(mapAction('Dividend')).toBe('dividend');
    expect(mapAction('Redemption')).toBe('sell');
  });

  it('maps generic activity types', () => {
    expect(mapAction('Interest')).toBe('interest');
    expect(mapAction('Stock Split')).toBe('split');
    expect(mapAction('Spin-off')).toBe('spinoff');
    expect(mapAction('Transfer In')).toBe('transfer_in');
    expect(mapAction('Cash deposit')).toBe('cash_in');
    expect(mapAction('Withdrawal')).toBe('cash_out');
    expect(mapAction('Fee')).toBe('fee');
  });

  it('returns null for unrecognized strings', () => {
    expect(mapAction('Mystery Transaction')).toBeNull();
    expect(mapAction('')).toBeNull();
  });

  it('div_reinvest wins over dividend for ambiguous "dividend reinvested" copy', () => {
    expect(mapAction('Dividend Reinvested')).toBe('div_reinvest');
  });

  it('maps Fidelity "Electronic Funds Transfer Received" to cash_in', () => {
    expect(mapAction('Electronic Funds Transfer Received (Cash)')).toBe('cash_in');
    expect(mapAction('electronic funds transfer received')).toBe('cash_in');
  });

  it('maps Fidelity "Electronic Funds Transfer Paid" to cash_out', () => {
    expect(mapAction('Electronic Funds Transfer Paid (Cash)')).toBe('cash_out');
  });

  it('maps Fidelity "DISTRIBUTION ..." fund-distribution rows to dividend', () => {
    expect(mapAction('DISTRIBUTION VANGUARD S&P 500 ETF (VOO) (Cash)')).toBe('dividend');
    expect(mapAction('DISTRIBUTION')).toBe('dividend');
  });

  it('REINVESTMENT still maps to div_reinvest after the new rules', () => {
    expect(mapAction('REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET FUND (SPAXX) (Cash)')).toBe(
      'div_reinvest',
    );
  });

  it('plain "Withdrawal" still maps to cash_out', () => {
    expect(mapAction('Withdrawal')).toBe('cash_out');
  });
});

describe('rowHash', () => {
  it('is deterministic for the same inputs', () => {
    const a = rowHash(['2024-08-15', 'BUY', 'AAPL', 10, 180.5]);
    const b = rowHash(['2024-08-15', 'BUY', 'AAPL', 10, 180.5]);
    expect(a).toBe(b);
  });

  it('differs when any field changes', () => {
    const a = rowHash(['2024-08-15', 'BUY', 'AAPL', 10, 180.5]);
    const b = rowHash(['2024-08-16', 'BUY', 'AAPL', 10, 180.5]);
    expect(a).not.toBe(b);
  });
});
