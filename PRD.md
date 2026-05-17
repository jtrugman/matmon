# Matmon: Product Requirements Document

**Status:** Draft v0.1
**Author:** Justin Trugman
**Last updated:** May 16, 2026

> *Matmon (מטמון) is Hebrew for "hidden treasure." From the root ט.מ.נ, "to hide" or "to bury." Pronounced maht-MOAN. The biblical resonance is Proverbs 2:4: "If you seek her like silver, and search for her like hidden treasures (matmonim)." The colloquial resonance is the modern Hebrew phrase "atah matmon," meaning "you're a gem."*

---

## 1. Executive Summary

Matmon is a free, open-source, cross-platform desktop application for tracking and analyzing your investment portfolio, built on the radical idea that managing your money should be **private, beautiful, and fun**.

Unlike web-based portfolio trackers that require uploading sensitive financial data to a third party, Matmon stores everything locally on your machine. The only data that ever leaves your device is anonymous price-quote requests to a public market data API. There are no accounts, no logins, no analytics, no telemetry.

The app supports the assets most retail investors actually hold (US stocks, ETFs, mutual funds, and money market funds), imports transactions from any major brokerage via CSV, computes industry-standard performance metrics (TWR and XIRR), and visualizes everything through gorgeous, comparable-to-benchmarks charts. A built-in retirement and healthcare planner lets users project future portfolio growth, model contributions across tax-advantaged account types, and plan for one of the largest expenses retirees actually face: healthcare. A playful gamification layer celebrates milestones along the way, because watching your net worth grow should feel like leveling up, not filing taxes.

---

## 2. Problem & Vision

### The problem

Retail investors today face an ugly trilemma:

1. **Brokerage dashboards** are siloed (you only see one account) and visually stuck in 2008.
2. **Aggregators like Mint/Empower/Personal Capital** consolidate your accounts but require you to hand over your brokerage login credentials to a third-party server, a non-starter for anyone privacy-conscious. They also bombard you with upsells and have a track record of getting shut down (RIP Mint).
3. **Spreadsheets** give you privacy and flexibility but require constant manual maintenance and produce charts that look like a high school accounting project.

There's a glaring gap: **a beautiful, private, modern portfolio tracker that respects your data and makes the experience enjoyable.**

### The vision

A desktop app that feels as polished as a top-tier consumer product, as private as a paper notebook, and as fun as a well-made game. You open it on a Sunday morning, see your portfolio's history drawn against the S&P 500 in a chart that makes you want to frame it, get a notification that you just crossed a milestone ("First $100K, go tell your dog"), and close the app feeling good about your financial life. Then you contribute a CSV parser for your weird regional brokerage back to the open source repo.

---

## 3. Goals & Non-Goals

### Goals

- Ship a downloadable desktop app for macOS, Windows, and Linux that works out of the box with zero account creation.
- Make data import painless. A CSV from any of the top 10 US brokerages should "just work."
- Provide best-in-class charting that lets users plot their portfolio over time and overlay benchmarks.
- Calculate performance using both time-weighted return (TWR) and money-weighted return (XIRR / IRR).
- Provide a robust retirement and healthcare planning experience: tax-advantage breakdown of the portfolio, retirement value calculator with adjustable contributions and return assumptions, and healthcare cost projections that account for HSA balances and expected retiree medical expenses.
- Deliver a UI that, at minimum, makes the user say "wow" the first time they see it. At maximum, they screenshot it for Twitter.
- Build a credible privacy story: all financial data stays local; the only outbound network traffic is anonymous quote requests.
- Cultivate a fun, irreverent product voice that turns boring portfolio tracking into a delightful daily ritual.
- Open-source on GitHub under a permissive license (MIT recommended) and structure the codebase so external contributors can add brokerage parsers and translations easily.

### Non-goals

- **Trading.** This is a tracker, not a brokerage. We don't place orders.
- **Tax filing.** We show unrealized/realized gains. We don't generate Form 8949 or handle wash sales.
- **Financial advice.** The retirement and healthcare planner produces projections based on user-supplied or historical assumptions. It does not give advice, recommend products, or tell users what to do. We show math; users make decisions.
- **Crypto, options, or international equities.** Out of scope. Revisit later.
- **Multi-user / shared portfolios.** Single-user, single-machine. No sync, no cloud.
- **Mobile apps.** Desktop only for v1.
- **Real-time tick-by-tick data.** Quotes refresh every ~15 minutes during market hours, which is more than enough for a long-term tracker.
- **Robo-advice or specific buy/sell recommendations.** We show you your data; we don't tell you what to do with it.

---

## 4. Target Users

### Primary persona: The Engaged Retail Investor

