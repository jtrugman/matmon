import Papa from 'papaparse';
import type { BrokerageImporter, ImporterResult, ParsedTransaction } from './types';
import {
  fidelityImporter,
  detectSingleAccountFidelityRejection,
  FIDELITY_SINGLE_ACCOUNT_REJECTION_MESSAGE,
  FIDELITY_SINGLE_ACCOUNT_REJECTION_KIND,
} from './fidelity';
import { schwabImporter } from './schwab';
import { jpmImporter } from './jpmorgan';
import { jpmHoldingsImporter } from './jpmHoldings';
import { humanInterestImporter } from './humanInterest';
import { matmonUniversalImporter } from './matmonUniversal';
import { mapAction, parseDate, parseNumber, rowHash } from './util';

export type { BrokerageImporter, ImporterResult, ParsedTransaction };

// Order matters. The native, header-strict importers run first so they
// claim their own brokerage exports. The Matmon Universal template runs
// BEFORE humanInterestImporter because humanInterest has a loose fallback
// (any row containing "Human Interest" branding wins) that would otherwise
// hijack a universal-template file whose Brokerage column happens to read
// "Human Interest". Universal's matches() requires the canonical 6-column
// signature (Date, Action, Symbol, Amount, Account, Brokerage), which is
// strict enough to safely run ahead of the brand-string fallback.
//
// jpmHoldingsImporter is listed before jpmImporter so the positions/lots
// export is matched first when both could theoretically claim a file. In
// practice the two have non-overlapping headers (lots use CUSIP + Acquisition
// Date; transactions use Trade Date + Transaction Type) so they can't
// collide, but the explicit ordering keeps detection deterministic.
//
// When even the universal template doesn't match, importCsv falls through to
// the column-mapping wizard.
export const IMPORTERS: BrokerageImporter[] = [
  fidelityImporter,
  schwabImporter,
  jpmHoldingsImporter,
  jpmImporter,
  matmonUniversalImporter,
  humanInterestImporter,
];

/**
 * Real brokerage exports often wrap the data table in leading blank lines and
 * trailing disclaimer paragraphs. Papa's header inference treats the first
 * non-empty line as headers, so a leading blank line silently turns into an
 * empty "" header that breaks every importer's matches() check. Strip both
 * ends before parsing.
 */
export function preprocessCsv(csvText: string): string {
  const lines = csvText.split(/\r?\n/);

  // Drop leading whitespace-only lines.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;

  // Drop trailing whitespace-only lines and trailing free-form prose. Brokerage
  // disclaimers usually start with a leading quote and contain a known marker
  // phrase, or are a one-liner like "Date downloaded ...".
  let end = lines.length;
  const disclaimerMarkers = [
    /^"?the data and information/i,
    /^"?brokerage services are provided/i,
    /^"?fidelity insurance agency/i,
    /^"?financial services llc/i,
    /^"?informational purposes only/i,
    /^"?recommendation for any security/i,
    /^"?exported and is subject to change/i,
    /^"?purposes\. for more information/i,
    /^date downloaded\b/i,
  ];
  const looksLikeDisclaimer = (line: string) => {
    const t = line.trim();
    if (t === '') return true;
    return disclaimerMarkers.some(re => re.test(t));
  };
  while (end > start && looksLikeDisclaimer(lines[end - 1])) end--;

  return lines.slice(start, end).join('\n');
}

/**
 * Known wrong-export signatures. Returns a friendly message + machine-readable
 * kind tag when the file looks like a balance/positions snapshot instead of a
 * transaction history. Returns null when the file shape isn't recognized as a
 * known wrong-export case (caller falls back to the column-mapping wizard).
 */
function detectWrongExport(rawText: string): { reason: string; kind: string } | null {
  const head = rawText.slice(0, 400);
  if (/balances for account/i.test(head)) {
    return {
      reason:
        'This looks like a Schwab balance/positions export. Matmon needs the ' +
        'Transaction History export instead. In Schwab, go to History, then ' +
        'Transactions, then Export.',
      kind: 'wrong-schwab-export',
    };
  }
  if (/^"?positions\b/im.test(head) && /symbol/i.test(head) && !/action/i.test(head)) {
    return {
      reason:
        'This looks like a positions/holdings snapshot. Matmon needs a ' +
        'transaction history export instead so it can reconstruct cost basis.',
      kind: 'wrong-positions-export',
    };
  }
  if (/portfolio holdings/i.test(head)) {
    return {
      reason:
        'This looks like a portfolio holdings export. Matmon needs a ' +
        'transaction history export instead so it can reconstruct cost basis.',
      kind: 'wrong-holdings-export',
    };
  }
  return null;
}

export type DetectResult = {
  importer: BrokerageImporter | null;
  rows: Record<string, string>[];
  headers: string[];
};

