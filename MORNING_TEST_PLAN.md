# Matmon Morning Test Plan

Run after: `cd app && npm run tauri:dev` (or open the built `.app`)
Expected time: 15 minutes
Last updated: 2026-05-18 (overnight session)

This is a brutally honest manual pass to verify the Tauri build matches what
the Playwright suite proves in the browser. Everything below is something
that worked in headless Chromium against the localStorage shim; the unknown
is whether the native SQLite driver, Tauri http plugin, and macOS window
chrome behave the same way. Each test has explicit PASS/FAIL criteria.

If any step fails: take a screenshot, drop it in `app/screenshots/morning/`,
note the test number, and flag it in the OVERNIGHT_REPORT.md "Issues" section.

## Pre-flight (1 minute)

1. Quit any running Tauri instances. In macOS dock: right-click Matmon, Quit.
2. Activity Monitor: kill any stale `node` or `matmon-tauri` processes.
3. `cd /Users/justintrugman/Development/matmon/app && npm run tauri:dev`
4. Wait for the Matmon window to open (first compile takes ~20s, subsequent
   ~3s).

If the window doesn't open within 60 seconds:
- Check the terminal for Rust compile errors.
- Try `cd app && npm run dev:fresh` (clears cargo cache, full rebuild).

## Test 1: Window chrome and Cmd-Tab tooltip (1 minute)

This is a regression check from PR #2 ("CFBundleName confirmed Matmon
capitalized").

Verify:
- [ ] The window title bar reads "Matmon" (capital M).
- [ ] Cmd+Tab tooltip reads "Matmon" (capital M).
- [ ] The window does NOT show the fake titlebar with the red/yellow/green
      traffic-light dots from the browser dev mode. The native macOS chrome
      shows through.
- [ ] The app icon in the dock is the Matmon vault icon (concentric
      pentagons, slate-blue + cream), not the default Tauri icon.

If FAIL on window title: re-run `cd app && npm run icons:flush` then quit and
relaunch the app. macOS aggressively caches the Cmd-Tab tooltip; the flush
script clears that cache.

If FAIL on dock icon: the .app bundle wasn't rebuilt cleanly. Run
`npm run dev:fresh`. Note that Tauri 2 dev mode on macOS can't show a custom
icon (no `.app` bundle is built in dev mode; only the bare Mach-O binary
runs). To verify the icon, run `npm run tauri:build` and launch the built
`.app` from `app/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`.

## Test 2: Home loads with auto-heal (2 minutes)

If this is your first launch with real CSVs already imported, the auto-heal
recovery will kick in to backfill historical prices.

Expected behavior on Home:
- Greeting matches the time of day ("Good morning, Justin" if before noon).
- Top-right meta line shows today's date and the market status:
  - During market hours (9:30am - 4:00pm ET, weekdays): "Markets open ·
    closes 4:00pm ET"
  - After 4:00pm ET on a weekday: "Markets closed at 4:00pm ET today"
  - Weekend: "Markets closed · open Monday at 9:30am ET"
  - Holiday: "Markets closed for [Holiday name]"
- Brokerage tiles render with the right logos (Fidelity, Charles Schwab,
  JP Morgan, Human Interest fall back to a brand glyph; unknown brokerages
  fall back to initials).
- If price history is missing (rare; only if you've never run a backfill),
  the chart shows a "Loading chart history..." inline progress card and
  fills in within ~60 seconds.

Verify:
- [ ] Greeting is appropriate for time of day.
- [ ] Market-status line is dynamic and accurate (NOT the legacy hardcoded
      "prices Fri 4:00pm ET").
- [ ] Total figure renders without NaN or "--" placeholder.
- [ ] Day change (the "+$X today" line) renders. If prev_close data isn't
      present yet, you'll see "(N symbols pending today's data)".
- [ ] YTD / 1Y / 3Y / 5Y / All-time TWR metric tiles render real numbers
      (not "--" except All-time XIRR which is allowed to read --).
