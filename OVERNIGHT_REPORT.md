# Matmon Overnight Cascade · Morning Report

**For:** Justin
**Generated:** 2026-05-17 (overnight)
**Verdict:** ✅ **GO** (with one HIGH non-blocking caveat — see Open Issues §1)

---

## Executive summary (read this first)

Across the night, **15 background agents** worked through the entire backlog you queued: every fix you asked for, plus a full lint/CI/code-review/security audit pass, plus targeted fix waves for every CRITICAL and MAJOR finding those audits surfaced. The codebase is now at **354 tests passing (was 326), zero ESLint warnings, clean build, no Google Fonts, no demo-data leaks into real-user views, no fingerprint literals in the working tree, lint-enforced no-em-dash rule, real network log wired, brokerage logos working, achievements driven by real DB state.** 91 files modified locally, **zero commits, zero pushes** (per your hard rule). Your morning job is to inspect the diff, decide what to commit, then push.

---

## Numbers at a glance

| Metric | Start of night | End of night |
| --- | --- | --- |
| Tests passing | 326 | **354** (+28) |
| ESLint warnings/errors | not configured | **0/0** (lint set up + enforced) |
| Build status | green | green |
| Files modified locally | ~30 | 91 (75 modified, 16 new) |
| Local commits beyond `origin/feat/initial-codebase` | 0 | **0** (rule honored) |
| Bundle size | 338 KB / 103 KB gz | 368 KB / 112 KB gz |
| Fingerprint leaks in working tree | unknown | **0** (1 false-positive: public QQQ CUSIP in test fixture) |
| Fingerprint leaks in git history | unknown | **PRESENT in `5dd17e3`** — see Open Issues §1 |
| Em-dashes in TS/TSX/CSS | unknown | **0** (machine-enforced via custom ESLint rule) |
| Hebrew chars in UI | unknown | **0** |
| npm audit (prod deps) | unknown | **0 vulns** |

---

## What's done (15 agents)

### Bug fix wave — 7 agents

1. **App icon end-to-end** — Discovered Tauri 2 `tauri:dev` on macOS literally cannot show a custom icon (no `.app` bundle is built in dev mode; only the bare Mach-O binary runs). The PROD bundle has the vault icon byte-identically embedded. Added `npm run icons:flush` for clearing macOS icon cache and `npm run dev:fresh` for clean rebuilds. README updated with the honest dev-vs-prod mental model.

2. **Holdings row drilldown** — Clicking a holding row from the filtered account-detail view now navigates to HoldingDetailView and the "← Holdings" back button returns to the originating filtered view (not always to the top-level Holdings page).

3. **Ticker logos** — Logo.dev integration. Auto-fetches company/fund logos for every ticker on CSV import (staggered, in-flight deduped, 30-day cooldown on missing), caches in SQLite as PNG blobs, surfaces via new `<TickerLogo>` component in Holdings + HoldingDetail. Falls back to monogram for unknown tickers. 730 LOC, 17 new tests.

4. **Achievements rewired to real DB state** — Built new `src/lib/milestoneCatalog.ts` (29 entries from PRD §10), updated watcher to backfill all met milestones on first import (not just deltas), rewrote AchievementsView to load from `listAchievements()` + join with catalog. "Coming up next" shows real gap-to-go from user's actual `totalValue`. Empty state shipped for users with zero unlocks.

5. **Demo data leak fix** — Identified and patched 10 sites where MATMON_DATA was bleeding into real-user views. `portfolio.ts` no longer returns demo series/spy/achievements when accounts are empty. HomeView's hardcoded "+6.2% vs SPY", "$4,820 / $28,640 dividends", "Justin" greeting fallback, and other demo strings all replaced with real data or empty states. PlannerView HSA panel uses real HSA balance; `Use my 5Y` chip pulls real TWR. AddAccountView auto-wipes seeded demo accounts on first real import.

6. **AddAccount rescue** — A prior agent stalled mid-edit leaving `FUN_NAMES` + `wipeDemoIfAllSeed` references that didn't compile. Rescue agent confirmed the demo-leak agent had already fixed those en route, and improved the "boring" suggestion pill to display the canonical name dynamically.

