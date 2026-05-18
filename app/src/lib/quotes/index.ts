import type { QuoteProvider } from './types';
import { yahooProvider } from './yahoo';

let active: QuoteProvider = yahooProvider;
let offline = false;

export function getProvider(): QuoteProvider {
  return active;
}

export function setProvider(p: QuoteProvider) {
  active = p;
}

export function setOffline(v: boolean) {
  offline = v;
}

export function isOffline() {
  return offline;
}

export type {
  Quote,
  HistoricalPoint,
  QuoteProvider,
  NetworkLogEntry,
  FetchQuotesOptions,
} from './types';
export { networkLog } from './log';
export { yahooProvider, clearQuoteCache } from './yahoo';
export { fetchHistoricalDaily, type HistoricalBar } from './history';
export {
  backfillHistoricalPrices,
  filterBackfillSymbols,
  type BackfillOptions,
  type BackfillResult,
} from './backfill';
export {
  fetchInstrumentSector,
  backfillInstruments,
  type InstrumentProfile,
  type BackfillInstrumentsResult,
} from './sector';