- [ ] All-time XIRR reads a sane number (positive, plausible). On small
      samples (Fidelity multi-account ~$22k) it may read high; this is the
      known PARTIAL behavior documented in FUNCTIONALITY_MATRIX.md.

If FAIL: open Settings -> Market data -> Backfill diagnostics and check the
recovery flag + per-symbol coverage. Force re-run if necessary.

## Test 3: Home chart per-segment windowing and SPY overlay (1 minute)

Verify:
- [ ] Default chart segment is ALL. Click each segment: 1M, 3M, 6M, YTD,
      1Y, 3Y, 5Y, ALL. The chart re-renders for each (no diagonal lines,
      no frozen "loading" state).
- [ ] The y-axis values move when you switch segments (proves the
      `windowSeries` aggregation is real).
- [ ] Toggle "vs SPY" off and on. With it on, a violet dashed line appears
      alongside the portfolio line. The legend shows "Portfolio" and "SPY".
- [ ] The SPY overlay scales correctly in absolute mode (it doesn't
      dominate the chart for extreme-growth portfolios).

If FAIL on a specific segment: the per-segment windowing was the headline
fix in PR #2. A failure here means PR #2 didn't land cleanly. Check the
console for a `windowSeries` or `segmentWindow` error.

## Test 4: Accounts page and brokerage grouping (2 minutes)

Click "Accounts" in the sidebar.

Expected behavior:
- The page shows one tile per detected account, grouped by brokerage.
- Each account row reads `<last4> <Brokerage> <Account name>`, e.g.
  "7969 Charles Schwab Individual".
- Each row shows: value, day change, holdings count, transactions count.
- Skeleton-row filter: if any account has $0 value, $0 cost basis, AND 0
  transactions, it does NOT render (it's a leftover from the dedup
  migration).
- Contribution panels (401k limit, IRA limit, HSA limit) appear only if
  the user has accounts of that type.

Verify:
- [ ] All 4 JPM accounts render in `<last4> JP Morgan <name>` format.
- [ ] Fidelity accounts render with HSA + Individual.
- [ ] No "$0 / $0 / 0 transactions" skeleton rows visible.
- [ ] Click anywhere on a row (not just the chevron). The view transitions
      to the account-scoped Holdings page.
- [ ] On the account-scoped Holdings page, the page-meta total matches
      the sum of visible rows.
- [ ] Click "Back to Accounts". You return to the Accounts page (not the
      top-level Home).
- [ ] Press Enter when a row has keyboard focus. Same drill-in.

If FAIL on account name format: the canonical naming was a separate PR
(b6431ff). Check `app/src/lib/importers/*.ts` and the
`upsertAccountByFingerprint` helper.

If FAIL on row click: the click-anywhere affordance is in
`AccountsView.tsx`; `app/tests-e2e/accounts-row-click.spec.ts` covers it.

## Test 5: Holdings aggregation and drill-in (2 minutes)

Click "Holdings" in the sidebar.

Expected behavior:
- The unfiltered Holdings view shows one row per symbol (aggregated across
  accounts).
- If a symbol is held in 2+ accounts, a "Held in N accounts" subtitle
  appears under the symbol name.
- Each row shows: ticker, name, sector, qty, avg cost, market price, value,
  day change, gain, share of portfolio.
- The Sector column is populated by Yahoo's quoteSummary; it may show "--"
  for newly-imported symbols until the sector backfill lands.
- Sortable: click any column header to toggle sort. The active column
  shows a ↑ or ↓ arrow.

Verify:
- [ ] No duplicate rows (aggregation works).
- [ ] Sort by Value descending. The largest position is at the top.
- [ ] Sort by Sector. Symbols group by sector.
- [ ] Sort by Symbol. Alphabetical.
- [ ] Click a holding row. Transitions to the Holding Detail view.

