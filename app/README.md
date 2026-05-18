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

## Updating the app icon

The Dock and Finder render the macOS app icon from `src-tauri/icons/icon.icns`, which gets copied into `Matmon.app/Contents/Resources/` during the Tauri bundle step. Two things commonly trip people up:

1. `tauri dev` rebuilds the Rust binary but does **not** always regenerate the `.app` bundle layout, so an old `icon.icns` from a previous build can keep showing up in the Dock.
2. `tauri icon` shells out to Pillow, whose `.icns` writer produces a non-standard file that macOS sometimes silently falls back from to the generic doc icon.

The fix is to (a) regenerate icons with macOS's native `sips` + `iconutil`, which produce a real Apple-format `.icns`, and (b) force Tauri to rebuild the bundle so the new icon actually lands in `Matmon.app`.

### Standard refresh

```bash
# 1. Drop your new 1024x1024 source PNG at src-tauri/icons/source.png, then:
cd app
npm run icons:rebuild

# 2. Quit any running Tauri dev window (Cmd+Q in the app), then:
npm run tauri:dev
```

`icons:rebuild` writes `icon.icns` (via `iconutil`), `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`, and `icon.ico` (via `sips`) from the same source. The script lives at `scripts/regen-icons.sh`.

### If the icon still looks stale after rebuilding

That means the macOS icon services cache (keyed by bundle id `app.matmon.desktop`) is holding onto the old image. Wipe it and restart the Dock and Finder:

```bash
sudo rm -rfv /Library/Caches/com.apple.iconservices.store
sudo find /private/var/folders/ \( -name com.apple.dock.iconcache -or -name com.apple.iconservices \) -exec rm -rfv {} \;
killall Dock
killall Finder
```

### Nuclear option: 100%-clean rebuild

If you suspect cargo is reusing a stale build artifact, run:

```bash
npm run dev:fresh
```

That runs `cargo clean` inside `src-tauri/` and then `npm run tauri:dev`, which forces Tauri to rebuild the Rust binary **and** the `.app` bundle from scratch. Slow (a few minutes) but guaranteed clean.

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
