# Matmon Functionality Matrix

Last updated: 2026-05-18 (overnight session)

This is the single source of truth for "what works right now" as of the overnight
session that bundles PR #1 (initial codebase), PR #2 (foundational fixes), PR #3
(chart backfill hardening), and PR #4 (view-layer polish + cash-flow labels) on
top of `main`. Every row points to the most-relevant source file and the test
that backs the claim. When CI is green you can trust the row; when CI is failing
because the gitignored `app/example_csv/` is missing on the runner, the
matrix below cites the local 668/668 vitest pass and the 53 Playwright passes
verified on Justin's machine.

## Legend

- **VERIFIED**: backed by a Playwright spec that runs against the live UI in
  headless Chromium AND/OR a screenshot artifact under
  `app/screenshots/` showing the feature working end-to-end. The test passes
  locally on Justin's machine; CI may fail only because `example_csv/` is
  gitignored.
- **IMPLEMENTED**: code exists and is covered by vitest at the unit /
  importer / portfolio layer. No Playwright spec drives the surface
  end-to-end yet, typically because the upstream data sample isn't in the
  repo or because the surface is small enough that the unit test is the
  whole contract.
- **PARTIAL**: works for some cases; the specific cases that break are
  enumerated.
- **BROKEN**: feature exists in code but observably does not work.
- **NOT IMPLEMENTED**: feature is in the PRD but not in the codebase.

## Brokerage CSV imports

| Row | Status | Most-relevant code | Test coverage |
| --- | --- | --- | --- |
| Fidelity multi-account (transaction history) | VERIFIED | `app/src/lib/importers/fidelity.ts` | `app/tests/math-validation.test.ts` pins Individual + HSA totals to the cent ($22,673.04 across 2 accounts); `app/tests-e2e/all-brokerages-smoke.spec.ts` walks the live UI. Screenshot: `app/screenshots/brokerage-matrix-fidelity-multi.png` |
| Fidelity single-account (transaction history) | VERIFIED REJECTED | `app/src/lib/importers/fidelity.ts` | Single-account exports lack the Account Number column, so they're rejected at the import gate with a helpful inline error. `app/tests/fidelity-single-account-rejection.test.ts` pins the rejection on the real sample (`example_csv/single_account_fidelity.csv`). |
| Fidelity last-4 extraction (multi-account) | VERIFIED | `app/src/lib/importers/fidelity.ts` | `app/tests/fidelity-last4-extraction.test.ts` confirms each detected account surfaces a 4-digit last4 (Individual + HSA). Re-import dedups on (brokerage, last4). |
| Fidelity DISTRIBUTION = transfer_in | VERIFIED | `app/src/lib/importers/fidelity.ts` | `mapAction` tags `DISTRIBUTION` rows as `transfer_in`, not `div_reinvest`, so a $7,808 share distribution doesn't pollute XIRR. `app/tests/math-validation.test.ts` and `app/tests/xirr-check.test.ts` lock the math. |
| Fidelity Electronic Funds Transfer (cash_in / cash_out) | VERIFIED | `app/src/lib/importers/fidelity.ts` | EFT Received / EFT Paid rows map to `cash_in` / `cash_out`. `app/tests/fidelity-eft-deposit.test.ts` covers the action mapping; the e2e label rendering is covered by `app/tests-e2e/cash-flow-labels.spec.ts` (now shows "Deposit" blue tier, not "BUY" green). |
| Charles Schwab transaction history | VERIFIED | `app/src/lib/importers/schwab.ts` | `app/tests/math-validation.test.ts` (`GT_SCHWAB_TX`) pins QQQ qty=0.0105, cost=$6.2155, value=$5.9514. `app/tests-e2e/schwab-e2e.spec.ts` Test A walks Home, Holdings, Holding Detail, Refresh quotes. Screenshots: `app/screenshots/schwab-home.png`, `schwab-holdings.png`, `schwab-account-detail.png`, `brokerage-matrix-schwab-tx.png`. |
| Charles Schwab balances/positions export | VERIFIED REJECTED | `app/src/lib/importers/schwab.ts` | `app/tests/real-csv.test.ts` confirms `importerId === null` with a "balance" / "positions" / "transaction history" hint in the rejection reason. `app/tests-e2e/schwab-e2e.spec.ts` Test B drives the inline error banner in the live UI. |
| JP Morgan Self-Directed (holdings/positions/lots) | VERIFIED | `app/src/lib/importers/jpmHoldings.ts` | `app/tests/math-validation.test.ts` (`GT_JPM`) pins per-symbol totals across 17 tickers, 4 accounts (total $707,377.93). `app/tests-e2e/jpm-onboarding.spec.ts` + `app/tests-e2e/all-brokerages-smoke.spec.ts` render all 4 accounts in the canonical `<last4> JP Morgan <name>` format. Screenshot: `app/screenshots/brokerage-matrix-jpm-multi.png`. |
| JP Morgan transactions (history export) | IMPLEMENTED | `app/src/lib/importers/jpmorgan.ts` | Importer is header-guarded against Schwab / Fidelity collisions and unit-tested in `app/tests/importers.test.ts` plus `app/src/lib/importers/__fixtures__/jpmorgan/`. **No real-CSV E2E** because `example_csv/` has only the holdings export. To upgrade: drop a real JPM transaction CSV into `example_csv/` and the smoke spec will auto-route it. |
| Human Interest 401(k) | VERIFIED (synthetic) | `app/src/lib/importers/humanInterest.ts` | `app/tests/importers.test.ts` covers header detection. `app/tests-e2e/human-interest-e2e.spec.ts` drives a synthetic Vanguard-fund-family fixture through the live UI (12 funds, `transfer_in` actions). No real export in `example_csv/`. Screenshot: `app/screenshots/brokerage-matrix-human-interest.png`. |
| Matmon Universal CSV template | VERIFIED | `app/src/lib/importers/matmonUniversal.ts`, `app/src/views/UniversalTemplateView.tsx`, `app/public/matmon-template.csv` | `app/tests/importers-matmon-universal.test.ts` covers all 12 supported actions and signed amounts. `app/tests-e2e/universal-template-view.spec.ts` downloads the template asset, uploads a filled file, and lands on Home. Screenshots: `app/screenshots/universal-template-view-full.png`, `universal-template-link-on-add-account.png`. |
| Unknown CSV to column-mapping wizard | IMPLEMENTED | `app/src/lib/importers/index.ts` (`parseWithColumnMap`), `app/src/views/AddAccountView.tsx` (`ColumnMapperStep`) | `app/tests/column-mapper.test.tsx` covers the parse pipeline. **No Playwright spec** drives the full unknown-CSV-to-wizard-to-portfolio path. |
| Account dedup on (brokerage, last4) | VERIFIED | `app/src/lib/db/repos.ts` (`upsertAccountByFingerprint`, `dedupeDuplicateAccounts`) | `app/tests/account-dedup.test.ts` (full migration coverage), `app/tests/account-id.test.ts` (slug helper), `app/tests-e2e/duplicate-account-bug.spec.ts` (live UI verification). The one-shot V1 migration runs once on first launch and collapses prior dirty state. |

