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

The Dock and Finder render the macOS app icon from whatever `.icns` lives inside the running `.app` bundle's `Contents/Resources/`. Tauri copies `src-tauri/icons/icon.icns` into that path at bundle time, but the bundle is only assembled by `tauri build`, not by `tauri dev`.

### Where the Dock icon comes from in each mode

| Mode | Command | What runs | Dock icon source |
| --- | --- | --- | --- |
| Production | `npm run tauri:build` | `Matmon.app/Contents/MacOS/matmon` from the produced `.app` | `Matmon.app/Contents/Resources/icon.icns` (vault) |
| Dev | `npm run tauri:dev` | Bare `src-tauri/target/debug/matmon` binary, no `.app` wrapper | macOS generic placeholder (the binary has no embedded icns) |

So if you launch `tauri:dev` you will see a generic placeholder in the Dock and that is expected: `tauri dev` on macOS deliberately skips the `.app` bundling step to keep iteration fast. The only way to see the real vault icon in the Dock is to run `tauri:build` and open the produced bundle. There is no Tauri-supported workaround for this in dev mode short of building a full bundle every time, which would defeat the point of dev mode.

If you want a live "looks like prod" run, do:

```bash
npm run tauri:build              # produces src-tauri/target/release/bundle/macos/Matmon.app
open src-tauri/target/release/bundle/macos/Matmon.app
```

### Regenerating the icon set from a new source image

Drop your new 1024x1024 PNG at `src-tauri/icons/source.png` and run:

```bash
cd app
npm run icons:rebuild
```

`icons:rebuild` writes `icon.icns` (via `iconutil`, a real Apple-format icns the Dock and LaunchServices trust), `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`, and `icon.ico` (multi-size Windows icon, written via Pillow with a `sips` fallback). The script lives at `scripts/regen-icons.sh`.

After regenerating icons, run `npm run tauri:build` again to roll a fresh `.app` that embeds them.

### If the icon still looks stale after rebuilding

That means the macOS icon services cache (keyed by bundle id `app.matmon.desktop`) is holding onto the old image. One command:

```bash
npm run icons:flush
```

That runs `scripts/flush-icon-cache.sh`, which wipes `/Library/Caches/com.apple.iconservices.store`, the per-user IconServices and Dock icon caches under `/private/var/folders`, and restarts Dock and Finder. It will prompt for `sudo` once.

If you'd rather run it manually, the equivalent block is:

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

That runs `cargo clean` inside `src-tauri/` and then `npm run tauri:dev`, which forces Tauri to rebuild the Rust binary from scratch. Slow (a few minutes) but guaranteed clean. (Same dev-mode icon caveat above still applies: you'll see a generic placeholder in the Dock because no `.app` bundle is produced.)

### Windows and Linux icons

`src-tauri/tauri.conf.json` references `icons/icon.ico` for Windows installers (`msi`, `nsis`) and the various `icons/*.png` sizes for Linux (`deb`, `appimage`). `npm run icons:rebuild` regenerates all of them from the same `source.png`, so a single source swap covers every platform.

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
