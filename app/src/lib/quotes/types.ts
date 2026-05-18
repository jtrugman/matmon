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

export interface QuoteProvider {
  id: string;
  name: string;
  /** Live quotes for a batch of symbols. Implementations must batch to one request when possible. */
  fetchQuotes(symbols: string[]): Promise<Quote[]>;
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
}