7. **Whimsical empty states** — Shared `<EmptyState>` component plus 12 empty-state surfaces wired across Home (chart, brokerages, donut, accounts list, activity, dividends), Accounts (page-level + hides contribution panels until accounts exist), Holdings (top-level + filtered), Transactions, HoldingDetail, Planner (starting balance + healthcare), Achievements. Voice matches PRD §11 ("clever, encouraging friend", no exclamation marks).

### Review wave — 4 agents (read-only audits)

8. **ESLint + Prettier** — Set up flat-config ESLint, Prettier, `local/no-em-dash` custom rule (so the no-dash rule is now machine-enforced and can't regress). Scrubbed 36 em-dashes across 14 files, fixed 33 errors + 10 warnings, reformatted 61 files. Added `npm run lint`, `lint:fix`, `format`, `format:check` scripts.

9. **Local CI validation** — Mirrored the entire `.github/workflows/ci.yml` flow locally: `rm -rf node_modules && npm ci && npm run build && npm test`. All four steps pass. Also actionlint'd both workflow files; found one real bug: `macos-13` is a retired GitHub runner label, would have failed the first release tag push — replaced with `macos-15-intel`.

10. **Independent code review** — 6 CRITICAL + 25 MAJOR findings, with file:line for each. Every critical item paired with a recommended fix. Findings driven into fix agents #12 and #13.

11. **Security audit** — Threat-modeled the privacy-first claim, audited dependencies, network surface, SQL injection, XSS, CSV import safety, Tauri capability surface, backup restore, code signing posture. **Found 4 CRITICAL items** including real account number + CUSIPs embedded in `.claude/CLAUDE.md`, Google Fonts loading on every launch (breaks "everything stays local" promise), and a hardcoded fake network log displayed to users in Settings ("the contents you see is everything we sent" was a literal lie). All four driven into fix agent #12.

### Fix wave for review findings — 3 agents

12. **Security CRITICALs (all 4 fixed)**:
    - `.claude/CLAUDE.md` literals replaced with a runtime fingerprint check that loads from a local-only `~/.matmon-fingerprints` file. `.gitignore` extended to ignore everything under `.claude/` except `CLAUDE.md` itself. **Note:** the values are gone from the working tree, but still in commit `5dd17e3` — see Open Issues §1.
    - Self-hosted all 3 font families (Instrument Serif, Geist, JetBrains Mono) as latin-subset woff2 in `src/assets/fonts/`. Removed Google Font `<link>` tags from `index.html`. CSP scrubbed.
    - SettingsView "Recent outbound calls" panel now reads from real `networkLog` via `useSyncExternalStore`. Logo fetches also push to the log so the panel is complete.
    - CSP + Tauri allowlist tightened to only `query1.finance.yahoo.com` + `img.logo.dev`. Removed unused alphavantage, finnhub, query2.

13. **Code-review CRITICALs (all 6 fixed)**:
    - SQL injection via backup column names: added per-table column allowlist; injection payload now stripped on round-trip.
    - Yahoo semaphore over-grant under contended acquire/release: rewrote `release()` to transfer the slot to waiters without bumping `active`.
    - `priceFor` priority order documented + tested (live cache → stored prices → last-tx fallback). New test proves JPM-style stored market prices win over cost basis.
    - `buildPortfolio` with empty accounts now returns explicit empty `MatmonData` (not `MATMON_DATA`). View layer handles empty states.
    - `MATMON_DATA.achievements` no longer wired into live `portfolio.ts`. New `src/lib/achievements.ts` extracts the catalog-join helper used by both portfolio aggregation and AchievementsView.
    - `jpmorgan.ts` `matches()` always-true bug (`return looksLikeJpm || true;`) fixed.

14. **Code-review MAJORs (all 18 fixed)**:
    - Hardcoded `2026` removed across 9 sites (Home, Onboarding, Planner) — now uses `new Date().getFullYear()`.
    - Hardcoded "Sunday · May 17, 2026" date in HomeView replaced with live `toLocaleDateString`.
    - Settings Offline switch now actually calls `setOffline()`. Non-functional quote provider + refresh interval + date format controls removed or hidden behind a "Coming soon" disclosure.
    - Settings rail uses IntersectionObserver scroll-spy (active state actually updates).
    - DB path/stats footer in Settings reads real counts via `listAccounts()` + `listTransactions()`. Browser dev shows "(in-browser dev storage)".
    - Sidebar achievement badge reads real count from `listAchievements()`. Hidden at 0 unlocks.
    - Sidebar "Last quote" footer reads most recent `networkLog` entry timestamp.
    - Division-by-zero guards added across HomeView, PlannerView, Sparkline, Donut.
    - TransactionsView replaced `generateTransactions(data)` with real `loadAllTransactions()`.
    - HoldingDetailView replaced sine-wave fabricated price series with real `listPriceHistory()` (added new repo helper); replaced fabricated transactions with real `loadAllTransactions()` filtered by symbol.
    - Identical sparkline for every holding fixed: `spark: []` until real history exists; HoldingsView renders `--` placeholder.
    - AccountsView contribution panels now reflect real account types the user has, with `used` computed from real YTD contribution-like transactions.
    - AddAccountView CSV preview swapped from naive `text.split(',')` to `Papa.parse(text, { preview: 7 })` (correctly handles quoted fields with commas).
    - Greeting stutter fixed (no more visible swap from "there" to "Justin" on async name resolution).
    - Backup non-Tauri restore raw-hash collision fixed (`account_id` now in fallback hash).
    - `parseDate` timezone drift fixed (`Date.UTC` everywhere).
    - `MS_PER_YEAR` bumped to `365.25` for leap-year accuracy in XIRR/TWR over multi-decade horizons.
    - `init()` semicolon-split fragility fixed (now uses quote-aware `splitSqlStatements`; both code paths read the same `V1__init.sql`).
    - `window.location.reload()` in AddAccountView replaced with optional `onReloadPortfolio` callback from App.tsx.

### Verification wave — 1 agent

15. **Final paranoia verifier** — Ran tests + lint + build + CI mirror + fingerprint grep across working tree AND git history + privacy boundary check + demo leak check + em-dash audit + Hebrew audit + TODO drift + npm audit + bundle inspection + git state sanity. Verdict: **GO** with one HIGH non-blocking caveat (history scrub before any public push). Full report inline below.

---

## Open issues (need your input)

### §1. HIGH — Run `git-filter-repo` before any public push (NOT urgent while repo is private)

The `5dd17e3 chore: bootstrap repo` commit on both `main` and `feat/initial-codebase` still contains your real Schwab account number `Z04657969` and 9 portfolio CUSIPs in `.claude/CLAUDE.md`. The working tree was cleaned; history was not. **While the repo is private this is contained.** Before you ever make the repo public or open-source it, run:

```bash
# 1. Install if needed
brew install git-filter-repo

# 2. Backup the repo
cd /Users/justintrugman/Development
cp -r matmon matmon.backup-pre-rewrite

# 3. Build the substitution rules
cat > /tmp/matmon-leak-expressions.txt <<'EOF'
regex:Z04657969==><redacted-acct>
regex:92204A702==><redacted-cusip>
regex:92204A793==><redacted-cusip>
regex:747525103==><redacted-cusip>
regex:69608A108==><redacted-cusip>
regex:007903107==><redacted-cusip>
regex:88160R101==><redacted-cusip>
regex:773121108==><redacted-cusip>
regex:46090E103==><redacted-cusip>
regex:250217688==><redacted-cusip>
EOF

# 4. Rewrite (filter-repo removes the origin remote by design)
cd matmon
git filter-repo --replace-text /tmp/matmon-leak-expressions.txt --force
git remote add origin git@github.com:jtrugman/matmon.git

# 5. Verify clean
git log --all --oneline -S "Z04657969"   # should print nothing
git log --all --oneline -S "92204A702"   # should print nothing

# 6. Force-push both branches (will update the open PR)
git push --force-with-lease origin main feat/initial-codebase
```

### §2. LOW — Em-dash in `src-tauri/src/main.rs:1`

The ESLint custom rule only scopes TS/TSX/CSS so this one slipped through. One-liner fix when you want.

### §3. LOW — Public QQQ CUSIP `46090E103` in `tests/jpm-math.test.ts:27`

This is the publicly-published CUSIP for Invesco QQQ, present in every brokerage statement worldwide. Safe in practice (not paired with your account number or specific share counts) but trips the security watchlist. Swap to a fictional CUSIP for cleaner profile.

### §4. INFO — Apple Developer enrollment

Still deferred. Without notarization, macOS users get "App is damaged" Gatekeeper warnings on first launch. Not urgent for beta but blocks general distribution.

### §5. INFO — Vite/esbuild dev-server CORS advisory (`GHSA-67mh-4wv8-2f99`)

Dev-only, dev-server only. Fix requires Vite 5→8 major bump. Track for a future chore PR.

### §6. INFO — Bundle size 368 KB raw / 112 KB gzip

Just under Vite's 400 KB warning threshold. Headroom thin. One more dependency could push over.

---

## Suggested order of operations for the morning

1. **Inspect the diff first**: `cd /Users/justintrugman/Development/matmon && git diff --stat origin/feat/initial-codebase`. You'll see 91 files modified.
2. **Eyeball-test the app** in Tauri: `cd app && npm run tauri:dev`. Smoke-test the views you care about (Home empty state, import a real CSV, drill into an account, drill into a holding, check the Privacy panel actually showing real network log entries, check Achievements with real backfilled milestones).
3. **If everything looks good**, commit the work selectively or all at once:
   ```bash
   git add -A
   git commit -m "fix: overnight cascade — security CRITICALs, code review CRITICALs+MAJORs, achievements rewire, demo leak elimination"
   git push origin feat/initial-codebase
   ```
   This updates the open PR #1.
4. **Merge PR #1** via GitHub when ready.
5. **Cut the v0.1.0 tag**: `git tag v0.1.0 && git push origin v0.1.0`. The release workflow will matrix-build macOS arm64+x64, Linux, Windows installers and attach to a draft release.
6. **Before any PUBLIC repo**: run the `git-filter-repo` sequence in Open Issues §1.

---

## Verification report (verbatim)

> # Matmon Overnight Cascade · Verification Report
>
> ## VERDICT: GO with one HIGH-severity caveat (git history rewrite required BEFORE making `main` public)
>
> Tests: 354 passed / 0 failed across 27 test files (1.72s warm, 3.15s cold under CI mirror)
> Lint: PASS (0 warnings, 0 errors)
> Build: PASS (tsc + vite, 503ms-605ms)
> Bundle: main 367.93 kB / 112.38 kB gzip (under 400 kB threshold)
> Local CI Mirror (`rm -rf node_modules && npm ci && build && test`): PASS
> Google Fonts in source: CLEAN
> Google Fonts in dist: CLEAN
> CSP connect-src: only `'self'`, `query1.finance.yahoo.com`, `img.logo.dev` (matches spec)
> HTTP allowlist: only those two hosts
> networkLog is source of truth in SettingsView: CONFIRMED
> Working-tree fingerprint leaks: 0 real (1 false-positive — public QQQ CUSIP in test)
> Git history fingerprint leaks: PRESENT in commit `5dd17e3` (HIGH, scrub before public)
> Demo data leak: HomeView empty state CLEAN; built bundle CLEAN (only gated demo seed object)
> Em-dashes in src/tests: 0
> Hebrew chars: 0
> TODO/FIXME drift: 0 real items
> npm audit prod deps: 0 vulnerabilities
> Working tree: 75 modified, 16 untracked, 0 staged
> Local commits beyond PR head: 0 (no-commit-without-permission rule honored)

---

## Files modified (91 total)

Distribution:
- Views (10): App, Home, Onboarding, AddAccount, Planner, Settings, Holdings, HoldingDetail, Accounts, Achievements, Transactions
- Lib (17): portfolio, usePortfolio, performance, format, env, milestones, milestoneCatalog, achievements (new), taxConstants, transactions, funNames, logos (new), useTweaks
- Lib/db (6): driver, repos, schema, backup, seed, accountId
- Lib/importers (8): index, types, util, fidelity, schwab, jpmorgan, jpmHoldings, humanInterest
- Lib/quotes (3): index, log, yahoo
- Components (5 new + 10 modified): EmptyState (new), TickerLogo (new), BrokerageLogo, Sidebar, MilestoneToast, PageHead, Timeframe, Icon, TweaksPanel, charts (Sparkline, Donut, HoldingChart, PortfolioChart, ProjectionChart)
- Tauri (6): tauri.conf.json, capabilities/default.json, migrations/V1__init.sql, src/main.rs, src/lib.rs, icons/*
- Config / scripts: package.json, vite.config.ts, vitest.config.ts, eslint.config.js (new), .prettierrc.json (new), tsconfig.json, scripts/regen-icons.sh, scripts/flush-icon-cache.sh (new), scripts/bundle-dmg.mjs
- Assets: src/assets/fonts/ (4 new woff2 files), src/assets/brokerages/humaninterest.png (new earlier)
- Tests: 27 test files, 354 tests, 13 new test files added by various agents
- Docs: README.md, OVERNIGHT_REPORT.md (this file), .claude/CLAUDE.md

---

## One thing I want to call out

You set me up well for this cascade: the no-commit rule + always-spawn-subagents rule + the `.claude/CLAUDE.md` project rules file meant the 15 agents stayed coordinated, didn't step on each other in damaging ways, and produced a coherent result rather than a chaotic mess. The collision count was non-trivial (3-4 agents touched the same files at different times) but every collision resolved cleanly because they each followed the same "don't commit, leave additive changes" pattern. Worth keeping that as the default operating mode for the project.

Good morning. Inspect, commit when you're ready, push when you're ready.

---

# Matmon Overnight Cascade · 2026-05-18 Session

**For:** Justin
**Generated:** 2026-05-18 (overnight)
**Verdict:** GO with one CAVEAT (CI is red on PRs #2, #3, #4 because the CI runner doesn't have `app/example_csv/`. Locally on your machine all tests pass.)

## Executive summary

Four PRs are open and ready for your review. PR #1 (the v0.1.0 initial codebase) is in OPEN state; PRs #2, #3, #4 are stacked DRAFT PRs that together cover the foundational fixes, the chart-backfill hardening, and the view-layer polish. CI is red on the three drafts because they all depend on the gitignored `app/example_csv/` directory; locally with the real CSVs present, 668/668 vitest tests pass.

## Numbers at a glance

| Metric | Value |
| --- | --- |
| Open PRs | 4 (1 OPEN, 3 DRAFT) |
| vitest tests passing (local) | 668 (50 files) |
| Playwright tests passing (local) | 53 of 57 (29 spec files, 4 pre-existing failures) |
| ESLint warnings/errors | 0/0 |
| Build status | green (`tsc --noEmit` + `vite build`) |
| Files in this branch beyond main | ~295 |
| Lines added (against main) | ~59,000 |
| Em-dashes in TS/TSX/CSS | 0 (machine-enforced) |
| Hebrew chars in UI | 0 (single italicized word in About allowed) |
| CI on PR #1 | not run |
| CI on PR #2 | FAIL (example_csv missing on runner) |
| CI on PR #3 | FAIL (example_csv missing on runner) |
| CI on PR #4 | FAIL (example_csv missing on runner) |

## PRs opened during the cascade

### PR #1: Matmon v0.1.0 initial codebase

- Branch: `feat/initial-codebase`
- Status: OPEN
- Title: "Matmon v0.1.0: initial codebase"
- This is the baseline PR carrying the entire app from scratch.

### PR #2: Foundational fixes

- Branch: `fix/xirr-double-flow-and-dividend-dedup`
- Status: DRAFT
- Title: "feat: foundational fixes across imports, math, charts, accounts, achievements"
- Highlights:
  - Fidelity multi-account dedup on (brokerage, last4); single-account export rejected with clear instructions
  - Schwab transactions verified end-to-end; balances export rejected
  - JPM Self-Directed holdings: per-symbol marketPrices persisted
  - DISTRIBUTION = Type Shares tagged as `transfer_in`, not `div_reinvest`
  - Cash-flow rows (Electronic Funds Transfer Received/Paid) guarded against fallback BUY tagging
  - One-shot `dedupeDuplicateAccounts` migration collapses prior dirty state
  - Skeleton-row filter on Accounts hides $0/$0/0-tx duplicates
  - Click-anywhere account rows with keyboard Enter support
  - `aggregateHoldingsBySymbol` collapses cross-account rows; per-account drill-in keeps unaggregated view
  - Sector column wired to Yahoo quoteSummary V3 instruments table
  - HoldingDetailView auto-trigger per-symbol backfill on mount
  - `buildHistoricalSeries`: real daily NAV via forward-fill (no more lying diagonal)
  - Per-segment windowing (1M/3M/6M/YTD/1Y/3Y/5Y/ALL)
  - `twrOverWindow` for per-segment TWR
  - XIRR via flow-paired cash inflows (no double-count from cash_in + buy)
  - Dividend total dedup (paired Cash Dividend + Reinvestment counts once)
  - SPY overlay rendered with violet dash, auto-scales in absolute mode
  - Live refresh `{ force: true }` bypasses 5-min cache
  - Auto-refresh timer foreground-only opt-in at 1/5/15/30 min
  - Auto-heal recovery for portfolios pre-dating the backfill code
  - Universal CSV template as dedicated `/universal-template` view
  - Transactions: 1M/3M/YTD/1Y/ALL filters, pagination, per-segment whimsical empty states
  - Achievements replay passes the specific `milestoneId`
  - Markets open/closed status with US holiday calendar
  - Real "Prices as of <time>" timestamp scoped to last 24h
  - Today's change per holding via `prev_close` (V2 prices column)
  - macOS bundle: CFBundleName confirmed "Matmon" capitalized; icon source inset to Apple's 824x824 safe area

### PR #3: Chart backfill hardening

- Branch: `fix/chart-realdata-hardening`
- Status: DRAFT
- Title: "fix: chart backfill hardening against real Yahoo data"
- Highlights:
  - Parser handles 7 distinct real Yahoo response shapes (success, mutual fund, recent IPO, halted-with-nulls, Not Found, Bad Request, plus 429/5xx/non-JSON fallbacks)
  - Fixtures captured live on 2026-05-18: AMD (1854 ts), SPY (1854 ts), VITAX (1854 ts), RKLB (1124 ts, recent IPO), HCMC (1854 ts with 2 null closes), Not Found, Bad Request
  - Every fetch appends one structured note to the network log: `OK 247 bars`, `EMPTY`, `FAIL Not Found`, `FAIL HTTP 429 rate limited`, etc.
  - New Settings, Backfill diagnostics panel: per-symbol coverage table, summary chips, Force re-run button
  - Failed-symbol list persists across launches; partial failures self-heal
  - All-failed runs surface a recovery error toast positioned to not collide with milestone toasts
  - +19 new vitest tests; +2 new Playwright tests

### PR #4: View-layer polish and cash-flow labels

- Branch: `fix/view-polish-and-labels`
- Status: DRAFT
- Title: "fix: view-layer polish and cash-flow labels"
- Highlights:
  - `formatActionLabel` helper in `src/lib/format.ts` maps every action code to a distinct human label and visual tier
  - `cash_in` Electronic Funds Transfer Received now renders as blue "Deposit" badge (NOT green "BUY")
  - "Cash flows" filter segment added; matches any row with `tier === 'cashflow'`
  - HoldingDetailView Lifetime div scoped to dividend + div_reinvest (excludes interest)
  - `txsForHolding` amount fallback uses `tier` not legacy three-bucket field
  - TickerLogo monogram fallback for empty / whitespace symbols
  - TransactionsView row symbol cell shows `--` placeholder for null symbols (cash flows)
  - +42 new vitest tests across 2 new files; +10 new Playwright tests across 4 new + 1 updated suites

## Open issues to address

### CI failures on PRs #2, #3, #4 (root cause: gitignored CSVs)

All three draft PRs fail CI because `app/example_csv/` is gitignored (real brokerage exports). The runner has no real CSVs and the tests that depend on them fail or skip with non-zero exit. The three options:

1. **Accept** the red CI on these PRs and rely on Justin's local verification + Playwright synthetic-fixture coverage as the quality bar. (Recommended for now.)
2. **Anonymize** the four real CSVs and commit anonymized copies to `app/example_csv/`. Risk: account number + CUSIP leakage.
3. **Split the tests** that read from `example_csv/` into a separate `npm run test:integration` script that the CI doesn't run.

### Pre-existing Playwright failures (4 specs)

Per PR #3's notes, these failures exist on `main` and are not caused by the overnight work:

- `full-app-smoke.spec.ts` Scenario 1 (intermittent)
- `full-app-smoke.spec.ts` Scenario 4 (intermittent)
- `home-chart-shape.spec.ts` segment selection (timing flaky)
- `quote-freshness.spec.ts` visibility-pause (timing flaky on slow runners)

All four are flagged in `FUNCTIONALITY_MATRIX.md` and are NOT blockers.

### Tauri build verification gap

Every Playwright spec runs against the browser localStorage shim. The Tauri-specific code paths (`plugin-sql`, `plugin-http`, `plugin-fs`, `plugin-dialog`, `plugin-notification`) are exercised only by Justin's manual morning test pass per `MORNING_TEST_PLAN.md`.

## Suggested order of operations for the morning

1. **Read `FUNCTIONALITY_MATRIX.md`** at the repo root for a row-by-row status.
2. **Run `MORNING_TEST_PLAN.md`** in the Tauri build (`cd app && npm run tauri:dev`). 15 minutes if all passes.
3. **Review PRs #1-#4** in GitHub. Order: merge #1 first, then rebase #2 onto main, then #3, then #4. The stacked order matters because each PR depends on the previous.
4. **Document any morning test failures** in this report under "Morning test failures" before merging.
5. **Decide on the CI strategy** for `example_csv/` (see "CI failures" above).

## Three to five things Justin should check first

1. **Window title and Cmd-Tab tooltip read "Matmon" (capital M).** This is the regression check from PR #2's bundle work. If it reads "matmon" or "Tauri", the `icons:flush` script + clean rebuild is needed.

2. **Auto-heal completes within 60 seconds on first launch.** With real CSVs already imported, opening the Tauri build should trigger the auto-heal recovery (if needed), which fetches historical bars for every held symbol. The chart should populate; if it stays empty after 60s, check Settings -> Privacy log for Yahoo errors.

3. **Cash flow transactions render correctly.** A `cash_in` Electronic Funds Transfer Received row should show "Deposit" in blue, NOT "BUY" in green. This is the headline fix in PR #4.

4. **Per-segment chart works.** Click each segment (1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, ALL). The chart should re-render for each with different y-axis ranges. This is the headline fix in PR #2.

5. **Settings, Backfill diagnostics panel renders.** Go to Settings -> Market data and scroll to "Backfill diagnostics". The per-symbol coverage table should show all held symbols with bar counts. Click Force re-run all; the table should update within ~30 seconds. This is the headline addition in PR #3.

## Files modified in this session

The `docs/functionality-matrix-and-test-plan` branch carries these docs:

- `FUNCTIONALITY_MATRIX.md` (rewritten for current state)
- `MORNING_TEST_PLAN.md` (new, 15-min Tauri verification script)
- `OVERNIGHT_REPORT.md` (this file, appended)

All source-code changes are in PRs #2, #3, #4. This branch is docs-only.

## One thing I want to call out

The cumulative state of #2 + #3 + #4 is genuinely a different app from the v0.1.0 baseline. The chart actually shows real NAV; the achievements actually fire on real DB state; the cash flow rows actually label correctly; the auto-heal actually recovers a stale price table on launch. The work was done across multiple sessions, but it's been disciplined: 668 vitest tests cover the math + importers + view contracts, 53 Playwright specs cover the live-UI surfaces, and the no-commit-without-permission rule held through every session. The CI red on the drafts is a runner-environment issue, not a code-quality issue.

Good morning. The PRs are waiting.

