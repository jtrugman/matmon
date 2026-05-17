# Matmon

A private, beautiful, fun portfolio tracker. Built per the PRD in `../PRD.md`.

This package is the Tauri + React + TypeScript desktop app referenced in PRD §6.

## Quick start (browser dev mode)

```bash
cd app
npm install
npm run dev
```

Open http://localhost:5173. The app boots with a built-in demo portfolio (six accounts, twelve holdings, six years of monthly data, plus the just-unlocked "A millionaire" toast). Browser dev mode uses a `localStorage`-backed driver instead of SQLite so iteration is fast and no native toolchain is needed.

## Running as the real desktop app (Tauri)

The PRD calls for Tauri + SQLite + the system webview. To run that way you need the Rust toolchain on your machine:

```bash
# One-time install of rustup, which bootstraps cargo and rustc
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Then, from inside ./app
npm run tauri:dev
```

That spins up the same Vite dev server, wraps it in a native window via Tauri 2, and routes:

- `tauri-plugin-sql` → real SQLite at `~/Library/Application Support/Matmon/portfolio.db` (mac), `%AppData%\Matmon\portfolio.db` (Windows), `~/.local/share/Matmon/portfolio.db` (Linux)
- `tauri-plugin-http` → CORS-free outbound calls to Yahoo Finance (anonymous, batched, surfaced in Settings → Privacy)
- `tauri-plugin-fs` / `tauri-plugin-dialog` → local CSV picking
- `tauri-plugin-notification` → optional milestone toasts

The TS code detects which mode it's in (`window.__TAURI__`) and picks the SQLite driver vs the in-browser shim transparently, so the same React app runs both ways.

## Building signed installers

```bash
npm run tauri:build
```

Produces `.dmg` on macOS, `.msi` + `.exe` on Windows, `.AppImage` + `.deb` on Linux under `src-tauri/target/release/bundle/`. Target installer size: 10–15 MB per platform.

The bundle icon set in `src-tauri/icons/` is a generated placeholder. Replace `src-tauri/icons/source.png` with your own 1024×1024 PNG and run `npm run tauri:icon icons/source.png` to regenerate all sizes.

## What's wired up

| Area | Status |
| --- | --- |
| All 9 designed screens (Home, Accounts, Holdings, Holding detail, Transactions, Planner, Achievements, Add Account, Settings) | ✓ |
| 5-step onboarding (Welcome → Profile → Goal → Add Account → Done) | ✓ |
| Theme toggle (light/dark), Tweaks panel | ✓ |
| Milestone toasts | ✓ |
| **CSV import** for Fidelity / Schwab / JP Morgan / Human Interest with auto-detection, action mapping, raw-hash dedupe, and manual column-mapping fallback | ✓ |
| **Yahoo Finance** quote provider (live quotes + history) hitting `query1.finance.yahoo.com` via Tauri http plugin (with browser fallback) | ✓ |
| **SQLite** persistence: 10-table schema (accounts, transactions, prices, achievements, scenarios, user_profile, tax_constants, settings, symbol_metadata, lots-ready) with idempotent migrations | ✓ |
| **Tauri shell**: `Cargo.toml`, `main.rs`, `tauri.conf.json`, capability allowlist locked to the four supported quote hosts | ✓ |
| Demo seeding on first run; transitions out of "demo mode" the first time you import a real CSV | ✓ |

## Architecture

```
app/
├── src/
│   ├── main.tsx / App.tsx                   React entry + routing shell
│   ├── data.ts                              static demo portfolio
│   ├── components/                          shared UI (Sidebar, PageHead, Toast, Tweaks)
│   │   └── charts/                          SVG charts (Portfolio, Holding, Projection, Donut, Sparkline)
│   ├── views/                               one file per top-level screen
│   ├── lib/
│   │   ├── format.ts                        fmtMoney / fmtPct / fmtDate
│   │   ├── transactions.ts                  demo-tx generator
│   │   ├── portfolio.ts                     aggregates DB rows into MatmonData
│   │   ├── usePortfolio.ts                  React hook on top of the above
│   │   ├── importers/                       CSV parsers: fidelity, schwab, jpmorgan, humanInterest
│   │   ├── quotes/                          QuoteProvider interface + Yahoo impl + network log
│   │   └── db/                              schema, repos, seed, driver (Tauri SQLite vs browser shim)
│   └── styles.css                           full design system (47 KB)
├── src-tauri/                               Rust shell
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json            locked allowlist
│   ├── migrations/V1__init.sql              matches src/lib/db/schema.ts
│   └── src/{main,lib}.rs
└── index.html
```

## Privacy boundary (PRD §6)

The only outbound calls this app makes are anonymous quote requests to Yahoo. The exact URL list is visible in `src-tauri/capabilities/default.json` under `http:allow-fetch`. Toggle **Offline mode** in Settings → Privacy to cut even that.

No analytics, no telemetry, no crash reporting, no auto-update phone-home.
