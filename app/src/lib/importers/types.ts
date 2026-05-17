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
}

export interface DetectedAccount {
  /** Stable key for this account within a multi-account import (e.g. "Individual::XXXX1234"). */
  key: string;
  /** Human-readable account name from the CSV (e.g. "Individual", "Health Savings Account"). */
  name: string;
  /** Brokerage-assigned account number, when present in the CSV. */
  accountNumber: string;
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
   * Set when the file contains multiple distinct brokerage accounts (e.g. a
   * combined Fidelity export with Individual + HSA). Each entry carries its
   * own slice of transactions; the flat `transactions` array still holds the
   * union for backwards compatibility with single-account callers.
   */
  accountsDetected?: DetectedAccount[];
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
