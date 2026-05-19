import type { Action } from './types';

export function parseNumber(s: string | undefined | null): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[$,\s()]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  // Parentheses are accounting-style negative.
  const negative = /[()]/.test(String(s));
  const n = Number(cleaned);
  if (Number.isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

export function parseDate(s: string | undefined | null): Date {
  if (!s) return new Date(NaN);
  const trimmed = s.trim();
  // All branches use Date.UTC so the imported date doesn't shift by a day for
  // users west of UTC (e.g. someone in UTC+10 importing at midnight local
  // would otherwise see every date land one day earlier in the DB).
  // ISO YYYY-MM-DD or YYYY/MM/DD
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
    const [y, m, d] = trimmed.split(/[-/]/).map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  // MM/DD/YYYY or MM/DD/YY
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const m = Number(us[1]);
    const d = Number(us[2]);
    let y = Number(us[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return new Date(Date.UTC(y, m - 1, d));
  }
  // MM-DD-YYYY
  const dash = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (dash) {
    const m = Number(dash[1]);
    const d = Number(dash[2]);
    let y = Number(dash[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return new Date(Date.UTC(y, m - 1, d));
  }
  const parsed = new Date(trimmed);
  return parsed;
}

// Order matters: more specific patterns first. Note that "Electronic Funds Transfer
// Received/Paid" must beat the generic "received"/"transfer" rules, and DISTRIBUTION
// (which is a fund capital-gains distribution, paid TO the holder) must beat the
// generic "distribution" rule that otherwise sweeps into cash_out.
const ACTION_MAP: Array<{ test: RegExp; action: Action }> = [
  { test: /electronic funds transfer received/i, action: 'cash_in' },
  { test: /electronic funds transfer paid/i, action: 'cash_out' },
  { test: /reinvest|div.*reinvested|drip/i, action: 'div_reinvest' },
  { test: /distribution/i, action: 'dividend' },
  { test: /dividend|income.*reinvested.*dividend|dividend received/i, action: 'dividend' },
  { test: /interest/i, action: 'interest' },
  { test: /you bought|buy|purchase|bought|sweep in/i, action: 'buy' },
  { test: /you sold|sell|sold|redemption/i, action: 'sell' },
  { test: /split/i, action: 'split' },
  { test: /spin.?off/i, action: 'spinoff' },
  { test: /transfer in|received transfer/i, action: 'transfer_in' },
  { test: /transfer out|delivered/i, action: 'transfer_out' },
  { test: /deposit|cash in|contribution/i, action: 'cash_in' },
  { test: /withdrawal|cash out/i, action: 'cash_out' },
  { test: /fee|commission/i, action: 'fee' },
];

export function mapAction(raw: string): Action | null {
  if (!raw) return null;
  for (const { test, action } of ACTION_MAP) {
    if (test.test(raw)) return action;
  }
  return null;
}

export function rowHash(parts: (string | number | null | undefined)[]): string {
  // Deterministic but cheap fingerprint for dedupe. Not cryptographic.
  let h = 5381;
  for (const p of parts) {
    const s = String(p ?? '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
