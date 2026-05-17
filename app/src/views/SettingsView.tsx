import { useRef, useState } from 'react';
import { PageHead } from '../components/PageHead';
import {
  downloadExport,
  downloadZipExport,
  eraseEverything,
  importBackup,
} from '../lib/db/backup';
import { clearDemoData } from '../lib/db/seed';

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
};

type DataStatus = { kind: 'ok' | 'err'; text: string } | null;

function formatRowCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function SettingsView({ tweaks, setTweak, onRestartOnboarding }: Props) {
  const [provider, setProvider] = useState('yahoo');
  const [dateFormat, setDateFormat] = useState('MDY');
  const [offline, setOffline] = useState(false);
  const [dataStatus, setDataStatus] = useState<DataStatus>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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

  async function handleClearDemo(): Promise<void> {
    await withBusy(async () => {
      await clearDemoData();
      return { kind: 'ok', text: 'Demo portfolio cleared. Real accounts you imported are still here.' };
    });
  }

  return (
    <div>
      <PageHead
        title="Settings"
        meta={
          <div>
            <div>Matmon · v{__APP_VERSION__} · {__APP_GIT_SHA__}</div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              Local · ~/Library/Application Support/matmon
            </div>
          </div>
        }
      />

      <div className="settings-grid">
        <aside className="settings-rail">
          {[
            { id: 'general', label: 'General' },
            { id: 'privacy', label: 'Privacy & network' },
            { id: 'quotes', label: 'Market data' },
            { id: 'data', label: 'Your data' },
            { id: 'about', label: 'About' },
          ].map(s => (
            <a key={s.id} href={`#${s.id}`} className={`settings-rail-item ${s.id === 'general' ? 'active' : ''}`}>
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
            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Date format</div>
              </div>
              <div className="settings-control">
                <div className="seg">
                  <button className={dateFormat === 'MDY' ? 'active' : ''} onClick={() => setDateFormat('MDY')}>
                    May 17, 2026
                  </button>
                  <button className={dateFormat === 'DMY' ? 'active' : ''} onClick={() => setDateFormat('DMY')}>
                    17 May 2026
                  </button>
                  <button className={dateFormat === 'ISO' ? 'active' : ''} onClick={() => setDateFormat('ISO')}>
                    2026-05-17
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section id="privacy" className="settings-section">
            <h2 className="settings-h2">Privacy & network</h2>
            <div className="privacy-pledge">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--gain)' }} />
                <strong>One outbound call only.</strong>
              </div>
              We send anonymous ticker requests to a public market-data API. We don't transmit your
              transactions, balances, identity, or device fingerprint. Toggle <strong>Offline mode</strong> to cut
              even that one connection.
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Offline mode</div>
                <div className="hint">No outbound network at all. Last-known prices are used.</div>
              </div>
              <div className="settings-control">
                <Switch on={offline} onChange={setOffline} />
              </div>
            </div>

            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-label">
                <div className="lab">Recent outbound calls</div>
                <div className="hint">Logged locally. The contents you see is everything we sent.</div>
              </div>
              <div className="settings-control" style={{ width: '100%' }}>
                <div className="net-log">
                  {[
                    { t: '15:01:12', host: 'query2.finance.yahoo.com', payload: '12 symbols · 388 B', ms: 142 },
                    { t: '14:46:08', host: 'query2.finance.yahoo.com', payload: '12 symbols · 388 B', ms: 138 },
                    { t: '14:31:08', host: 'query2.finance.yahoo.com', payload: '12 symbols · 388 B', ms: 167 },
                    { t: '14:16:09', host: 'query2.finance.yahoo.com', payload: '12 symbols · 388 B', ms: 121 },
                    { t: '14:01:08', host: 'query2.finance.yahoo.com', payload: '12 symbols · 388 B', ms: 156 },
                  ].map((r, i) => (
                    <div className="net-log-row" key={i}>
                      <span className="num muted" style={{ fontSize: 11 }}>
                        {r.t}
                      </span>
                      <span className="net-host">{r.host}</span>
                      <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                        {r.payload}
                      </span>
                      <span className="num muted" style={{ fontSize: 11 }}>
                        {r.ms} ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section id="quotes" className="settings-section">
            <h2 className="settings-h2">Market data</h2>
            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-label">
                <div className="lab">Quote provider</div>
                <div className="hint">Yahoo works without an API key. Others need one you supply.</div>
              </div>
              <div
                className="settings-control"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}
              >
                {[
                  { id: 'yahoo', label: 'Yahoo Finance', sub: 'Default · no key required', soon: false },
                  { id: 'alpha', label: 'Alpha Vantage', sub: 'Coming in a jiffy', soon: true },
                  { id: 'finn', label: 'Finnhub', sub: 'Coming in a jiffy', soon: true },
                ].map(o => (
                  <label
                    key={o.id}
                    className={`radio-card ${provider === o.id ? 'active' : ''}`}
                    style={o.soon ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                  >
                    <input
                      type="radio"
                      name="provider"
                      checked={provider === o.id}
                      disabled={o.soon}
                      onChange={() => !o.soon && setProvider(o.id)}
                    />
                    <div>
                      <div className="radio-label">
                        {o.label}
                        {o.soon && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 10,
                              fontFamily: 'var(--font-mono)',
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              color: 'var(--ink-4)',
                              border: '1px solid var(--line)',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}
                          >
                            Soon
                          </span>
                        )}
                      </div>
                      <div className="radio-sub">{o.sub}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label">
                <div className="lab">Refresh interval</div>
                <div className="hint">During US market hours, M–F.</div>
              </div>
              <div className="settings-control">
                <div className="seg">
                  {['5 min', '15 min', '30 min', '1 hour'].map(o => (
                    <button key={o} className={o === '15 min' ? 'active' : ''}>
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section id="data" className="settings-section">
            <h2 className="settings-h2">Your data</h2>
            <p className="settings-blurb">
              Matmon keeps everything in a local SQLite file. Take it with you, back it up, or wipe it, your call.
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
              <button className="btn" onClick={handleClearDemo} disabled={dataBusy}>
                Clear demo portfolio
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
              <span className="num">~/Library/Application Support/matmon/portfolio.db</span>
              <span className="num muted">2.4 MB · 1,847 transactions</span>
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
                <div style={{ fontSize: 15, marginTop: 2 }}>{__APP_VERSION__} · ({__APP_GIT_SHA__})</div>
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
                    style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px solid var(--line)' }}
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
              <em>Matmon</em> is the Hebrew word for hidden treasure (from a root meaning "to bury").
              Pronounced maht-MOAN. Built because your money should be yours.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