If FAIL on sector column being empty for everything: the sector backfill
hasn't run yet. Go to Settings -> Market data -> Backfill diagnostics ->
Force re-run all. Wait 30 seconds. Return to Holdings.

If FAIL on sort indicator: the sort arrow visibility was a fix in commit
`e15b6f4`. Check `app/src/views/HoldingsView.tsx` `arrow()` helper.

## Test 6: Holding Detail with auto-backfill (2 minutes)

From Holdings, click a position with multi-year history (e.g. VTI, VITAX,
or any long-held position).

Expected behavior:
- The header shows: ticker, name, sector + industry + currency on the
  subtitle line.
- The chart auto-fetches missing price history on mount (if needed). You'll
  see an inline "Loading chart history..." card while the fetch is in
  flight.
- Metrics card shows: Market price, Cost basis, Avg cost (with cents),
  Current value, Total gain, Today's change, Lifetime div, Lifetime
  dividends count.
- Lifetime div counts dividend + div_reinvest only (NOT interest).
- Below the chart: comparison input ("compare to SPY/AAPL/etc"), already
  pre-filled with "SPY".
- Activity table shows real transactions for this symbol with proper
  action labels (Buy / Sell / Reinvest / Dividend / Transfer in / etc.)
  and the right tier colors.

Verify:
- [ ] Chart populates within ~30 seconds (auto-backfill works).
- [ ] Sector + industry text is visible in the header subtitle.
- [ ] Metrics card has no NaN, no "$NaN", no "--" except optional fields.
- [ ] Avg cost shows cents (e.g. "$6.22" for QQQ in Schwab).
- [ ] Activity table action labels are correct (a `cash_in` row shows
      "Deposit" in blue, NOT "BUY" in green).

If FAIL on chart staying empty: check Settings -> Privacy log for Yahoo
errors. The per-symbol fetch can fail on rate limits.

If FAIL on action labels (a cash_in showing as BUY): PR #4 didn't land.
Check `app/src/lib/format.ts` `formatActionLabel` helper.

## Test 7: Transactions filters and pagination (2 minutes)

Click "Transactions" in the sidebar.

Expected behavior:
- The page shows the most recent transactions in a table.
- Top filter row: date range segments (1M / 3M / YTD / 1Y / ALL) and
  action segments (All / Buys / Sells / Dividends / Cash flows).