export function detect(csvText: string): DetectResult {
  const cleaned = preprocessCsv(csvText);
  const parsed = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => h.trim(),
  });
  const rows = parsed.data;
  const headers = parsed.meta.fields || [];
  const firstRow = rows[0] || {};
  for (const importer of IMPORTERS) {
    if (importer.matches(headers, firstRow)) {
      return { importer, rows, headers };
    }
  }
  return { importer: null, rows, headers };
}

export function importCsv(csvText: string): ImporterResult & { importerId: string | null } {
  const { importer, rows, headers } = detect(csvText);
  if (importer) {
    // Brokerage-specific pre-parse rejection: Fidelity single-account exports
    // (no Account Number column) lack the dedup fingerprint Matmon needs to
    // keep accounts organized. Reject cleanly with a user-facing message
    // pointing the user at the multi-account "All Accounts" export instead.
    // Mirrors the Schwab balances-export rejection pattern below.
    if (
      importer.id === 'fidelity' &&
      detectSingleAccountFidelityRejection(headers, rows)
    ) {
      return {
        importerId: null,
        inferences: {
          brokerage: 'Fidelity',
          accountType: 'unknown',
          currency: 'USD',
          dateRange: { start: null, end: null },
          transactionCount: 0,
          uniqueSymbols: 0,
          actionsMapped: 0,
          actionsUnknown: 0,
        },
        transactions: [],
        unmappedActionStrings: [],
        rejectionReason: FIDELITY_SINGLE_ACCOUNT_REJECTION_MESSAGE,
        rejectionKind: FIDELITY_SINGLE_ACCOUNT_REJECTION_KIND,
      };
    }
    return { ...importer.parse(rows), importerId: importer.id };
  }

  // No importer matched. Before falling back to the column-mapping wizard,
  // check whether the file is a known wrong-shape export (balances/positions
  // instead of transaction history) and tell the user what to upload.
  const rejection = detectWrongExport(csvText);

  return {
    importerId: null,
    inferences: {
      brokerage: 'Unknown',
      accountType: 'unknown',
      currency: 'USD',
      dateRange: { start: null, end: null },
      transactionCount: 0,
      uniqueSymbols: 0,
      actionsMapped: 0,
      actionsUnknown: 0,
    },
    transactions: [],
    unmappedActionStrings: [],
    ...(rejection ? { rejectionReason: rejection.reason, rejectionKind: rejection.kind } : {}),
  };
}

/**
 * Manual mapping fallback. Caller supplies a column-name map and we parse the rows with it,
 * letting the user rescue an unrecognized CSV without writing a new importer.
 */
export type ColumnMap = {
  date: string;
  action: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  fees?: string;
  amount?: string;
  notes?: string;
};

export function parseWithColumnMap(
  csvText: string,
  map: ColumnMap,
  options: { brokerage?: string; currency?: string } = {},
): ImporterResult {
  const parsed = Papa.parse<Record<string, string>>(preprocessCsv(csvText), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => h.trim(),
  });
  const rows = parsed.data;
  const txs: ParsedTransaction[] = [];
  const unmapped = new Set<string>();
  const symbols = new Set<string>();
  let actionsMapped = 0;
  let actionsUnknown = 0;
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of rows) {
    const actionStr = row[map.action] || '';
    const action = mapAction(actionStr);
    if (!action) {
      if (actionStr.trim()) {
        unmapped.add(actionStr.trim());
        actionsUnknown++;
      }
      continue;
    }
    actionsMapped++;
    const date = parseDate(row[map.date]);
    if (isNaN(+date)) continue;
    const symbol = map.symbol ? (row[map.symbol] || '').trim() || null : null;
    const quantity = map.quantity ? Math.abs(parseNumber(row[map.quantity])) : 0;
    const price = map.price ? parseNumber(row[map.price]) : 0;
    const fees = map.fees ? Math.abs(parseNumber(row[map.fees])) : 0;
    const amount = map.amount ? parseNumber(row[map.amount]) : null;
    if (symbol) symbols.add(symbol);
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
    txs.push({
      date,
      symbol,
      action,
      quantity,
      price,
      fees,
      amount,
      currency: options.currency || 'USD',
      notes: map.notes ? row[map.notes] || '' : '',
      rawHash: rowHash([row[map.date], actionStr, symbol, quantity, price]),
    });
  }

  return {
    inferences: {
      brokerage: options.brokerage || 'Custom',
      accountType: 'unknown',
      currency: options.currency || 'USD',
      dateRange: { start: minDate, end: maxDate },
      transactionCount: txs.length,
      uniqueSymbols: symbols.size,
      actionsMapped,
      actionsUnknown,
    },
    transactions: txs,
    unmappedActionStrings: Array.from(unmapped),
  };
}
