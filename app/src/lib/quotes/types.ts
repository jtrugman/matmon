export interface Quote {
  symbol: string;
  price: number;
  currency: string;
  dayChange: number;
  dayChangePct: number;
  prevClose: number;
  fetchedAt: Date;
  name?: string;
  marketState?: 'REGULAR' | 'CLOSED' | 'PRE' | 'POST';
}

export interface HistoricalPoint {
  date: Date;
  close: number;
}

export interface FetchQuotesOptions {
  /**
   * Bypass the in-memory quote cache. Set on the explicit user "Refresh
   * quotes" path so a click after a recent fetch still triggers a fresh
   * network round-trip (otherwise the 5-minute TTL turns the button into
   * a silent no-op). Auto-driven refreshes (e.g. portfolio rebuilds) leave
   * this false so we don't pound the upstream.
   */
  force?: boolean;
}

export interface QuoteProvider {
  id: string;
  name: string;
  /** Live quotes for a batch of symbols. Implementations must batch to one request when possible. */
  fetchQuotes(symbols: string[], opts?: FetchQuotesOptions): Promise<Quote[]>;
  /** Daily close history for a single symbol, range expressed in years. */
  fetchHistory(symbol: string, years: number): Promise<HistoricalPoint[]>;
}

export interface NetworkLogEntry {
  t: Date;
  host: string;
  symbols: string[];
  bytes: number;
  durationMs: number;
  ok: boolean;
  status?: number;
  /**
   * Optional structured outcome annotation surfaced in the Privacy panel.
   * Examples produced by the historical backfill:
   *   - "OK 247 bars" (success with bar count)
   *   - "EMPTY" (Yahoo returned no bars, e.g. delisted ticker)
   *   - "FAIL Not Found" (Yahoo error object propagated)
   *   - "FAIL HTTP 429" (rate limited after retries)
   *   - "FAIL network" (transport-layer failure)
   *
   * Kept optional so existing log entries (live quotes, instruments) don't
   * have to be retrofitted: callers add a note when they have one to say.
   */
  note?: string;
}
