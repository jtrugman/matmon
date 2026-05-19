-- Add an instruments table holding per-symbol metadata that doesn't come from
-- the price/quote endpoints (sector, industry, long name). We populate this
-- lazily via Yahoo's /v10/finance/quoteSummary?modules=summaryProfile endpoint
-- (see src/lib/quotes/sector.ts) and cache the result so we don't re-fetch
-- once per render.
--
-- The fetched_at / last_attempt_ts / last_result columns let the backfill
-- orchestrator skip symbols already fetched within 90 days, and skip symbols
-- marked 'not_found' within 30 days (Yahoo periodically returns 404 for
-- delisted/obscure tickers; we don't want to pound the upstream forever).
--
-- All timestamps are stored as INTEGER (epoch ms) so the cooldown comparisons
-- are simple arithmetic rather than ISO-string parsing.

CREATE TABLE IF NOT EXISTS instruments (
  symbol           TEXT PRIMARY KEY,
  sector           TEXT,
  industry         TEXT,
  long_name        TEXT,
  fetched_at_ts    INTEGER NOT NULL,
  last_attempt_ts  INTEGER NOT NULL,
  last_result      TEXT NOT NULL
);
