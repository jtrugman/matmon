import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PageHead } from '../components/PageHead';
import { downloadExport, downloadZipExport, eraseEverything, importBackup } from '../lib/db/backup';
import { isTauri } from '../lib/env';
import {
  getPriceCoverage,
  getSetting,
  listAccounts,
  listTransactions,
  setSetting,
} from '../lib/db/repos';
import { networkLog } from '../lib/quotes/log';
import { setOffline } from '../lib/quotes';
import { backfillHistoricalPrices, filterBackfillSymbols } from '../lib/quotes/backfill';
import {
  AUTO_REFRESH_ENABLED_KEY,
  AUTO_REFRESH_INTERVAL_KEY,
  AUTO_REFRESH_INTERVALS,
  type AutoRefreshIntervalMin,
} from '../lib/autoRefresh';
import type { NetworkLogEntry } from '../lib/quotes/types';

const NET_LOG_MAX_ROWS = 20;

function formatLogTime(d: Date): string {
  // HH:MM:SS, 24-hour, local. Mirrors the previous prototype's display.
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatPayload(entry: NetworkLogEntry): string {
  const sym = entry.symbols?.length ?? 0;
  const symPart = sym > 0 ? `${sym} symbol${sym === 1 ? '' : 's'}` : '-';
  return `${symPart} · ${formatBytes(entry.bytes)}`;
}

// useSyncExternalStore requires getSnapshot() to return a referentially-stable
// value while the underlying store hasn't changed (otherwise React would loop).
// networkLog.list() allocates a new array on every call, so we cache the last
// returned reference and only refresh it when subscribe() fires.
let cachedSnapshot: NetworkLogEntry[] = networkLog.list();
let snapshotDirty = false;
networkLog.subscribe(() => {
  snapshotDirty = true;
});

function useNetworkLog(): NetworkLogEntry[] {
  const subscribe = useCallback((onChange: () => void) => networkLog.subscribe(onChange), []);
  const getSnapshot = useCallback(() => {
    if (snapshotDirty) {
      cachedSnapshot = networkLog.list();
      snapshotDirty = false;
    }
    return cachedSnapshot;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        background: on ? 'var(--accent)' : 'var(--paper-3)',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        padding: 0,
        transition: 'background 150ms',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'var(--paper)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 150ms',
        }}
      />
    </button>
  );
}

type Props = {
  tweaks: { theme: string };
  setTweak: (k: any, v?: any) => void;
  onRestartOnboarding: () => void;
  /** Optional: when the "Refresh history" button finishes a backfill the
   *  parent can re-read the DB so the chart picks up the new bars without a
   *  full reload. App.tsx supplies usePortfolio.reload here; tests / isolated
   *  renders can omit it. */
  onReloadPortfolio?: () => void | Promise<void>;
  /**
   * Notify the parent that the auto-refresh setting changed so it can
   * rebuild the runtime with the new (enabled, intervalMin) pair. The
   * parent reads the persisted values back from getSetting on app boot;
   * this callback only fires the live rebuild while the user is in
   * Settings.
   */
  onAutoRefreshChange?: (enabled: boolean, intervalMin: AutoRefreshIntervalMin) => void;
};

type DataStatus = { kind: 'ok' | 'err'; text: string } | null;

function formatRowCount(n: number): string {
  return n.toLocaleString('en-US');
}

// Best-effort platform label for the DB-location footer. Browser dev sessions
// don't have a filesystem path; Tauri targets land in the per-OS app-data dir.
function describeDbLocation(): string {
  if (!isTauri()) return '(in-browser dev storage)';
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/Mac OS X|Macintosh/i.test(ua)) {
      return '~/Library/Application Support/matmon/portfolio.db';
    }
    if (/Windows/i.test(ua)) {
      return '%APPDATA%/matmon/portfolio.db';
    }
    if (/Linux/i.test(ua)) {
      return '~/.local/share/matmon/portfolio.db';
    }
  }
  return 'matmon/portfolio.db';
}

const RAIL_SECTION_IDS = ['general', 'privacy', 'quotes', 'data', 'about'] as const;
type RailSection = (typeof RAIL_SECTION_IDS)[number];

