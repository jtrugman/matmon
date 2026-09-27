-- Add a prev_close column to the prices table so we can compute today's
-- per-symbol day change. The Yahoo chart endpoint surfaces
-- meta.chartPreviousClose alongside meta.regularMarketPrice on every quote;
-- before this migration we discarded that field, which forced
-- BrokerageTile to render a "+$0.00 today" placeholder.
--
-- Nullable on purpose: rows backfilled from the historical chart endpoint
-- only carry a close price, not a prev_close (the previous bar's close is
-- the previous row in the table). The portfolio aggregator treats NULL as
-- "no data for today's delta on this symbol" and excludes it from the
-- per-brokerage / per-account day change, surfacing a "(N symbols pending
-- today's data)" footer when any holdings can't be priced today.

ALTER TABLE prices ADD COLUMN prev_close REAL;