- Page-meta line shows: total count + breakdown ("23 buys · 1 sells ·
  5 dividends · 3 cash flows").
- Each row has: date, account, action badge (color-coded by tier), symbol,
  description, qty, price, amount.
- Cash flow rows show "Deposit" / "Withdrawal" / "Transfer in" / etc. in
  blue, NOT "Buy" / "Sell" in green/red.
- Pagination at the bottom: page size selector (25 / 50 / 100), prev/next,
  page indicator.

Verify:
- [ ] All / Buys / Sells / Dividends / Cash flows all filter correctly.
- [ ] Cash flows segment shows ONLY rows with tier === cashflow.
- [ ] Date range filter narrows correctly. 1M shows the last 30 days only.
- [ ] Filter chain composes: 1M + Cash flows + search "VGT" works.
- [ ] Empty-state copy is whimsical: "No deposits or withdrawals in this
      range. Capital coming soon?" for an empty Cash flows segment.
- [ ] Pagination: click Next. Page 2 renders. Page indicator advances
      ("2 / N").
- [ ] Change page size from 25 to 50. Rows expand accordingly.

If FAIL on a cash_in row showing as "BUY": same as Test 6 failure. PR #4.

## Test 8: Planner (1 minute)

Click "Planner" in the sidebar.

Expected behavior:
- The page renders without crashing.
- Retirement projection: shows current age, retirement age, current balance,
  projected balance at retirement. If no retirement-typed accounts are
  imported, shows an empty-state hint ("Add a 401(k), Traditional IRA, or
  Roth IRA to see a projection").
- HSA panel: shows current HSA balance, projected balance at age 65,
  lifetime healthcare cost estimate ($330k for 2-person household).
  Empty state if no HSA.
- Contribution chips: shows YTD contributions / 401k limit, etc.
- "Use my 5Y" chip on the projection: pulls the user's real 5-year TWR.

Verify:
- [ ] Page renders without console errors.
- [ ] Empty-state hints appear if any expected account type isn't imported.
- [ ] 2026 IRS limits show: 401k $23,500, IRA $7,000, HSA $4,300 self /
      $8,550 family.

Note: there is NO ground-truth test against an external calculator for the
year-by-year projection math. Treat the projected balance as "directionally
correct" rather than "to the dollar."

## Test 9: Achievements with replay (1 minute)

Click "Achievements" in the sidebar.

Expected behavior:
- The page shows unlocked + locked milestones from the 29-entry catalog
  (`milestoneCatalog.ts`).
- Each tile shows: glyph, title, copy, unlock date if unlocked.
- "Coming up next" section at the top: shows the next 1-2 milestones the
  user is closest to unlocking, with gap-to-go from real `totalValue`.
- "Replay celebration" button on each unlocked tile.

Verify:
- [ ] At least one unlocked milestone (Four digits / portfolio crosses
      $1k) for any non-empty portfolio.
- [ ] "$100 in dividends" milestone is NOT unlocked on the Fidelity sample
      (only $0.21 in real dividends).
- [ ] Click "Replay celebration" on a SPECIFIC milestone tile. The toast
      that appears matches that milestone's glyph + title (NOT a hardcoded
      $1M toast).
- [ ] Sidebar achievement badge shows the unlock count. Hidden at 0.

If FAIL on replay showing wrong milestone: PR #2 fix. Check
`AchievementsView.tsx` `handleReplay` passes the `milestoneId` to
`onReplayToast`.

## Test 10: Settings full walkthrough (3 minutes)

Click "Settings" in the sidebar.

### 10a: General

Verify:
- [ ] Theme toggle works (Light / Dark). The full app re-themes.
- [ ] Restart onboarding button appears in the "Your data" section (not
      General).

### 10b: Privacy & network

Verify:
- [ ] "Privacy promise" copy is present and matches PRD §5.
- [ ] "Recent outbound calls" panel shows real Yahoo / logo.dev requests.
      Each entry has: timestamp, method, host, path, status, optional note.
- [ ] Click "Refresh quotes" from Home (Home -> Refresh quotes -> return
      to Settings). The Recent outbound calls panel shows fresh entries
      with `OK N bars` notes (or `FAIL <reason>` if Yahoo is down).
- [ ] The "Backfill diagnostics" panel renders. It shows:
      - Summary chips: Recovery flag (complete / pending), Held symbols (N),
        With coverage (N), Failed last run (N).
      - Per-symbol coverage table: symbol, date range, bar count, last
        fetch.
- [ ] Click "Force re-run all" in the diagnostics panel. The button shows
      "Re-running..." and the network log shows fresh Yahoo requests. After
      ~30 seconds the table updates with new bar counts.

### 10c: Market data

Verify:
- [ ] Auto-refresh toggle defaults to OFF.
- [ ] Toggle ON. The interval selector becomes enabled.
- [ ] Change interval to 15 min. Reload the page (refresh the window).
      The toggle remains ON and the interval remains 15 min (persistence).
- [ ] Refresh history button is present.

### 10d: Your data

Verify:
- [ ] Export database (.json) button present.
- [ ] Export as Zip (with CSVs) present.
- [ ] Import a backup... button present.
- [ ] Erase everything... button (red text) present.
- [ ] Restart onboarding button present.
- [ ] DB location line shows the real SQLite path (Tauri) or
      "(in-browser dev storage)" (browser dev mode).
- [ ] DB stats footer shows real account count + transaction count.

DO NOT click Erase everything during this morning test pass unless you want
to wipe your portfolio. (If you do want to test it, see Test 12 below.)

### 10e: About

Verify:
- [ ] Version reads "0.1.0".
- [ ] License reads "MIT".
- [ ] Privacy promise copy is present.
- [ ] No Hebrew characters in the etymology blurb except the single
      italicized Hebrew word.

## Test 11: Add Account + Universal Template roundtrip (2 minutes)

From Home, click "Add an Account" or from Accounts click "Add Account".

Expected behavior:
- The Add Account view shows a dropzone for CSV upload.
- Below the dropzone: a link "Don't see your brokerage? Use our universal
  template ->".
- Click the universal-template link. The dedicated UniversalTemplateView
  renders.
- The view explains the template, shows the column headers, and offers a
  download link for `matmon-template.csv`.

Verify:
- [ ] Download link works: clicking it saves `matmon-template.csv` to your
      downloads. Open it in a text editor to confirm the header row matches
      `Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Brokerage,Account Type,Currency,Notes`.
- [ ] The "Back" link returns to Add Account.
- [ ] Drop a filled-out universal template CSV (you can use the sample at
      `app/public/matmon-template.csv` or fill in your own) into the
      dropzone. The view detects it, shows a review step, and on commit
      lands you on Home with the new transactions imported.

If FAIL on download: the asset path is `/matmon-template.csv` (served from
`app/public/`). Check that the file exists.

## Test 12: Erase + restart onboarding (1 minute) [OPTIONAL]

ONLY run this if you want to start fresh. This wipes all imported portfolio
data.

1. Settings -> Your data -> Erase everything...
2. Confirm the destructive action in the dialog.
3. Wait for "All local data erased" status text.
4. Reload the window (Cmd-R).
5. Verify you land back on the onboarding flow (Welcome step).

Verify:
- [ ] Onboarding shows the Welcome step.
- [ ] Profile / Goal / AddAccount steps are typeable (the early bugs in
      a105310 are fixed).
- [ ] Birth year and retire age inputs accept partial typing without
      slamming back to the min on each keystroke.
- [ ] You can complete onboarding with the real CSV from `example_csv/`
      (drop `multiple_accounts_fidelity.csv`, then `jpm_multiple_accounts.csv`).
- [ ] You land on Home with real data after Finish setup.

If FAIL on inputs not being typeable: the onboarding input bugs were fixed
in commits a105310 + 4a102be. Re-check `OnboardingView.tsx` `ProfileStep`
and `GoalStep`.

## Post-flight

If everything PASSED:
- The Tauri build is in good shape. The overnight work landed cleanly.
- Open the four PRs in GitHub (#1, #2, #3, #4) and merge in order (#1 first,
  then the three fix branches stacked on top).

If anything FAILED:
- Document the specific failure in `OVERNIGHT_REPORT.md` under a new
  "Morning test failures" section.
- Take a screenshot if visual; capture the console error if behavioral.
- Decide whether the failure blocks the merge or can be a follow-up.

## What this test plan does NOT cover

- The Tauri-specific code paths (plugin-sql, plugin-http, plugin-fs,
  plugin-dialog, plugin-notification) are exercised by your manual taps.
  No Playwright spec drives them. If a regression slips through here it
  won't be caught until a user reports it.
- Notifications: the Tauri plugin-notification is wired but no test plan
  step exercises it. Milestone toasts appear inline, not as native
  notifications.
- Code signing / notarization: skipped (per TODO.md item 5).
- Cross-platform: Linux / Windows builds exist as workflow files but are
  not in this morning test plan.
- Real Yahoo Finance behavior during a rate-limit: only triggers
  occasionally. If it happens, the network log will show `FAIL HTTP 429
  rate limited` and the recovery error toast will appear.

Total expected time: 15 minutes if everything passes. Add 5-10 minutes per
failure for diagnosis and screenshot capture.