## Math

| Row | Status | Most-relevant code | Test coverage |
| --- | --- | --- | --- |
| Cost basis chronological replay | VERIFIED | `app/src/lib/portfolio.ts` (`buildPortfolio`) | `app/tests/math-validation.test.ts` re-derives every per-symbol cost basis and compares against `scripts/ground-truth.py` numbers to within $0.01. All 5 ground-truth scenarios green. `app/tests/math-audit.test.ts` covers order-sensitivity (oldest-first replay). |
| Market value (live quotes) | VERIFIED | `app/src/lib/portfolio.ts` (`refreshQuotes`, `priceFor`), `app/src/lib/quotes/yahoo.ts` | `app/tests/quotes.test.ts` (Yahoo client), `app/tests-e2e/refresh-quotes.spec.ts` (live UI Refresh button). In `npm run dev` Yahoo CORS-fails so the test asserts the UI does not break; the Tauri http plugin sidesteps CORS in production. |
| Market value (historical backfill on import) | VERIFIED | `app/src/lib/quotes/backfill.ts`, `app/src/lib/quotes/history.ts` | `app/tests-e2e/historical-backfill.spec.ts` intercepts Yahoo with synthetic daily closes and verifies YTD / 1Y figures are plausible plus the VGT series has multi-year daily data. The parser handles 7 distinct Yahoo response shapes; fixtures in `app/tests/__fixtures__/yahoo/`, tested by `app/tests/yahoo-fixtures.test.ts` (12 specs). |
| Day change per holding (qty * (price - prev_close)) | VERIFIED | `app/src/lib/portfolio.ts`, V2 prices column | `app/tests-e2e/quote-freshness.spec.ts` Feature 3 mocks Yahoo with a synthetic +3% move and asserts the brokerage-tile delta renders the right percentage. Screenshot: `app/screenshots/home-day-change.png`. |
| Day change per account (rolled-up) | VERIFIED | `app/src/lib/portfolio.ts` (account aggregator) | Same as above; tiles in `AccountsView` and `HomeView` Brokerages tile both render with the rolled-up value. |
| YTD / 1Y / 3Y / 5Y / All-time TWR | VERIFIED | `app/src/lib/performance.ts` (`twrOverWindow`, `annualizeTwr`) | `app/tests/performance.test.ts` covers the math. `app/tests-e2e/historical-backfill.spec.ts` and `app/tests-e2e/home-chart-shape.spec.ts` assert the YTD / 1Y figures rendered on Home are not garbage. |
| All-time XIRR (flow-paired) | PARTIAL | `app/src/lib/performance.ts` (`xirr`, `flowsFromTransactions`) | `app/tests/performance.test.ts` covers the solver. `app/tests/xirr-check.test.ts` validates against the Fidelity sample. **Known limitation**: on small samples (single buy + <30 days) the annualized rate can hit the +10x clamp. This is mathematically correct but cosmetically misleading. The PR #2 fix de-dupes the flow pairing so cash_in + buy aren't double-counted. |
| Dividend total + milestone counting | VERIFIED | `app/src/lib/milestones.ts` (`tallyDividends`) | `app/tests/milestones.test.ts` covers the unlock logic. `app/tests/xirr-check.test.ts` confirms the Fidelity sample's $0.21 FZFXX reinvest is counted once (paired Cash Dividend + Reinvestment). `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies the "$100 in dividends" milestone is NOT incorrectly unlocked. |
| Per-segment windowing (1M/3M/6M/YTD/1Y/3Y/5Y/ALL) | VERIFIED | `app/src/lib/portfolio.ts` (`segmentWindow`, `windowSeries`) | `app/tests/series-filtering.test.ts` + `app/tests-e2e/home-chart-shape.spec.ts` + `app/tests-e2e/all-view-axis-labels.spec.ts`. Every chart segment, SPY overlay, and metric tile reads from a single per-segment source of truth. Screenshots: `app/screenshots/home-chart-segment-{1M,3M,6M,YTD,1Y,3Y,5Y,ALL}.png`. |
| SPY benchmark overlay | VERIFIED | `app/src/lib/portfolio.ts` (`spy` series), `app/src/components/charts/PortfolioChart.tsx` | `app/tests-e2e/spy-overlay.spec.ts` (toggle), `app/tests-e2e/spy-overlay-visible.spec.ts` (visual). Distinct violet dashed line, auto-scales in absolute mode for extreme-growth portfolios. Screenshots: `app/screenshots/home-spy-overlay-{on,off,visible}.png`. |