export function SettingsView({
  tweaks,
  setTweak,
  onRestartOnboarding,
  onReloadPortfolio,
  onAutoRefreshChange,
}: Props) {
  const [offlineOn, setOfflineOn] = useState(false);
  const [dataStatus, setDataStatus] = useState<DataStatus>(null);
  const [dataBusy, setDataBusy] = useState(false);
  // Auto-refresh: persisted toggle + interval. Defaults match the spec:
  // OFF, 5 minutes. We load the saved values on mount; the user's edits
  // persist immediately via setSetting so a reload preserves their choice.
  const [autoRefreshOn, setAutoRefreshOn] = useState(false);
  const [autoRefreshInterval, setAutoRefreshIntervalState] = useState<AutoRefreshIntervalMin>(5);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [enabledRaw, intervalRaw] = await Promise.all([
          getSetting(AUTO_REFRESH_ENABLED_KEY),
          getSetting(AUTO_REFRESH_INTERVAL_KEY),
        ]);
        if (cancelled) return;
        setAutoRefreshOn(enabledRaw === 'yes');
        const parsed = Number(intervalRaw);
        if (
          Number.isFinite(parsed) &&
          AUTO_REFRESH_INTERVALS.includes(parsed as AutoRefreshIntervalMin)
        ) {
          setAutoRefreshIntervalState(parsed as AutoRefreshIntervalMin);
        }
      } catch {
        // Read failure is non-fatal; defaults stand.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleAutoRefresh = useCallback(
    async (next: boolean) => {
      setAutoRefreshOn(next);
      try {
        await setSetting(AUTO_REFRESH_ENABLED_KEY, next ? 'yes' : 'no');
      } catch {
        // Persistence failure leaves the local state set; the next load
        // will revert to the prior persisted value, which is the safe
        // outcome (a refresh wouldn't have started anyway).
      }
      onAutoRefreshChange?.(next, autoRefreshInterval);
    },
    [autoRefreshInterval, onAutoRefreshChange],
  );
  const pickAutoRefreshInterval = useCallback(
    async (next: AutoRefreshIntervalMin) => {
      setAutoRefreshIntervalState(next);
      try {
        await setSetting(AUTO_REFRESH_INTERVAL_KEY, String(next));
      } catch {
        // Persistence failure: same reasoning as the toggle path.
      }
      // The interval change only restarts the runtime if the toggle is on;
      // App.tsx's effect re-runs whenever enabled OR interval changes, so
      // the conditional here just avoids a noisy callback when there's
      // nothing to do.
      if (autoRefreshOn) onAutoRefreshChange?.(true, next);
    },
    [autoRefreshOn, onAutoRefreshChange],
  );
  // Backfill button state: idle → busy with progress text → done. Mirrors
  // the Home Refresh-quotes afterglow so the user sees a clear "yes,
  // something happened" rather than a silent click. Progress text is set
  // by the backfill orchestrator's onProgress callback.
  const [backfillState, setBackfillState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [backfillProgress, setBackfillProgress] = useState<string>('');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const liveLog = useNetworkLog();
  // networkLog.list() already returns newest-first (push uses unshift), so just
  // cap to the last N entries for display.
  const recentLog = liveLog.slice(0, NET_LOG_MAX_ROWS);

  // Real DB stats (account / transaction count). The "2.4 MB · 1,847
  // transactions" footer previously hardcoded both numbers regardless of what
  // the user actually had. File size isn't exposed via the browser shim so we
  // omit it outside Tauri.
  const [dbStats, setDbStats] = useState<{ accounts: number; transactions: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [accts, txs] = await Promise.all([listAccounts(), listTransactions()]);
        if (!cancelled) setDbStats({ accounts: accts.length, transactions: txs.length });
      } catch {
        if (!cancelled) setDbStats({ accounts: 0, transactions: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
    // dataStatus is included so freshly imported/erased data refreshes the
    // footer counts without a route change.
  }, [dataStatus]);

  // Scroll-spy: track which section the user is reading so the left rail
  // highlights the right pill instead of always pinning to "General".
  const [activeRail, setActiveRail] = useState<RailSection>('general');
  useEffect(() => {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    const sections = RAIL_SECTION_IDS.map(id => document.getElementById(id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      entries => {
        // Pick the topmost section that's at least partially visible.
        const visible = entries.filter(e => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0].target.id as RailSection;
        if (RAIL_SECTION_IDS.includes(id)) setActiveRail(id);
      },
      { rootMargin: '0px 0px -55% 0px', threshold: [0, 0.1, 0.5, 1] },
    );
    for (const el of sections) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function withBusy(work: () => Promise<DataStatus>): Promise<void> {
    if (dataBusy) return;
    setDataBusy(true);
    try {
      const next = await work();
      setDataStatus(next);
    } catch (e: any) {
      setDataStatus({ kind: 'err', text: e?.message || 'Something went wrong.' });
    } finally {
      setDataBusy(false);
    }
  }

  async function handleExportJson(): Promise<void> {
    await withBusy(async () => {
      const { filename, rowCount } = await downloadExport();
      return {
        kind: 'ok',
        text: `Exported ${formatRowCount(rowCount)} rows to ${filename}`,
      };
    });
  }

  async function handleExportZip(): Promise<void> {
    await withBusy(async () => {
      const { filename, rowCount } = await downloadZipExport();
      return {
        kind: 'ok',
        text: `Exported ${formatRowCount(rowCount)} rows (with CSVs) to ${filename}`,
      };
    });
  }

  function handleImportClick(): void {
    if (dataBusy) return;
    importInputRef.current?.click();
  }

  async function handleImportChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be picked twice in a row.
    e.target.value = '';
    if (!file) return;
    await withBusy(async () => {
      const { tablesRestored, rowCount } = await importBackup(file);
      return {
        kind: 'ok',
        text: `Restored ${formatRowCount(rowCount)} rows across ${tablesRestored.length} tables from ${file.name}`,
      };
    });
  }

  async function handleRefreshHistory(): Promise<void> {
    if (backfillState === 'busy') return;
    setBackfillState('busy');
    setBackfillProgress('Loading…');
    try {
      const txs = await listTransactions();
      if (txs.length === 0) {
        setBackfillProgress('No transactions yet. Import a CSV first.');
        setBackfillState('idle');
        return;
      }
      const symbols = filterBackfillSymbols(txs.map(t => t.symbol));
      if (symbols.length === 0) {
        setBackfillProgress('No equity symbols to refresh.');
        setBackfillState('idle');
        return;
      }
      // Earliest tx date across the whole portfolio: bound the fetch window.
      let earliest = new Date();
      for (const t of txs) {
        const d = new Date(t.date);
        if (d < earliest) earliest = d;
      }
      const { ok, failed } = await backfillHistoricalPrices(
        symbols,
        earliest,
        (done, total, sym) => {
          setBackfillProgress(`Fetching ${sym}… (${done}/${total})`);
        },
        { force: true },
      );
      const successCount = ok.length;
      const failCount = failed.length;
      // Sum stored bars across the symbols we just touched so the user sees
      // a tangible "Refreshed 17 symbols, 119,000 bars" rather than just a
      // symbol count. Coverage probes are cheap (one MIN/MAX per symbol).
      let totalBars = 0;
      for (const sym of ok) {
        try {
          const cov = await getPriceCoverage(sym);
          if (cov) totalBars += cov.count;
        } catch {
          // Coverage probe failure is non-fatal; we just under-report bars.
        }
      }
      const barCountText =
        totalBars > 0
          ? `, ${totalBars.toLocaleString('en-US')} bar${totalBars === 1 ? '' : 's'}`
          : '';
      setBackfillProgress(
        `Refreshed ${successCount} symbol${successCount === 1 ? '' : 's'}${barCountText}` +
          (failCount > 0
            ? `. ${failCount} symbol${failCount === 1 ? '' : 's'} failed: ${failed.slice(0, 3).join(', ')}${failCount > 3 ? '…' : ''}`
            : '.'),
      );
      setBackfillState('done');
      // Reload the portfolio so the chart picks up the new bars.
      try {
        await Promise.resolve(onReloadPortfolio?.());
      } catch {
        // Reload failure isn't fatal; the user can navigate away and back.
      }
      setTimeout(() => {
        setBackfillState('idle');
        setBackfillProgress('');
      }, 2500);
    } catch (e: any) {
      setBackfillProgress(`Refresh failed: ${e?.message || 'Unknown error'}`);
      setBackfillState('idle');
    }
  }

  async function handleErase(): Promise<void> {
    const confirmed = window.confirm(
      'Erase everything? This wipes all accounts, transactions, prices, and settings from this device. Export a backup first if you want to keep your data.',
    );
    if (!confirmed) return;
    await withBusy(async () => {
      await eraseEverything();
      return { kind: 'ok', text: 'All local data erased.' };
    });
  }

  return (
    <div>
      <PageHead
        title="Settings"
        meta={
          <div>
            <div>
              Matmon · v{__APP_VERSION__} · {__APP_GIT_SHA__}
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Local · {describeDbLocation()}</div>
          </div>
        }
      />

      <div className="settings-grid">
        <aside className="settings-rail">
          {[
            { id: 'general' as const, label: 'General' },
            { id: 'privacy' as const, label: 'Privacy & network' },
            { id: 'quotes' as const, label: 'Market data' },
            { id: 'data' as const, label: 'Your data' },
            { id: 'about' as const, label: 'About' },
          ].map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`settings-rail-item ${activeRail === s.id ? 'active' : ''}`}
              onClick={() => setActiveRail(s.id)}
            >
              {s.label}
            </a>
          ))}
        </aside>

        <div className="settings-main">
          <section id="general" className="settings-section">
            <h2 className="settings-h2">General</h2>
            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Theme</div>
                <div className="hint">Light by day, dark by night. Or whatever you like.</div>
              </div>
              <div className="settings-control">
                <div className="seg">
                  {['light', 'dark'].map(t => (
                    <button
                      key={t}
                      className={tweaks.theme === t ? 'active' : ''}
                      onClick={() => setTweak('theme', t)}
                    >
                      {t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {/* Date format picker hidden until plumbing exists. Previously this
                segmented control was local state with no effect: the values
                never reached fmtDate (which reads month/day/year hardcoded).
                We can wire it via a context once the format is plumbed. */}
          </section>

          <section id="privacy" className="settings-section">
            <h2 className="settings-h2">Privacy & network</h2>
            <div className="privacy-pledge">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--gain)' }} />
                <strong>One outbound call only.</strong>
              </div>
              We send anonymous ticker requests to a public market-data API. We don't transmit your
              transactions, balances, identity, or device fingerprint. Toggle <strong>Offline mode</strong> to
              cut even that one connection.
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Offline mode</div>
                <div className="hint">No outbound network at all. Last-known prices are used.</div>
              </div>
              <div className="settings-control">
                <Switch
                  on={offlineOn}
                  onChange={v => {
                    // Honor the privacy pledge: setOffline() flips the real
                    // flag in src/lib/quotes/index.ts that refreshQuotes()
                    // checks before hitting any network.
                    setOfflineOn(v);
                    setOffline(v);
                  }}
                />
              </div>
            </div>

            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-label">
                <div className="lab">Recent outbound calls</div>
                <div className="hint">Logged locally. The contents you see is everything we sent.</div>
              </div>
              <div className="settings-control" style={{ width: '100%' }}>
                <div className="net-log">
                  {recentLog.length === 0 ? (
                    <div className="net-log-row">
                      <span className="muted" style={{ fontSize: 12 }}>
                        No outbound calls yet this session.
                      </span>
                    </div>
                  ) : (
                    recentLog.map((r, i) => (
                      <div className="net-log-row" key={`${r.t.getTime()}-${i}`}>
                        <span className="num muted" style={{ fontSize: 11 }}>
                          {formatLogTime(r.t)}
                        </span>
                        <span className="net-host">{r.host}</span>
                        <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          {formatPayload(r)}
                        </span>
                        <span className="num muted" style={{ fontSize: 11 }}>
                          {r.durationMs} ms
                        </span>
                        <span
                          className="num"
                          style={{
                            fontSize: 10,
                            fontFamily: 'var(--font-mono)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: r.ok ? 'var(--gain)' : 'var(--loss)',
                            border: '1px solid var(--line)',
                            borderRadius: 4,
                            padding: '1px 5px',
                          }}
                        >
                          {r.ok ? 'ok' : 'fail'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          <section id="quotes" className="settings-section">
            <h2 className="settings-h2">Market data</h2>
            <p className="settings-blurb">
              Quotes are fetched from Yahoo Finance, no API key required. Use the Refresh quotes button on the
              Home page to pull the latest prices, or refresh the full price history below.
            </p>
            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Auto-refresh quotes</div>
                <div className="hint">
                  Re-fetch quotes every N minutes while the app is in the foreground. Off by default to keep
                  network noise minimal.
                </div>
              </div>
              <div className="settings-control">
                <Switch on={autoRefreshOn} onChange={toggleAutoRefresh} />
              </div>
            </div>
            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-label">
                <div className="lab">Interval</div>
                <div className="hint">How often to re-fetch when auto-refresh is on.</div>
              </div>
              <div className="settings-control">
                <div
                  className="seg"
                  aria-label="Auto-refresh interval"
                  data-testid="auto-refresh-interval"
                  style={{ opacity: autoRefreshOn ? 1 : 0.45 }}
                >
                  {AUTO_REFRESH_INTERVALS.map(min => (
                    <button
                      key={min}
                      className={autoRefreshInterval === min ? 'active' : ''}
                      onClick={() => pickAutoRefreshInterval(min)}
                      disabled={!autoRefreshOn}
                      aria-pressed={autoRefreshInterval === min}
                    >
                      {min}m
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="settings-actions">
              <button
                className="btn"
                onClick={handleRefreshHistory}
                disabled={backfillState === 'busy'}
                aria-busy={backfillState === 'busy'}
              >
                {backfillState === 'busy'
                  ? 'Refreshing history…'
                  : backfillState === 'done'
                    ? 'History refreshed'
                    : 'Refresh history'}
              </button>
            </div>
            {backfillProgress && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--ink-3)',
                }}
              >
                {backfillProgress}
              </div>
            )}
            {/* Quote provider picker hidden until it controls real behavior:
                Yahoo is the only wired provider so a radio set would be
                misleading. The auto-refresh controls above are the first
                ones in this section that actually drive runtime behavior. */}
          </section>

          <section id="data" className="settings-section">
            <h2 className="settings-h2">Your data</h2>
            <p className="settings-blurb">
              Matmon keeps everything in a local SQLite file. Take it with you, back it up, or wipe it, your
              call.
            </p>
            <div className="settings-actions">
              <button className="btn" onClick={handleExportJson} disabled={dataBusy}>
                Export database (.json)
              </button>
              <button className="btn" onClick={handleExportZip} disabled={dataBusy}>
                Export as Zip (with CSVs)
              </button>
              <button className="btn" onClick={handleImportClick} disabled={dataBusy}>
                Import a backup…
              </button>
              <button
                className="btn btn-ghost"
                style={{ color: 'var(--loss)' }}
                onClick={handleErase}
                disabled={dataBusy}
              >
                Erase everything…
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={handleImportChange}
                aria-hidden="true"
                tabIndex={-1}
              />
            </div>
            {dataStatus && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  color: dataStatus.kind === 'ok' ? 'var(--ink-2)' : 'var(--loss)',
                }}
              >
                {dataStatus.text}
              </div>
            )}
            <div className="settings-actions">
              <button className="btn" onClick={onRestartOnboarding}>
                Restart onboarding
              </button>
            </div>
            <div className="db-path">
              <span className="muted">DB location</span>
              <span className="num">{describeDbLocation()}</span>
              {dbStats && (
                <span className="num muted">
                  {dbStats.accounts.toLocaleString()} account{dbStats.accounts === 1 ? '' : 's'} ·{' '}
                  {dbStats.transactions.toLocaleString()} transaction
                  {dbStats.transactions === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </section>

          <section id="about" className="settings-section">
            <h2 className="settings-h2">About</h2>
            <div className="about-grid">
              <div>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  Version
                </div>
                <div style={{ fontSize: 15, marginTop: 2 }}>
                  {__APP_VERSION__} · ({__APP_GIT_SHA__})
                </div>
              </div>
              <div>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  License
                </div>
                <div style={{ fontSize: 15, marginTop: 2 }}>MIT</div>
              </div>
              <div>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  Source
                </div>
                <div style={{ fontSize: 15, marginTop: 2 }}>
                  <a
                    href="https://github.com/jtrugman/matmon"
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{
                      color: 'inherit',
                      textDecoration: 'none',
                      borderBottom: '1px solid var(--line)',
                    }}
                  >
                    github.com/jtrugman/matmon
                  </a>
                </div>
              </div>
              <div>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  Built with
                </div>
                <div style={{ fontSize: 15, marginTop: 2 }}>Tauri · React · SQLite</div>
              </div>
            </div>
            <p
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 18,
                color: 'var(--ink-2)',
                marginTop: 24,
                lineHeight: 1.4,
                maxWidth: 540,
              }}
            >
              <em>Matmon</em> keeps your portfolio math local, private, and yours.
              Built because your money should be yours.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