Age 25–45. Has 1–4 brokerage accounts across providers (a taxable Fidelity account, a Vanguard Roth IRA, a 401(k) at Empower, maybe a Robinhood account they're embarrassed about). Checks their portfolio weekly. Has at least once tried to build a Google Sheet to track everything and given up after three weeks. Cares about privacy enough to be wary of Mint-style aggregators. Appreciates good design. Has heard of "the S&P 500" and wants to know if they're beating it.

### Secondary persona: The FIRE / Personal Finance Hobbyist

The Bogleheads / r/personalfinance reader. Wants real numbers, not vibes. Will care deeply about whether TWR is computed correctly. Will file thoughtful GitHub issues. Likely to become a contributor.

### Tertiary persona: The Privacy Maximalist

The person already on Linux, already running self-hosted everything. Reads the source. Wants to verify the network boundary themselves. Will be our most credible evangelist if we earn their trust.

---

## 5. Guiding Principles

These are the trade-off tiebreakers. When the team is stuck between two paths, pick the one that better honors these principles.

**Privacy is non-negotiable.** Every feature must answer the question "does this leak any user data off-device?" If yes, it has to justify itself loudly, default to off, and be auditable.

**Beautiful before featureful.** A short list of features that look incredible beats a long list that looks like a 2014 SaaS dashboard. We'd rather ship five things that are gorgeous than fifteen that are okay.

**Fun is a feature, not a coat of paint.** The product voice, copy, and gamification are core to the experience, not decorations applied at the end. Boring copy is a bug.

**Open source by default.** Code, decisions, and roadmap are public. Brokerage CSV parsers especially benefit from community contributions, since every contributor knows their own broker best.

**Calm software.** We don't notify you constantly. We don't show red numbers in giant fonts when the market dips. We respect that you have a life.

---

## 6. Tech Stack & Architecture

### Stack decision: Tauri + React + TypeScript + SQLite

**Frontend (and all business logic):** React + TypeScript + Vite. Tailwind CSS for styling. TradingView's `lightweight-charts` for the main time-series chart, Recharts for secondary charts. All app logic (CSV parsing, performance math, quote fetching, scenario calculations) lives in TypeScript.

**Shell:** Tauri v2. Tauri's Rust shell wraps the React app in a native OS window using the system webview (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux). We use Tauri plugins to access SQLite, the file system, and HTTP without writing custom Rust code. The only Rust file in the repo is a ~15-line `main.rs` that wires up the plugins, copied from the Tauri docs.

**Storage:** SQLite via `tauri-plugin-sql`, which exposes a clean async TypeScript API. The DB file lives at `~/Library/Application Support/[app]/portfolio.db` (Mac), `%AppData%\[app]\portfolio.db` (Windows), `~/.local/share/[app]/portfolio.db` (Linux).

**Anchor TypeScript libraries:**

- `react`, `react-dom`, `vite`, `typescript`
- `tailwindcss`, `@headlessui/react` for accessible UI primitives
- `lightweight-charts` for the main portfolio-over-time chart
- `recharts` for treemaps and bar charts
- `papaparse` for CSV parsing
- `yahoo-finance2` for quotes (no API key, covers stocks, ETFs, mutual funds, and money market funds)
- `xirr` for money-weighted return calculation
- A small home-rolled module for TWR (it is straightforward arithmetic)
- `zod` for runtime validation of imported data and saved scenarios

**Tauri plugins used (all expose JS APIs, zero Rust to write):**

- `tauri-plugin-sql` for SQLite access
- `tauri-plugin-fs` for reading user-selected CSV files
- `tauri-plugin-http` for outbound HTTPS calls that bypass browser CORS
- `tauri-plugin-dialog` for file picker dialogs
- `tauri-plugin-notification` for milestone toasts (optional, opt-in)

**Distribution:** Signed installers (`.dmg`, `.msi` and `.exe`, `.AppImage` and `.deb`) built via GitHub Actions and published to GitHub Releases. Target installer size: roughly 10 to 15MB per platform.

### Why this stack

For a privacy-first, beautiful, open source downloadable app, Tauri is the strongest fit on every axis:

Bundle size sits around 10MB instead of the 100MB+ of an Electron-based app. That matters a lot when you're asking strangers to download a financial tool. RAM usage at rest is roughly 50 to 100MB versus 300MB or more for Electron. Tauri's capability system declares in `tauri.conf.json` exactly which directories the app can read and which domains it can call, and that file is auditable by anyone reading the repo, which directly reinforces the privacy story. The entire app is written in one language (TypeScript), which lowers the barrier for outside contributors.

We considered Electron + TypeScript as the main alternative. Electron wins on ecosystem maturity and on the fact that it ships Chromium everywhere, so rendering is identical across platforms. We accept Tauri's webview-quirk risk because the libraries we chose (Tailwind, Headless UI, TradingView lightweight-charts, Recharts) are all battle-tested across the three OS webviews, and our CI matrix runs on all three platforms.

**Contributor note:** building Tauri locally requires the Rust toolchain installed (via `rustup`), even though contributors will only write TypeScript. This is one extra step in `CONTRIBUTING.md` and not a real barrier.

### High-level architecture

```
+--------------------------------------------------------------+
|             Tauri shell (OS-native window)                    |
|  +--------------------------------------------------------+  |
|  |              React app (TypeScript)                    |  |
|  |                                                        |  |
|  |  Views   Charts   Performance math   CSV importers    |  |
|  |  ^        ^         ^                ^                |  |
|  |  |        |         |                |                |  |
|  |  +--------+---------+----------------+                |  |
|  |                |                                       |  |
|  |                v                                       |  |
|  |       Tauri plugin JS APIs                            |  |
|  |  (sql, fs, http, dialog, notification)                |  |
|  +-----------------|--------------------------------------+  |
|                    v                                          |
|       +------------+------------+                            |
|       |       SQLite DB         |  (local file)              |
|       +-------------------------+                            |
+-------------------|------------------------------------------+
                    v
         Public market data API
         (Yahoo Finance via yahoo-finance2)
```

The only network calls leaving the app go to Yahoo Finance, batched by symbol, anonymous. Every other operation is local.

### Privacy boundary

The one and only network call this app makes is to fetch quotes. That call contains: a list of ticker symbols, and nothing else. No user ID, no device fingerprint, no portfolio composition, no transaction history. The app makes this explicit:

- A "Network Activity" pane in Settings shows every outbound request the app made, in plain English.
- The user can disable network entirely ("Offline mode") and the app keeps working with the last-known prices.
- No analytics, telemetry, crash reporting, or auto-update phone-home. (If auto-updates are ever added, they'll be a deliberate, opt-in feature with clear network boundaries.)

---

## 7. Feature Requirements

### 7.1 Data Import (CSV)

**Goal:** A user with a CSV exported from any of the top US brokerages can drag it into the app and see correct holdings and cost basis within 30 seconds.

**Requirements:**

- Drag-and-drop CSV import from anywhere in the app, plus a "Import" button in the empty state and in account settings.
- Auto-detect the brokerage from the CSV's header row.
- For each supported brokerage, ship a parser that maps the CSV columns to our internal `Transaction` schema: `date`, `account_id`, `symbol`, `action` (buy/sell/dividend/split/etc.), `quantity`, `price`, `fees`, `notes`.
- For unrecognized CSV formats, fall back to a column-mapping wizard where the user matches columns to the schema manually. The wizard remembers the mapping per file shape so re-imports are one-click.
- Handle duplicate detection on re-import: if the same transaction (same date, account, symbol, action, quantity, price) already exists, skip it silently. Show a summary at the end: "Imported 47 new transactions, skipped 213 duplicates."
- Support the action types: buy, sell, dividend, dividend reinvestment, split, stock spin-off, transfer in, transfer out, cash deposit, cash withdrawal, fee, interest.

**Brokerage support matrix:**

| Brokerage | Priority | Notes |
|---|---|---|
| Fidelity | P0 | Widely used; clean CSV export with multiple history ranges |
| Charles Schwab | P0 | Widely used; multiple export formats including legacy TD Ameritrade transactions |
| JP Morgan (Chase / JPM Self-Directed / JPM Wealth) | P0 | Major footprint, especially among Chase banking customers |
| Human Interest | P0 | 401(k) provider for small businesses; different export shape than a brokerage and worth treating as its own importer pattern |

Every other brokerage (Vanguard, E*TRADE, Robinhood, Interactive Brokers, Merrill Edge, Wealthfront, M1, Public, etc.) is intentionally deferred. We'd rather build four importers that work flawlessly than ten that each have rough edges.

Each parser lives in its own file under `src/importers/<brokerage>.ts` with a uniform `BrokerageImporter` interface and a test fixture (a real anonymized CSV) in `src/importers/__fixtures__/`. This makes it trivial for community contributors to add their own brokerage in subsequent releases.

**A note on Human Interest:** 401(k) providers export differently than brokerages. Transaction-level history is often incomplete or missing entirely, and the value of the importer is often just "current holdings and contribution history." The importer interface needs to gracefully handle this case (a brokerage can declare itself "holdings-only" instead of "transaction-level") rather than forcing the 401(k) export to pretend it has data it doesn't.

### 7.2 Account & Portfolio Structure

**Model:** The user has many **accounts** (e.g., "Fidelity Taxable," "JP Morgan Roth IRA," "Human Interest 401(k)"). Each account has a **type** (taxable, traditional IRA, Roth IRA, 401(k), HSA, other) and a **brokerage**. Accounts contain **transactions**, which derive **holdings**, which roll up into the **total portfolio**.

**Three lenses on the same data:** Users can view their portfolio through three orthogonal lenses, each a top-level navigation destination. Every chart and metric respects the current lens scope.

**1. Total Portfolio view (the default landing view).** Combined value across everything, today's change, all-time return, and the headline portfolio-over-time chart.

**2. Brokerage view.** Answers the question "how much do I have with each brokerage?" Shows each brokerage as a card (or row) with total value, percent of portfolio, account count, holdings count, and a sparkline of recent performance. Click a brokerage to drill into all the accounts held there. This is useful for diversification thinking ("am I over-concentrated at one custodian?") and for the simple satisfaction of knowing the breakdown at a glance.

**3. Account Type view.** Slices the portfolio by tax treatment, with fun names as the primary labels and the technical names as subtitles. The fun names (see below) are configurable, but the defaults are chosen to be evocative without being silly. This view is a tighter, faster-loading partner to the full Planner page (§7.8). The Planner is for projection and scenario work; the Account Type view is for "what's the state of my buckets right now?"

**Fun names for account types (defaults):**

| Fun name | Account types it groups | Why this name |
|---|---|---|
| **The Yard** | Taxable brokerage | Open, no fences, no special rules. You can come and go as you please. |
| **The Vault** | Traditional IRA, Traditional 401(k), 403(b), SEP IRA | Locked away. The taxes are coming for it eventually, but for now, sealed. |
| **Sunshine** | Roth IRA, Roth 401(k) | Already taxed, now growing free. Every dollar harvested in retirement is tax-free. |
| **The Apothecary** | HSA | Medicine cabinet vibes, triple-tax-advantaged, a quiet weapon for healthcare. |
| **The Drawer** | Custodial, trust, other | The miscellaneous bucket where the odd accounts go. |

The fun-name set is editable in Settings, both per-name (rename "The Yard" to whatever you want) and as a whole (turn off fun names entirely if you'd rather see the boring labels). The boring names are always visible as subtitles or tooltips so nobody is ever confused about which account type they're looking at.

**Account creation flow:** One-screen affair. Name the account, pick a brokerage from a dropdown, pick a type. Then import a CSV or add transactions manually. The fun name for the account type is shown automatically (e.g., "Got it. This Roth IRA lives in Sunshine.").

### 7.3 Quote Fetching

**Provider:** Yahoo Finance via the `yahoo-finance2` npm package (no API key required). Covers stocks, ETFs, mutual funds, and money market funds, the full asset scope of this PRD.

**Architecture:** The quote client is implemented behind a `QuoteProvider` interface in TypeScript. Yahoo is the default, but the architecture supports adding Alpha Vantage and Finnhub providers later. Users can optionally paste their own API keys for those providers in Settings, which is for users who don't want to depend on Yahoo's unofficial endpoints.

**Behavior:**

- Quotes refresh automatically every 15 minutes while the app is open and during US market hours (9:30am–4:00pm ET, M–F).
- Manual refresh available via a header button (with a delightful spinner).
- All fetched quotes are cached in the local SQLite DB. If the app is offline or Yahoo is unreachable, we show the last-known prices with a subtle "as of [timestamp]" badge.
- Historical price data (for the portfolio-over-time chart) is fetched once per symbol on first use and cached forever, with daily incremental updates.
- We batch quote requests to minimize the number of network calls. A 30-symbol portfolio is one request, not thirty.

### 7.4 Performance Math

**Required calculations:**

- **Cost basis (per holding):** Average cost, computed from transactions. Adjusts for splits.
- **Unrealized gain/loss:** Current market value minus cost basis, in dollars and percent.
- **Realized gain/loss:** Cumulative gains/losses from closed lots, by year and lifetime.
- **Time-weighted return (TWR):** Industry-standard return calculation that removes the effect of deposits and withdrawals. Used for benchmarking against indexes. Computed at the portfolio, account, and holding level. Reported as annualized when the period > 1 year.
- **Money-weighted return (XIRR):** Internal rate of return given the actual cash flows. Answers "what return did I actually earn on the money I put in?" Computed at the portfolio level.
- **Period-over-period returns:** 1D, 1W, 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, All-time.

**Edge cases to handle:** stock splits, spin-offs (track new symbol with allocated basis), dividend reinvestment, return of capital distributions (for some ETFs and mutual funds), partial fills.

### 7.5 Charting

This is the headline visual feature. **Charts are the product.**

**Required chart types:**

- **Portfolio value over time** (main chart on the home screen). Line or area chart. Zoomable, pannable, with selectable timeframes (1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, All).
- **Overlay comparison:** layer on the price of any other ticker (e.g., SPY, QQQ, VTI, individual stocks) normalized to the same starting point. Should be ergonomically obvious: a single input box at the top of the chart that says "compare to..." with autocomplete.
- **Holdings breakdown:** treemap or donut showing portfolio composition by holding, sector, or account type.
- **Performance attribution:** bar chart showing which holdings contributed most (and least) to returns over the selected period.
- **Allocation drift:** for users who want it, show target vs. actual allocation across asset classes.

**Charting library:** TradingView `lightweight-charts` for the main time-series chart (it's free, beautiful, and fast). Recharts or Visx for the secondary charts (treemap, bars). Both work reliably across all three Tauri webviews.

### 7.6 Gamification

**Philosophy:** Celebrate milestones without infantilizing the user. The vibe is "your clever friend who notices the cool thing that just happened," not "Duolingo owl."

**Mechanics:**

- **Milestone toasts:** When the user crosses a meaningful threshold, a toast appears at the bottom of the screen with custom copy. Toasts auto-dismiss after a few seconds and are also collected in an "Achievements" page where the user can browse their history.
- **No streaks, no daily check-ins, no FOMO.** We will not nudge people to open the app. The app rewards what happened in your portfolio, not what you did in the app.
- **Sound is optional and off by default**, but a tasteful "ding" on milestone unlocks is supported.

**Sample milestones (catalog will be defined separately, see §10):**

- First import completed
- First $1K, $10K, $50K, $100K, $250K, $500K, $1M (and beyond, go higher than you think)
- First full year tracked
- Beat the S&P 500 over a calendar year
- First $100, $500, $1,000 in lifetime dividends
- Portfolio survives its first 10%+ drawdown without you selling everything
- 100, 500, 1,000 transactions tracked

### 7.7 User Interface

**Design principles:**

- **Calm, high-end, slightly playful.** Think Linear meets Robinhood meets a really nice coffee shop. Generous whitespace. A small, tasteful color palette. Typography that does the heavy lifting.
- **Numbers are the typography.** Tabular figures everywhere. Mono-style fonts for currency. Never let numbers misalign.
- **Color used intentionally.** Green/red for gain/loss but desaturated, never neon. A single accent color for actions. Dark mode is first-class (and probably the default).
- **Animation with restraint.** Charts animate in. Number-counter animations on big totals. Nothing else moves unless the user causes it to.

**Required views (v1):**

1. **Home / Total Portfolio.** Big total value, today's change, headline chart, account breakdown, recent activity.
2. **Account view.** Same shape as home but scoped to one account.
3. **Holdings table.** Sortable, with cost basis, current value, gain/loss, allocation %, performance.
4. **Holding detail.** Individual position: history, transactions, dividends received, contribution to total return.
5. **Transactions.** Full list, filterable, searchable, editable.
6. **Planner.** Top-level navigation item. Tax-advantage breakdown, retirement value calculator with sliders and scenario comparison, healthcare projections (HSA outlook, lifetime cost estimate, IRMAA awareness, pre-65 coverage gap).
7. **Achievements.** Grid of unlocked and locked milestones (locked ones are intriguingly silhouetted, not spoiled).
8. **Import.** Drag-and-drop + brokerage picker + column mapper.
9. **Settings.** Currency, date format, theme, quote provider, network activity log, data export/import.

**Responsiveness:** The app should look great at any window size from 1024×600 to ultrawide. Below 1024 width, we collapse the side rail into a hamburger menu.

**Accessibility:** All interactive elements keyboard-navigable. Color contrast meets WCAG AA. Screen reader labels on all charts and totals.

### 7.8 Retirement & Healthcare Planning

The planner is a first-class feature, not an afterthought tucked into Settings. It deserves its own top-level navigation item because for most users, "am I on track for retirement?" is the actual question they're trying to answer when they open a portfolio app.

**Philosophy:** Projections are educational, not advisory. Every calculation shows its assumptions in plain English so the user understands what's driving the number. We show ranges, not single-point forecasts, so users don't mistake a model for a guarantee.

#### 7.8.1 Tax-Advantage Breakdown

A dedicated view that slices the total portfolio by tax treatment of the account, giving users an at-a-glance picture of where their money lives:

- **Taxable** (regular brokerage accounts)
- **Tax-deferred** (Traditional IRA, Traditional 401(k), 403(b), SEP IRA)
- **Tax-free** (Roth IRA, Roth 401(k))
- **Health-advantaged** (HSA)
- **Other** (custodial, trust, etc.)

The view shows each bucket's current value, percent of total, contribution history, and growth over time. A stacked area chart on the same screen visualizes the evolution of each bucket through time. Users can click any bucket to drill into the underlying accounts.

This view also surfaces actionable awareness without giving advice: e.g., a quiet info panel showing the user their current-year contribution levels against the 2026 IRS limits ($7,000 IRA, $23,500 401(k), $4,300 HSA self-only / $8,550 family; values stored in a configurable JSON so they're easy to update each tax year). No nagging; just information.

#### 7.8.2 Retirement Value Calculator

A planning tool that projects future portfolio value based on user-controlled inputs. Designed to be **playful and exploratory** (sliders, not forms). Re-projects instantly as the user adjusts inputs.

**Inputs:**

- **Starting balance.** Defaults to the user's current retirement-account balance (sum of all tax-deferred and tax-free buckets). User can override or scope to a single bucket.
- **Monthly contribution.** Slider, $0 to $5,000+ (cap configurable). Optional split across account types (e.g., "$500 to Roth IRA, $1,000 to 401(k)") with annual contribution limits enforced as soft warnings.
- **Annual contribution increase.** Optional percent increase per year (defaults to 0% but a "match inflation" preset uses ~3%).
- **Expected annual return.** Two modes, selectable via a toggle:
  - *Use my 5-year average* uses the auto-computed portfolio TWR over the past 5 years. If less than 5 years of data exists, we use whatever's available and badge the result as such (e.g., "Based on your 2.3 years of history"). If less than 1 year, this mode is hidden.
  - *Set manually* is a slider from -5% to 15%, with preset chips for common assumptions: 4% ("conservative"), 7% ("S&P 500 long-term avg, real"), 10% ("S&P 500 long-term avg, nominal"). Each chip's label explains its source on hover.
- **Years to project.** Slider, 1 to 50 years. Defaults to (65 minus user's age, if entered in profile) or 30.
- **Inflation adjustment.** Toggle: "Show in today's dollars" (applies a 3% deflator by default, configurable). Defaults to on, because future-dollar numbers are misleading.

**Outputs:**

- **Headline projected value** at the target year, in big tabular numerals.
- **Projection chart.** A line chart showing the projected balance year-over-year, with separate lines for contributions vs. growth (so users can see the compounding kick in). Optionally overlays a low/high band based on a configurable return-volatility range (e.g., expected return ± 3%). This is the "scenarios" view that prevents the false precision of a single line.
- **Breakdown table.** For each projected year: starting balance, contributions, growth, ending balance. Collapsible.
- **Sensitivity preview.** A small panel showing how the headline number changes if return is ±1%, ±2%, or if contributions are ±$200/mo. Helps users feel the leverage of each input.

**Save & compare scenarios:** Users can save a projection as a named scenario ("Aggressive 2055," "Conservative case"). Up to 5 scenarios can be plotted on the same chart for comparison. Scenarios are stored locally like everything else.

#### 7.8.3 Healthcare Planning

Healthcare is the largest cost most retirees face after housing, and existing portfolio tools ignore it almost entirely. We won't.

**HSA panel:** Surfaces the HSA bucket's current balance, contribution history, and a projection of its value at age 65 using the same return-assumption controls as the main retirement calculator. Because HSAs become functionally identical to a Traditional IRA at 65 (and remain tax-free for qualified medical expenses), tracking this bucket separately matters.

**Projected lifetime healthcare costs in retirement:** Using established benchmarks (the Fidelity Retiree Health Care Cost Estimate is the most-cited reference, roughly $165k per person at age 65 as of recent years, adjustable in app settings as the figure updates), the planner shows the user's projected healthcare needs vs. their current HSA balance plus projected HSA growth. The output answers the practical question: "How much of my expected retirement healthcare will my HSA cover?"

**IRMAA awareness (informational):** Medicare Part B and Part D premiums are income-based via IRMAA (Income-Related Monthly Adjustment Amount). When a user enters projected retirement income or withdrawal strategy details (optional inputs), we surface where they'd fall on the IRMAA brackets and what their premium surcharges might look like. This is purely informational (no advice) and helps users understand why Roth conversions are a topic in retirement planning.

**Coverage gap calculator (informational):** If the user enters a target retirement age below 65, we show the gap years before Medicare eligibility and the estimated cost of ACA marketplace coverage during that window (based on a configurable annual premium estimate, defaulting to recent national averages). This addresses one of the most-asked questions for would-be early retirees.

#### 7.8.4 Required disclaimers

Every projection page has a persistent, calm footer: *"These projections are educational illustrations based on the inputs you've provided. Markets do not produce a steady return. Past returns do not predict future returns. This is not financial advice."* Phrased once, prominently, never in a way that screams.

---

## 8. Data Model

A sketch of the SQLite schema. Final names and types will be refined in implementation.

**`accounts`**: one row per brokerage account
`id`, `name`, `brokerage`, `account_type` (taxable / trad_ira / roth_ira / 401k / hsa / other), `currency`, `created_at`

**`transactions`**: every action that has ever happened in any account
`id`, `account_id`, `date`, `symbol`, `action` (buy / sell / dividend / div_reinvest / split / spinoff / transfer_in / transfer_out / cash_in / cash_out / fee / interest), `quantity`, `price`, `fees`, `currency`, `notes`, `imported_from` (raw CSV row hash for dedupe)

**`holdings`**: derived view, can be materialized for performance
`account_id`, `symbol`, `quantity`, `average_cost`, `total_cost_basis`

**`lots`**: individual tax lots for FIFO tracking. The app uses average cost for reporting, but lot-level data is stored so future tax features can surface it without a migration.
`id`, `account_id`, `symbol`, `acquired_date`, `quantity_remaining`, `cost_per_share`

**`prices`**: quote cache, both current and historical
`symbol`, `date`, `close`, `currency`, `fetched_at`

**`symbol_metadata`**: what is this ticker?
`symbol`, `name`, `asset_class` (stock / etf / mutual_fund / mmf), `currency`, `last_split_date`

**`achievements`**: unlocked milestones
`id`, `milestone_key`, `unlocked_at`, `context_json` (e.g., the portfolio value at unlock)

**`scenarios`**: saved retirement-planning scenarios
`id`, `name`, `inputs_json` (starting_balance, monthly_contribution, contribution_growth_pct, return_mode, return_pct, years, inflation_adjust, scope_bucket), `created_at`, `updated_at`

**`user_profile`**: single-row table for personal data used by the planner
`birth_year` (optional, for age-based defaults), `target_retirement_age`, `expected_retirement_income`, `household_size` (for healthcare cost projections)

**`tax_constants`**: versioned annual values that change yearly (IRS contribution limits, IRMAA brackets, Fidelity healthcare estimate, ACA premium average)
`year`, `key`, `value`, `notes`

**`settings`**: single-row key-value table for app preferences

**Backup & export:** The user can export their full database as a `.json` or `.zip` file from Settings. They can also re-import that file on a new machine. This is our "data portability" story and our backup story rolled into one.

---

## 9. Brokerage CSV Support: Contributor Path

Adding a new brokerage parser is the most common contribution we'll receive. The path needs to be obvious.

**Each parser is:** one TypeScript file implementing the `BrokerageImporter` interface, one CSV fixture in `src/importers/__fixtures__/<brokerage>/`, and one entry in the brokerage registry. Plus a section in `BROKERAGES.md` documenting how to export the CSV from that brokerage.

**Documentation will include:** screenshots of where to find the export option in each brokerage's UI, known quirks (Vanguard's date format, Schwab's "Action" column variants, Robinhood's lack of a transaction export, etc.), and what action types map to what internal types.

---

## 10. Gamification Catalog (Initial Set)

These are starter milestones. The complete catalog will grow with community input. The voice: warm, playful, never cheesy. Each milestone has copy that gets a smile.

| Milestone Key | Trigger | Toast Copy (draft) |
|---|---|---|
| `first_import` | First CSV imported | "Welcome aboard. Your numbers are now your own again." |
| `100_transactions` | 100 transactions logged | "100 transactions. You're officially a regular." |
| `first_1k` | Portfolio crosses $1,000 | "Four digits achieved. The journey of a thousand miles, etc." |
| `first_10k` | Portfolio crosses $10,000 | "Five digits. Reasonable people would call this 'serious money' now." |
| `first_100k` | Portfolio crosses $100,000 | "Six digits. Go tell someone you trust. They'll be happy for you." |
| `first_500k` | Portfolio crosses $500,000 | "Half a million. Behold, the power of compounding." |
| `first_million` | Portfolio crosses $1,000,000 | "A millionaire. Go buy your mom some flowers." |
| `two_million` | Portfolio crosses $2,000,000 | "Two commas, going on three. Don't get weird about it." |
| `five_million` | Portfolio crosses $5,000,000 | "Five million. Quietly, you've crossed a line most people never see." |
| `ten_million` | Portfolio crosses $10,000,000 | "Eight digits. We assume you have a guy for this now. We're just along for the ride." |
| `twenty_five_million` | Portfolio crosses $25,000,000 | "Twenty-five million. The 'family office' phrase starts getting whispered." |
| `fifty_million` | Portfolio crosses $50,000,000 | "Fifty million. Statistically, you're the wealthiest person in most rooms." |
| `hundred_million` | Portfolio crosses $100,000,000 | "Nine digits. Hi. Please be kind to people." |
| `quarter_billion` | Portfolio crosses $250,000,000 | "A quarter of a billion. The IRS has a dedicated form just for you now." |
| `half_billion` | Portfolio crosses $500,000,000 | "Half a billion. We're not sure what to say. We're proud of you, in a confused way." |
| `first_billion` | Portfolio crosses $1,000,000,000 | "A billion dollars. Maybe found a hospital wing. Maybe stay anonymous. Your call." |
| `beat_spy_1y` | TWR beats SPY over a calendar year | "You beat the S&P 500 this year. The bogleheads are seething (lovingly)." |
| `first_dividend` | First dividend payment received | "Your money just made money. That's the whole game." |
| `100_in_dividends` | $100 lifetime dividends | "$100 in dividends. Coffee for a month, on the house." |
| `1k_in_dividends` | $1,000 lifetime dividends | "$1,000 in dividends. A small but steady stream forms." |
| `survived_drawdown` | Held through a 10%+ drawdown without selling | "Down 10% and you held. That's the part nobody tells you about." |
| `one_year_in` | One full year of tracking | "One year on the books. Now we can actually talk about 'returns.'" |
| `five_years_in` | Five full years of tracking | "Five years. You've earned the right to make 'when I was your age' jokes." |
| `diversified` | 10+ holdings across 3+ sectors | "10 holdings, 3 sectors. Not putting all the eggs in one basket." |
| `maxed_ira` | Maxed an IRA in a given tax year | "IRA maxed. Future you sends thanks." |
| `maxed_401k` | Maxed a 401(k) in a given tax year | "401(k) maxed. That's the big one." |
| `hsa_covered` | Projected HSA balance covers projected lifetime healthcare costs | "HSA projected to cover your retirement healthcare. Underrated win." |
| `first_scenario` | Saved a first retirement scenario | "First scenario saved. You're thinking ahead. Suits you." |

---

## 11. Tone & Voice Guide

All UI copy, error messages, and toasts follow these rules:

**Voice:** A clever, encouraging friend who knows their stuff. Confident but never condescending. Playful but never cute. We use contractions. We can be dry. We never use "!" except in genuine celebration.

**Words we love:** "your money," "your portfolio," "your numbers." (Possessive. Emphasize ownership.)

**Words we avoid:** "investor" (clinical), "users" (in user-facing copy), "leverage" (as a verb), "synergy," "journey" (overused), corporate jargon of any kind, finance-bro slang ("to the moon," "diamond hands," "stonks"). We're playful, not cringe.

**On gains:** Celebrate quietly. "Up 12% this year" not "🚀 CRUSHING IT 🚀".

**On losses:** Calm and matter-of-fact. Never alarming. "Down 8% from your peak, well within normal." Never red-on-black sirens.

**On errors:** Take responsibility, explain plainly, offer a way forward. "We couldn't read that CSV. It looks like a Fidelity export but a column we expected (Quantity) is missing. [Show me the column mapper]"

**Examples in the wild:**

- Empty state: "No accounts yet. Drop a CSV here or [start with a sample portfolio] to look around."
- Refresh button hover: "Get the latest prices"
- After 4pm ET on weekday: "Markets are closed. Prices last updated at 3:59pm."
- Sunday: "Markets are closed for the weekend. The numbers will not change. Go outside."

---

## 12. Success Metrics

We're open source and free. Traditional product metrics don't apply cleanly. Here's what we'll watch:

- **GitHub stars**: the leading indicator that people find the project compelling.
- **Active installations**: measured via opt-in (and only opt-in) anonymous pings, if we ever add them. Until then, GitHub Releases download counts are the proxy.
- **Weekly active users**: only if telemetry is added with explicit consent. We may simply never measure this and that's okay.
- **Time-to-first-chart**: qualitative target: under 90 seconds from `Open App` to "I can see my portfolio." Measured in user testing.
- **Brokerage parser PR rate**: how many community contributions of new parsers per quarter. A health indicator for the project.
- **Retention proxy**: GitHub issue activity, Discord/forum engagement, repeat contributors.
- **Vibes**: does the front page of the project make us proud? Would we recommend it to our most discerning friend?

---

## 13. Risks & Mitigations

**Yahoo Finance endpoints break or change.** Mitigation: the `QuoteProvider` trait makes it trivial to swap in Alpha Vantage or Finnhub. We'll ship those providers as alternatives from day one, gated behind a user-supplied API key in Settings.

**Mutual fund and money market fund pricing is sometimes delayed or missing.** Mitigation: clearly badge any stale price. Allow manual price override per symbol per date as a last resort.

**Brokerage CSVs change format.** Mitigation: parsers are versioned and have fixture-based tests. When a brokerage changes their export, a contributor (or maintainer) updates the parser and we ship a patch.

**Webview rendering quirks across Mac/Windows/Linux.** Mitigation: CI runs on all three platforms; we test charts and complex UI on all three before any release.

**Open-source project momentum stalls.** Mitigation: keep the initial scope tight, ship visible progress regularly, and make first-time contribution easy via a clear `CONTRIBUTING.md` and labeled good-first-issues.

**Users hand over their CSVs containing sensitive info.** Mitigation: CSVs are processed locally, stored only in the local DB, never re-uploaded. We say so loudly. We log no original CSVs.

---

## 14. Open Questions

Things we deliberately haven't decided yet, to be resolved before implementation begins on the relevant feature.

- **Trademark and domain due diligence.** The name Matmon is committed. Before launch, we need to confirm `matmon.app`, `matmon.io`, and similar domains are available, that no existing US or EU trademark conflicts, and that no existing financial product (especially open source) is already using the name in a confusing way.
- **License.** MIT is the default recommendation. Apache 2.0 if we want more explicit patent protection. AGPL if we want to prevent commercial forks (probably overkill for a desktop tracker).
- **Default theme.** Dark mode probably, but the light mode needs to be beautiful enough that we'd default to it on a fresh install in the daytime. To be decided in design.
- **Currency support beyond USD.** The schema supports it; the UI assumes USD. Multi-currency display is a future decision.
- **Should we ever take any analytics?** Current stance: no, never, by design. But worth revisiting with the community after launch whether opt-in, transparent analytics would help us build better software.
- **Mobile companion app.** Strong demand will arrive. Out of scope for now; revisit once the desktop product is solid.

---

## 15. Appendix: Glossary

**TWR (time-weighted return):** Return calculation that removes the effect of deposits and withdrawals. Used to evaluate the performance of the investments themselves, independent of when you added money. The standard for comparing your portfolio to a benchmark like the S&P 500.

**XIRR / MWR (money-weighted / internal rate of return):** Return calculation that accounts for the size and timing of cash flows. Answers "what annualized return did I actually earn on the money I invested?"

**Cost basis:** The total amount you paid for a position, used to compute gain/loss.

**Tax lot:** An individual purchase of shares, tracked separately for tax purposes. This PRD specifies average-cost reporting; future tax features may surface individual lots.

**Drawdown:** The peak-to-trough decline of a portfolio during a specific period. A "10% drawdown" means the portfolio is currently 10% below its all-time high.

**Benchmark:** A reference index (typically the S&P 500 or a total-market ETF like VTI) that you compare your portfolio's performance against.

**HSA (Health Savings Account):** A tax-advantaged account for medical expenses. Contributions are tax-deductible, growth is tax-free, and withdrawals for qualified medical expenses are tax-free, the only triple-tax-advantaged account in US law. At age 65 it functions like a Traditional IRA for non-medical withdrawals.

**IRMAA (Income-Related Monthly Adjustment Amount):** A surcharge added to Medicare Part B and Part D premiums for retirees whose income exceeds certain thresholds. Higher income in retirement means higher Medicare premiums, which is why retirement income planning matters.

**ACA (Affordable Care Act) marketplace:** The health insurance exchanges used by Americans without employer coverage and before they become Medicare-eligible at age 65. Relevant for early retirees who need to bridge the gap between leaving work and Medicare.

---

*End of PRD v0.1. This document is a living artifact and will be versioned alongside the code.*