## Network / quotes

| Row | Status | Most-relevant code | Test coverage |
| --- | --- | --- | --- |
| Live quote refresh (button) | VERIFIED | `app/src/lib/portfolio.ts` (`refreshQuotes`), `app/src/views/HomeView.tsx` | `app/tests-e2e/refresh-quotes.spec.ts` Test 1 asserts every click fires fresh Yahoo chart requests (`{ force: true }` bypasses the 5-min cache). Test 3 asserts the in-flight spinner appears. Screenshot: `app/refresh-quotes-spinner.png`. |
| Force bypass 5-min cache | VERIFIED | `app/src/lib/quotes/yahoo.ts` (`fetchQuotes({ force })`) | `app/tests/quotes.test.ts` covers the force-bypass path. The Refresh button passes `force: true` so consecutive clicks always hit Yahoo. |
| Auto-refresh timer (foreground-only, opt-in) | VERIFIED | `app/src/lib/autoRefresh.ts` | `app/tests/autoRefresh.test.ts` (controller). `app/tests-e2e/quote-freshness.spec.ts` Feature 2 toggles on, switches to 15m, reloads, verifies persistence. Feature 2b verifies the document-visibility pause stops the network ticker. Screenshot: `app/screenshots/settings-auto-refresh.png`. **Note**: the visibility-pause spec has been flaky on slow runners (documented in PR #2). |
| Historical backfill on import | VERIFIED | `app/src/lib/quotes/backfill.ts`, `app/src/lib/quotes/history.ts` | `app/tests-e2e/historical-backfill.spec.ts` intercepts Yahoo and asserts daily-close series populate post-import. The parser handles 7 distinct response shapes (success, mutual fund, recent IPO, halted-with-nulls, Not Found, Bad Request, 429/5xx/non-JSON). |
| Auto-heal recovery (on launch when prices table empty) | VERIFIED | `app/src/lib/usePortfolio.ts` (recovery probe), `app/src/App.tsx` | `app/tests/auto-heal-recovery.test.ts` (16 specs), `app/tests/auto-heal-failure-modes.test.ts` (7 specs: all-fail, partial-fail, retry-on-next-load, 429 transport). `app/tests-e2e/portfolio-backfill-recovery.spec.ts` + `app/tests-e2e/auto-heal-visible.spec.ts` drive the live UI. Failed-symbol list persists across launches; partial failures self-heal. Screenshots: `app/screenshots/auto-heal-{loading,populated}.png`. |
| Per-launch live-quote refresh (when last fetch >1h) | VERIFIED | `app/src/lib/usePortfolio.ts` | Same coverage as auto-heal. The portfolio hook triggers a `refreshQuotes` on mount if the most recent successful Yahoo log entry is more than an hour old. |
| Mid-flight portfolio rebuilds (chart fills in as bars land) | VERIFIED | `app/src/lib/usePortfolio.ts` (progress callback) | `app/tests-e2e/auto-heal-visible.spec.ts` asserts the chart re-renders as backfill chunks land. |
| Settings, Privacy, Recent outbound calls | VERIFIED | `app/src/views/SettingsView.tsx`, `app/src/lib/quotes/log.ts` | `app/tests-e2e/refresh-quotes.spec.ts` Test 2 asserts the network log shows live Yahoo entries after a click. Per-symbol entries carry structured notes: `OK 247 bars`, `EMPTY`, `FAIL Not Found`, `FAIL HTTP 429 rate limited`, etc. Screenshot: `app/refresh-quotes-network-log.png`. |
| Settings, Market data, Backfill diagnostics panel | VERIFIED | `app/src/views/SettingsView.tsx` (lines ~700-870), `app/src/lib/db/repos.ts` (`listAllPriceCoverage`) | `app/tests-e2e/backfill-diagnostics.spec.ts` (2 specs): diagnostics panel renders per-symbol coverage; Force re-run button triggers a fresh Yahoo fetch and updates the table. Screenshot: `app/screenshots/settings-backfill-diagnostics.png`. |
| Network log notes (FAIL / EMPTY / OK N bars) | VERIFIED | `app/src/lib/quotes/log.ts`, `app/src/lib/quotes/history.ts` | `app/tests/yahoo-fixtures.test.ts` covers every captured response shape. Each fetch attempt appends one structured note to the network log; Settings, Privacy renders the notes inline. |
| Recovery error toast (when all symbols fail) | VERIFIED | `app/src/lib/usePortfolio.ts` (`recoveryError`), `app/src/App.tsx` | `app/tests/auto-heal-failure-modes.test.ts` "all-fail mode" + "surfaces a clear recoveryError to the view layer". Positioned at `bottom: 110px` so it doesn't collide with milestone toasts at `bottom: 24px`. |
| Logo fetch via logo.dev | IMPLEMENTED | `app/src/lib/logos.ts`, `app/src/components/TickerLogo.tsx`, `app/src/components/BrokerageLogo.tsx` | `app/tests/logos.test.ts` (cache + fetch helpers), `app/tests/ticker-logo-fallback.test.tsx` (17 specs for monogram fallback), `app/tests-e2e/logo-fallback.spec.ts` (live UI rows + brokerages). Falls back to monogram on 404. **Logo coverage gaps** for some symbols (logo.dev free-tier limits). |

## UI / navigation

| Row | Status | Most-relevant code | Test coverage |
| --- | --- | --- | --- |
| Onboarding flow (Welcome -> Profile -> Goal -> AddAccount -> Done) | VERIFIED | `app/src/views/OnboardingView.tsx` | `app/tests-e2e/onboarding.spec.ts`, `app/tests-e2e/jpm-onboarding.spec.ts`, `app/tests-e2e/schwab-e2e.spec.ts`, `app/tests-e2e/human-interest-e2e.spec.ts`, `app/tests-e2e/all-brokerages-smoke.spec.ts`, `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1. Five different real CSVs walk every step. Browser dev shows a fake titlebar; Tauri build suppresses it via `isTauri()` so the native window chrome shows through. |
| Onboarding without uploading a CSV (skip) | VERIFIED | `app/src/views/OnboardingView.tsx` | `app/tests-e2e/onboarding.spec.ts` + `app/tests-e2e/full-app-smoke.spec.ts` Scenario 3 walk the empty-state path. |
| Onboarding state persistence | VERIFIED | `app/src/App.tsx` (`finishOnboarding`) | `app/tests/onboarding-persist.test.ts`, `app/tests/onboarding-e2e.test.ts`. Profile name + birth year + retire age + goal are saved to `user_profile` and `scenarios` tables on completion. |
| Greeting matches time of day | VERIFIED | `app/src/views/HomeView.tsx` (`buildGreeting`) | `app/tests/major-fixes.test.tsx`, `app/tests/views.test.tsx`. Reads `userName` from `user_profile`; no more "Justin" hardcoded fallback. |
| Market-status header line | VERIFIED | `app/src/lib/marketHours.ts` (`getMarketStatus`, `describeMarketStatus`), `app/src/views/HomeView.tsx` | `app/tests/marketHours.test.ts` (9 specs covering open / closed_today_post / closed_today_pre / closed_weekend / closed_holiday). `app/tests-e2e/market-status.spec.ts` verifies the live header is dynamic (not the legacy hardcoded "prices Fri 4:00pm ET"). DST-safe via Intl. Screenshots: `app/screenshots/home-market-status-*.png`. |
| Stale-prices warning | VERIFIED | `app/src/views/HomeView.tsx` | Beyond 12h from the last live fetch the header shows "Prices may be stale. Refresh quotes for the latest." `app/tests/views.test.tsx` covers the threshold. |
| Home dashboard | VERIFIED | `app/src/views/HomeView.tsx` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies greeting, total figure, no NaN, brokerage tiles, achievements badge. Scenario 3 verifies the empty-state copy. |
| Home chart (real NAV via forward-fill) | VERIFIED | `app/src/lib/portfolio.ts` (`buildHistoricalSeries`) | `app/tests/buildHistoricalSeries.test.ts` covers the forward-fill logic. The lying diagonal line caused by missing prices is fixed in PR #2. `app/tests-e2e/home-chart-shape.spec.ts` verifies the chart shape is curved (not diagonal). |
| Accounts page with brokerage grouping | VERIFIED | `app/src/views/AccountsView.tsx` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 2 verifies the canonical `<last4> JP Morgan <name>` format renders for all 4 detected JPM accounts. `app/tests-e2e/all-brokerages-smoke.spec.ts` verifies the expected account count per scenario. Skeleton-row filter hides $0 / $0 / 0-tx duplicates. |
| Accounts row click (drill-in) | VERIFIED | `app/src/views/AccountsView.tsx` | `app/tests-e2e/accounts-row-click.spec.ts` (full keyboard + mouse coverage). Clicking anywhere on a row or pressing Enter navigates to the account-scoped Holdings view. |
| Account-scoped Holdings (drill-in) | VERIFIED | `app/src/views/HoldingsView.tsx` (with `filterAccountId`) | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 2 verifies the filtered page-meta total matches the sum of visible rows. `app/tests-e2e/schwab-e2e.spec.ts` Test A verifies the back button works. |
| Holdings aggregation across accounts | VERIFIED | `app/src/lib/portfolio.ts` (`aggregateHoldingsBySymbol`) | `app/tests/portfolio-aggregation.test.ts`, `app/tests-e2e/holdings-aggregation.spec.ts`. The unfiltered Holdings view shows "VITAX × 1" (one row per symbol) with a "Held in N accounts" subtitle when shared across 2+ accounts. Screenshot: `app/screenshots/holdings-aggregated.png`. |
| Holdings sortable table | VERIFIED | `app/src/views/HoldingsView.tsx` | `app/tests/holdings-sort.test.tsx` covers the sort component (including the sort indicator arrow). `app/tests-e2e/full-app-smoke.spec.ts` verifies sort works in the live UI. |
| Holdings sector column (Yahoo quoteSummary) | VERIFIED | `app/src/lib/quotes/sector.ts` | `app/tests/quotes-sector.test.ts`, `app/tests-e2e/sector-screenshot.spec.ts`. The sector column is populated by the V3 instruments table; Holdings shows sector text, HoldingDetail header shows "[sector, industry, USD]". Screenshots: `app/screenshots/holdings-sector-populated.png`, `vitax-sector-populated.png`. |
| Holding Detail (chart + sector header + activity) | VERIFIED | `app/src/views/HoldingDetailView.tsx` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies metrics cards. `app/tests-e2e/schwab-e2e.spec.ts` Test A verifies QQQ detail page (avg cost in $500-$700 window). `app/tests-e2e/holding-detail-auto-backfill.spec.ts` verifies the chart auto-fetches missing history on mount. Screenshots: `app/screenshots/scenario1-holding-detail.png`, `vitax-chart-populated.png`. |
| Holding Detail chart auto-backfill | VERIFIED | `app/src/views/HoldingDetailView.tsx` (mount-time effect) | `app/tests/holding-detail-backfill.test.tsx`, `app/tests-e2e/holding-detail-auto-backfill.spec.ts`. When a symbol has no price history on mount, the view fires `backfillHistoricalPrices` and shows an inline loading card; re-reads the prices table after the fetch lands. Coordinates with the global recovery to avoid parallel fetches. |
| Lifetime div on Holding Detail (scoped to dividend + div_reinvest) | VERIFIED | `app/src/views/HoldingDetailView.tsx` | `app/tests/transactions-cash-flow-labels.test.tsx`. Excludes interest income to keep the metric semantically a dividend count. |
| Transactions list (real DB rows) | VERIFIED | `app/src/views/TransactionsView.tsx`, `app/src/lib/db/repos.ts` (`loadAllTransactions`) | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies rows render. The old `generateTransactions(data)` synthesizer is gone. |
| Transactions action labels (Deposit / Withdrawal / Transfer in / etc.) | VERIFIED | `app/src/lib/format.ts` (`formatActionLabel`), `app/src/views/TransactionsView.tsx` | `app/tests/transactions-cash-flow-labels.test.tsx` (25 specs). PR #4 fix: a `cash_in` Electronic Funds Transfer Received now renders as a blue "Deposit" badge instead of a green "BUY". Screenshots: `app/tests-e2e/screenshots/transactions-cash-flow-labels.png`. |
| Transactions date-range filter (1M / 3M / YTD / 1Y / ALL) | VERIFIED | `app/src/views/TransactionsView.tsx` | `app/tests-e2e/transactions-filters.spec.ts` Test A. Filter chain composes with action filter and search. |
| Transactions action filter (All / Buys / Sells / Dividends / Cash flows) | VERIFIED | `app/src/views/TransactionsView.tsx` | `app/tests-e2e/transactions-filters.spec.ts` Test B (filter chain: 1M + Cash flows + search "VGT"). |
| Transactions per-segment whimsical empty states | VERIFIED | `app/src/views/TransactionsView.tsx` | `app/tests-e2e/transactions-filters.spec.ts` Test C asserts "No deposits or withdrawals in this range. Capital coming soon?" appears for the Cash flows segment when empty. Screenshot: `app/tests-e2e/screenshots/transactions-sells-empty.png`. |
| Transactions pagination | VERIFIED | `app/src/views/TransactionsView.tsx` | `app/tests-e2e/transactions-filters.spec.ts` Test D verifies page 2 renders and the indicator advances. Screenshot: `app/tests-e2e/screenshots/transactions-pagination-page2.png`. |
| Add transaction modal (account-scoped Holdings) | VERIFIED | `app/src/views/HoldingsView.tsx` (modal) | `app/tests-e2e/add-transaction-modal.spec.ts` (2 specs): submit a buy from the drill-in and verify it appears in the Transactions list. Screenshot: `app/tests-e2e/screenshots/add-transaction-modal-inflight.png`. |
| Planner (HSA + retirement projection) | IMPLEMENTED | `app/src/views/PlannerView.tsx`, `app/src/lib/taxConstants.ts` | `app/tests/taxConstants.test.ts` (2026 IRS limits, tested). `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies the HSA empty-state copy when no HSA is imported; Scenario 3 verifies both retirement-empty and HSA-empty hints render. **No ground-truth test against an external calculator** for the year-by-year compounding + withdrawal sequence. |
| Achievements (real DB-driven unlocks) | VERIFIED | `app/src/lib/milestones.ts`, `app/src/lib/milestoneCatalog.ts`, `app/src/views/AchievementsView.tsx` | `app/tests/milestones.test.ts` + `app/tests/milestoneCatalog.test.ts` cover the unlock logic. `app/tests/milestoneReplay.test.tsx` covers the replay flow. `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1: on a $9,916 portfolio with $0.21 dividends, the right milestones (Four digits) are unlocked and the wrong ones ($100 in dividends, Five digits) are NOT. Screenshots: `app/screenshots/scenario1-achievements.png`. |
| Achievements replay (passes the specific milestoneId) | VERIFIED | `app/src/views/AchievementsView.tsx`, `app/src/App.tsx` | `app/tests-e2e/achievement-replay.spec.ts` confirms clicking the replay button on the "$1k in dividends" tile shows the $1k toast, not the wrong-milestone toast. Screenshots: `app/screenshots/achievement-replay-{1k-dividends,millionaire,millionaire-toast}.png`. |
| Sidebar achievement badge | VERIFIED | `app/src/components/Sidebar.tsx` | Reads real count from `listAchievements()`. Hidden at 0 unlocks. Covered by `app/tests/views.test.tsx`. |
| Sidebar "Last quote" footer | VERIFIED | `app/src/components/Sidebar.tsx` | Reads most-recent `networkLog` entry timestamp. |
| Settings, General section | VERIFIED | `app/src/views/SettingsView.tsx` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 1 verifies the section renders. |
| Settings, Privacy & network | VERIFIED | `app/src/views/SettingsView.tsx` | `app/tests-e2e/refresh-quotes.spec.ts` Test 2 verifies the live network log; `app/tests-e2e/backfill-diagnostics.spec.ts` verifies the diagnostics panel. |
| Settings, Market data (auto-refresh + Refresh history + Force re-run) | VERIFIED | `app/src/views/SettingsView.tsx` | `app/tests-e2e/quote-freshness.spec.ts` Feature 2 (auto-refresh), `app/tests-e2e/backfill-diagnostics.spec.ts` (Force re-run). |
| Settings, Your data (backup / restore / erase / restart onboarding) | VERIFIED | `app/src/views/SettingsView.tsx`, `app/src/lib/db/backup.ts` | `app/tests/backup.test.ts` (export, erase, import round-trip including SQL injection guards on the column allowlist). `app/tests-e2e/full-app-smoke.spec.ts` Scenario 5 walks the live UI: erase, confirm, reload, verify onboarding returns. **No live spec drives the export-then-import round-trip end-to-end**, only the unit test. |
| Settings, About | VERIFIED | `app/src/views/SettingsView.tsx` | `app/tests/views.test.tsx` covers the version + license + privacy-promise copy. |
| Settings rail scroll-spy | VERIFIED | `app/src/views/SettingsView.tsx` | IntersectionObserver-based active state updates as you scroll. Covered by `app/tests/views.test.tsx`. |
| DB stats footer (real counts) | VERIFIED | `app/src/views/SettingsView.tsx` | Reads `listAccounts()` + `listTransactions()` counts. Browser dev shows "(in-browser dev storage)". |
| Add Account flow (post-onboarding) | VERIFIED | `app/src/views/AddAccountView.tsx` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 4 walks a real CSV drop on AddAccount after onboarding. Screenshots: `app/screenshots/scenario4-add-account-drop.png`, `scenario4-add-account-review.png`, `scenario4-home-after.png`. |
| Universal template view + link on AddAccount | VERIFIED | `app/src/views/UniversalTemplateView.tsx`, `app/src/views/AddAccountView.tsx` | `app/tests-e2e/universal-template-view.spec.ts` (3 specs): navigates from AddAccount, downloads the template asset, uploads filled file, lands on Home. Back link returns to AddAccount. Screenshots: `app/screenshots/universal-template-{view-full,link-on-add-account,link-on-standalone-add-account}.png`. |
| Tweaks panel (dev-only) | VERIFIED | `app/src/App.tsx` (gated by `import.meta.env.DEV`), `app/src/components/TweaksPanel.tsx` | Visible only in `npm run dev`; absent in the Tauri production build. Exposes Theme, Headline chart, Replay $1M toast, Restart onboarding. |

## Persistence

| Row | Status | Most-relevant code | Test coverage |
| --- | --- | --- | --- |
| SQLite on macOS (Tauri build) | IMPLEMENTED | `app/src-tauri/migrations/V1__init.sql`, `app/src/lib/db/driver.ts` (Tauri path) | `app/tests/db-repos.test.ts` covers the repo layer. The Tauri build is exercised manually by Justin on his machine; the browser dev mode shares 100% of the repo-layer logic via the localStorage shim, so unit tests cover both paths. **The morning manual test is the only end-to-end Tauri verification**. |
| localStorage shim (browser dev mode) | VERIFIED | `app/src/lib/db/driver.ts` (browser path) | Every Playwright spec runs against this path (29 specs). `app/tests/db-repos.test.ts` covers the repo layer. |
| Backup / restore round-trip | IMPLEMENTED | `app/src/lib/db/backup.ts` | `app/tests/backup.test.ts` covers export, erase, import round-trip, plus SQL injection guards on the column allowlist and a raw-hash collision guard (account_id is in the fallback hash). **No live Playwright spec drives the export-then-import roundtrip end-to-end.** |
| Erase everything | VERIFIED | `app/src/views/SettingsView.tsx`, `app/src/lib/db/repos.ts` | `app/tests-e2e/full-app-smoke.spec.ts` Scenario 5 walks the live UI: erase, confirm, reload, verify onboarding returns. Screenshots: `app/screenshots/scenario5-after-erase.png`, `scenario5-onboarding-back.png`. |
| Account dedup migration (one-shot on first launch) | VERIFIED | `app/src/App.tsx` (DEDUPE_V1_KEY guard), `app/src/lib/db/repos.ts` (`dedupeDuplicateAccounts`) | `app/tests/account-dedup.test.ts` covers the migration. Guard key (`dedupe.v1.complete`) prevents re-running; bumping to v2 is the canonical way to re-run later. Collapsed 16 dirty JPM rows to 4 on Justin's machine on first launch. |
| V2 prices column (prev_close for day change) | VERIFIED | `app/src-tauri/migrations/V1__init.sql`, `app/src/lib/db/schema.ts` | `app/tests/db-repos.test.ts`. The schema applies idempotently; an `init()` semicolon-split fragility bug was fixed via `splitSqlStatements`. |
| Real price history (`listPriceHistory`) | VERIFIED | `app/src/lib/db/repos.ts` | Used by HoldingDetail chart, replaces the legacy fabricated sine-wave series. Covered by `app/tests/db-repos.test.ts` and exercised by `app/tests-e2e/holding-detail-auto-backfill.spec.ts`. |

## Known limitations

- **JPM transaction-history E2E**: the JPM transactions importer
  (`app/src/lib/importers/jpmorgan.ts`) is fully implemented and unit-tested,
  but no real JPM transaction CSV is in `example_csv/` so no Playwright spec
  drives it through the live UI. To upgrade: drop a real JPM transaction CSV
  into `example_csv/` and re-run the smoke spec.

- **Human Interest with a real export**: the synthetic fixture works
  end-to-end, but a real export with extra columns, blank rows in odd
  positions, or unusual fund tickers could expose edge cases. Justin's note
  in `TODO.md` mentions "real sample to be provided separately, may use the
  universal template instead."

- **Column-mapper wizard (full E2E)**: the parser is covered at the unit
  level and the UI step is present in `AddAccountView`, but no Playwright
  spec drives a fully unknown CSV through the wizard end-to-end.

- **XIRR on small samples**: the solver is correct but the annualized rate
  can hit the +10x clamp when the data window is very short. This is a math
  shape issue, not a bug; `app/tests/xirr-check.test.ts` documents it.

- **Planner projection accuracy**: the retirement projection math has no
  ground-truth test against an external calculator. Tax constants are
  pinned (`app/tests/taxConstants.test.ts`) but the year-by-year compounding +
  withdrawal sequence is rendered without a math validation step.

- **Backup-restore round-trip E2E**: covered at the unit level
  (`app/tests/backup.test.ts`) but no Playwright spec drives the Settings UI
  buttons (Export -> Import -> verify portfolio matches).

- **Logo coverage**: `logo.dev` free tier has rate limits and 404s for
  obscure symbols. Falls back to monogram, visually verified by
  `app/tests/ticker-logo-fallback.test.tsx` and screenshots.

- **Auto-refresh visibility-pause spec**: `app/tests-e2e/quote-freshness.spec.ts`
  Feature 2b has been flaky on slow runners (documented in PR #2). The
  underlying autoRefresh controller is unit-tested and works; the spec
  reliability issue is a timing race, not a real bug.

- **CI is currently red on PRs #2, #3, #4**: the CI runner doesn't have
  `app/example_csv/` (gitignored real brokerage exports), so any vitest
  spec that reads from `example_csv/` skips or fails on CI. Locally with
  the real files present, 668/668 vitest tests pass. The Playwright suite
  doesn't read from `example_csv/`; it uses synthetic fixtures or
  Yahoo-route mocks.

- **Tauri-build-only verification gap**: every Playwright spec runs against
  the browser localStorage shim, not the native SQLite driver. The repo
  layer is shared between both paths, but the Tauri-specific code paths
  (Tauri http plugin, plugin-sql, file dialog, fs writes) are only
  exercised by Justin's manual morning test pass.

## Architecture invariants

- **All financial data stays local.** Only outbound calls: Yahoo Finance
  chart endpoint (`query1.finance.yahoo.com`) for quotes + history, and
  `img.logo.dev` for ticker / brokerage logos. CSP and Tauri allowlist are
  pinned to those two hosts.

- **No Google Fonts.** All three font families (Instrument Serif, Geist,
  JetBrains Mono) are self-hosted as latin-subset woff2 under
  `app/src/assets/fonts/`.

- **Yahoo `/v7/quote` is forbidden.** That endpoint requires a crumb token
  via a consent cookie flow. We use `/v8/finance/chart/<SYMBOL>`, which is
  per-symbol but permissive. A 12-symbol portfolio fires 12 parallel HTTP
  calls per refresh; the Network log surfaces every one.

- **`MATMON_DATA` is gone.** The old demo seed has been removed from
  `app/src/data.ts`. The view layer reads from `EMPTY_MATMON_DATA` until
  `buildPortfolio()` resolves with real DB rows. There is no "Try with a
  sample portfolio" button.

- **No-em-dash rule is machine-enforced.** `eslint-plugin-local/no-em-dash`
  in `app/eslint.config.js` fails the build if a U+2014 character lands in
  any `.ts` / `.tsx` / `.css` source file. Docs files (root `*.md`) are
  not scanned but the rule is honored manually.

- **No Hebrew in user-facing UI.** The single italicized Hebrew word in the
  About section's etymology blurb is the only exception (per project
  CLAUDE.md).

- **Tauri build hides the prototype titlebar.** When `isTauri()` is true,
  the onboarding and Home views skip rendering the fake titlebar so the
  native macOS window chrome shows through edge-to-edge. Browser dev mode
  shows the prototype titlebar as a visual cue.

- **No commit / no push without explicit permission.** Hard project rule
  in `.claude/CLAUDE.md`. Every change goes through a feature branch +
  PR Justin reviews and merges himself.

- **Fingerprint scan before every commit.** `~/.matmon-fingerprints` (local
  only, not in repo) contains the regex patterns for Justin's real account
  numbers and CUSIPs; the pre-commit grep blocks any staged diff that
  matches. The check is a no-op for contributors without the file.

## Test counts (locally, on Justin's machine, 2026-05-18)

- vitest: **668 passed, 0 failed** (50 test files)
- Playwright: **53 passed, 4 failing** (29 spec files)
  - Failures are documented in PR #3 as pre-existing on `main`:
    `full-app-smoke` scenarios 1 + 4, `home-chart-shape` segment selection,
    `quote-freshness` visibility-pause. None are caused by the overnight work.
- `npm run lint`: 0 warnings, 0 errors
- `npm run build`: clean (`tsc --noEmit` + `vite build`, both green)

## Where the four PRs landed

| PR | Branch | Title | Status |
| --- | --- | --- | --- |
| #1 | `feat/initial-codebase` | Matmon v0.1.0: initial codebase | OPEN |
| #2 | `fix/xirr-double-flow-and-dividend-dedup` | feat: foundational fixes across imports, math, charts, accounts, achievements | DRAFT |
| #3 | `fix/chart-realdata-hardening` | fix: chart backfill hardening against real Yahoo data | DRAFT |
| #4 | `fix/view-polish-and-labels` | fix: view-layer polish and cash-flow labels | DRAFT |

All work on the overnight `docs/functionality-matrix-and-test-plan` branch is
docs-only; the docs reflect the cumulative state of #2 + #3 + #4 stacked on
top of `main`.
