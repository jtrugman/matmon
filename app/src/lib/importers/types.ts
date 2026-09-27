// Brokerage CSV importer contracts.
// Every parser conforms to BrokerageImporter; main entry point in parse.ts
// auto-detects which one to use from the CSV header row, then yields
// normalized Transaction[] for the persistence layer to insert.

export type Action =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'div_reinvest'
  | 'split'
  | 'spinoff'
  | 'transfer_in'
  | 'transfer_out'
  | 'cash_in'
  | 'cash_out'
  | 'fee'
  | 'interest';

export interface ParsedTransaction {
  date: Date;
  symbol: string | null;
  action: Action;
  quantity: number;
  price: number;
  fees: number;
  amount: number | null;
  currency: string;
  notes: string;
  rawHash: string;
}

export type AccountTypeId = 'taxable' | 'trad_ira' | 'roth_ira' | '401k' | 'hsa' | 'other';

export interface ImporterInferences {
  brokerage: string;
  accountType: AccountTypeId | 'unknown';
  currency: string;
  dateRange: { start: Date | null; end: Date | null };
  transactionCount: number;
  uniqueSymbols: number;
  actionsMapped: number;
  actionsUnknown: number;
  /**
   * Brokerage-assigned account number for single-account uploads, when the
   * exporter surfaces it (Fidelity History exports include "Account Number"
   * per row even on single-account files; Schwab transactions and JPM
   * activity exports rarely do). Empty string when not detected.
   */
  accountNumber?: string;
  /**
   * Trailing 4-digit window of `accountNumber`. Empty string when no account
   * number was detected. This is the canonical fingerprint used by
   * `upsertAccountByFingerprint` to collapse re-imports of the same account
   * back onto the original row instead of creating a duplicate skeleton.
   */
  last4?: string;
}

export interface DetectedAccount {
  /** Stable key for this account within a multi-account import (e.g. "Individual::XXXX1234"). */
  key: string;
  /** Human-readable account name from the CSV (e.g. "Individual", "Health Savings Account"). */
  name: string;
  /** Brokerage-assigned account number, when present in the CSV. */
  accountNumber: string;
  /**
   * Trailing 4-digit window of the account number. Empty string when the
   * brokerage didn't surface an account number in the export. This is the
   * canonical fingerprint used to dedupe re-imports of the same account
   * (alongside `brokerage`) so a second import doesn't spawn an empty
   * skeleton row.
   */
  last4: string;
  /** Best-guess matmon account type based on the account name (e.g. "hsa", "roth_ira"). */
  accountTypeHint: AccountTypeId | 'unknown';
  /** Transactions parsed for this specific account. */
  transactions: ParsedTransaction[];
}

export interface ImporterResult {
  inferences: ImporterInferences;
  transactions: ParsedTransaction[];
  unmappedActionStrings: string[];
  /**
   * Set when we KNOW the uploaded file is the wrong export shape (for example a
   * Schwab balances/positions snapshot instead of transaction history). The UI
   * uses this to short-circuit and tell the user what to upload instead.
   */
  rejectionReason?: string;
  /**
   * Machine-readable tag for the rejection, when one is set. The UI can use
   * this to format the message with brokerage-specific styling (icon, link to
   * the brokerage's export page, etc.) without having to substring-match on
   * `rejectionReason`. Examples:
   *   - `wrong-fidelity-export`: a Fidelity transaction history export that
   *     omits the Account Number column (single-account export). The user
   *     needs the multi-account "All Accounts" export instead.
   *   - `wrong-schwab-export`: a Schwab balances/positions snapshot instead
   *     of the transaction history.
   * Empty / undefined when no rejection was triggered.
   */
  rejectionKind?: string;
  /**
   * Set when the file contains multiple distinct brokerage accounts (e.g. a
   * combined Fidelity export with Individual + HSA). Each entry carries its
   * own slice of transactions; the flat `transactions` array still holds the
   * union for backwards compatibility with single-account callers.
   */
  accountsDetected?: DetectedAccount[];
  /**
   * Current market prices observed in the source file, one entry per unique
   * symbol. Holdings-only importers (notably JPM positions) carry a "Price" /
   * "Pricing Date" column alongside the lot's cost basis; we surface those
   * here so the persistence layer can write them into the local `prices` table,
   * letting portfolio aggregation distinguish market value from cost basis
   * even when no live quote provider is reachable.
   */
  marketPrices?: Array<{ symbol: string; price: number; asOf: Date }>;
  /**
   * Non-fatal parse warnings, one string per skipped row or recoverable
   * issue. The Matmon Universal template surfaces these so a user typing in
   * a Human Interest 401(k) row by hand can fix typos (unknown action,
   * unparseable date) without losing the rest of the file.
   */
  warnings?: string[];
}

export interface BrokerageImporter {
  id: string;
  displayName: string;
  /** Inspect headers and a sample row; return true if this importer should claim the file. */
  matches: (headers: string[], firstRow: Record<string, string>) => boolean;
  parse: (rows: Record<string, string>[]) => ImporterResult;
  /** "transaction-level" vs "holdings-only" (e.g. 401k providers). */
  capability: 'transactions' | 'holdings-only';
}
