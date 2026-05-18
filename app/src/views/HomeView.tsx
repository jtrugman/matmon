import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { Timeframe } from '../components/Timeframe';
import { PortfolioChart } from '../components/charts/PortfolioChart';
import { Donut } from '../components/charts/Donut';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { fmtMoney, fmtPct, fmtDate } from '../lib/format';
import { annualizeTwr, flowsFromTransactions, twr, xirr } from '../lib/performance';
import { generateTransactions } from '../lib/transactions';
import type { MatmonData } from '../data';

// Greeting pools. Every phrase is 3 words or fewer per Justin's spec. Pools
// rotate by time of day (morning/afternoon/evening/late) and weekday vs weekend
// (Sat/Sun get their own pool per slot). One phrase is picked at random on
// mount, so the same hour produces a fresh phrase on every reload.
const GREETINGS = {
  morningWeekday: ['Top of the morning', 'Rise and shine', 'Coffee’s on', 'Early bird', 'Morning, friend', 'Up and at ’em'],
  morningWeekend: ['Slow morning', 'Lazy Sunday', 'Pajama check', 'Coffee’s on', 'Easy does it', 'Weekend brunch'],
  afternoonWeekday: ['Afternoon check', 'Hey there', 'Quick look?', 'Halfway home', 'Lunch break?', 'Mid-day peek'],
  afternoonWeekend: ['Weekend mode', 'Hey there', 'Slow afternoon', 'Lazy Saturday', 'No rush', 'Just chilling'],
  eveningWeekday: ['Evening, friend', 'Day’s done', 'Welcome back', 'After-hours peek', 'Cozy hours', 'Wind down'],
  eveningWeekend: ['Evening, friend', 'Wind down', 'Soft evening', 'Hey, you', 'Weekend vibes', 'Pajama time'],
  lateWeekday: ['Up late?', 'Night owl', 'Burning oil', 'Past bedtime', 'Hello, night', 'Insomnia mode'],
  lateWeekend: ['Night owl', 'Late one?', 'Pajama o’clock', 'Past bedtime', 'Weekend night', 'Up late?'],
};

function pickGreeting(now: Date): string {
  const h = now.getHours();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  let pool: string[];
  if (h >= 5 && h < 12) pool = isWeekend ? GREETINGS.morningWeekend : GREETINGS.morningWeekday;
  else if (h >= 12 && h < 17) pool = isWeekend ? GREETINGS.afternoonWeekend : GREETINGS.afternoonWeekday;
  else if (h >= 17 && h < 21) pool = isWeekend ? GREETINGS.eveningWeekend : GREETINGS.eveningWeekday;
  else pool = isWeekend ? GREETINGS.lateWeekend : GREETINGS.lateWeekday;
  return pool[Math.floor(Math.random() * pool.length)];
}

function useGreeting(name: string) {
  // Pick once on mount so the phrase is stable while the view is open, but a
  // fresh reload of Home gives you a new one.
  return useMemo(() => ({ phrase: pickGreeting(new Date()), name }), [name]);
}

type Props = {
  data: MatmonData;
  chartVariant: 'area' | 'line' | 'bars';
  onNavigate: (view: string) => void;
  onAddAccount?: (brokerage?: string) => void;
  onRefreshQuotes?: () => void;
  userName?: string | null;
};

export function HomeView({ data, chartVariant, onNavigate, onAddAccount, onRefreshQuotes, userName }: Props) {
  const [timeframe, setTimeframe] = useState('5Y');
  const [showBenchmark, setShowBenchmark] = useState(true);
  const greeting = useGreeting(userName || 'Justin');

  const series = data.series;
  const spy = data.spy;
  const endV = series[series.length - 1].value;
  const ytdStart = series.find(p => p.date.getFullYear() === 2026)?.value ?? endV;
  const ytdRet = (endV - ytdStart) / ytdStart;

  const { oneYearTwr, allTimeXirr, xirrSinceLabel } = useMemo(() => {
    const oneYearSlice = series.slice(-13);
    const cum = twr(oneYearSlice);
    let oneYearTwr = NaN;
    if (oneYearSlice.length >= 2) {
      const days = (+oneYearSlice[oneYearSlice.length - 1].date - +oneYearSlice[0].date) / 86_400_000;
      oneYearTwr = annualizeTwr(cum, days);
    }

    const txs = generateTransactions(data);
    const mappedTxs = txs.map(t => ({
      date: t.date,
      action: t.action === 'div' ? 'dividend' : t.action,
      quantity: t.qty,
      price: t.price,
      fees: t.fees,
      amount: t.amount ?? null,
    }));
    const flows = flowsFromTransactions(mappedTxs);
    const today = new Date('2026-05-17');
    flows.push({ date: today, amount: data.totalValue });
    const allTimeXirr = xirr(flows);

    const earliestTx = txs.reduce<Date | null>((min, t) => (!min || t.date < min ? t.date : min), null);
    const earliest = earliestTx ?? series[0].date;
    const xirrSinceLabel = `since ${fmtDate(earliest, 'monthYear')}`;

    return { oneYearTwr, allTimeXirr, xirrSinceLabel };
  }, [data, series]);

  const oneYearTwrDisplay = isFinite(oneYearTwr) ? fmtPct(oneYearTwr) : '—';
  const allTimeXirrDisplay = isFinite(allTimeXirr) ? fmtPct(allTimeXirr) : '—';
  const oneYearTwrClass = isFinite(oneYearTwr) && oneYearTwr < 0 ? 'down' : 'up';
  const allTimeXirrClass = isFinite(allTimeXirr) && allTimeXirr < 0 ? 'down' : 'up';

  const typeTotals = data.accountTypes
    .map(t => {
      const v = data.accounts.filter(a => a.type === t.id).reduce((s, a) => s + a.value, 0);
      return { ...t, value: v };
    })
    .filter(t => t.value > 0);

  return (
    <div>
      <PageHead
        title={
          <span>
            <span style={{ color: 'var(--ink-3)' }}>{greeting.phrase},</span> {greeting.name}.
          </span>
        }
        meta={
          <div>
            <div>Sunday · May 17, 2026</div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Markets closed · prices Fri 4:00pm ET</div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}>
              Add an Account
            </button>
            <button className="btn btn-primary" onClick={() => onRefreshQuotes?.()}>
              Refresh quotes
            </button>
          </div>
        }
      />

      <div className="card" style={{ padding: '28px 30px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="card-title">Total portfolio · all accounts</div>
            <div className="total-figure" style={{ marginTop: 10 }}>
              <span className="dollar">$</span>
              {Math.floor(data.totalValue).toLocaleString()}
              <span className="cents">.{(data.totalValue % 1).toFixed(2).slice(2)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <span className={`delta ${data.totalDayChange >= 0 ? 'up' : 'down'}`}>
                <span className="arrow">{data.totalDayChange >= 0 ? '↑' : '↓'}</span>
                {data.totalDayChange >= 0 ? '+' : ''}
                {fmtMoney(data.totalDayChange, { cents: false })}
                <span style={{ opacity: 0.7 }}>
                  {' '}
                  · {((data.totalDayChange / data.totalValue) * 100).toFixed(2)}%
                </span>
              </span>
              <span className="muted" style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)' }}>
                today
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Timeframe value={timeframe} onChange={setTimeframe} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {showBenchmark ? (
                <span className="compare-pill">
                  vs SPY (S&P 500)
                  <span className="x" onClick={() => setShowBenchmark(false)}>
                    ×
                  </span>
                </span>
              ) : (
                <button className="compare-input" onClick={() => setShowBenchmark(true)}>
                  + compare to…
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <PortfolioChart
            series={series}
            benchmark={spy}
            showBenchmark={showBenchmark}
            variant={chartVariant}
            height={320}
          />
        </div>

        <div className="metric-grid">
          <div className="metric">
            <div className="metric-label">Today</div>
            <div className={`metric-value ${data.totalDayChange >= 0 ? 'up' : 'down'}`}>
              {data.totalDayChange >= 0 ? '+' : ''}
              {fmtMoney(data.totalDayChange, { cents: false })}
              <span className="sub">{((data.totalDayChange / data.totalValue) * 100).toFixed(2)}%</span>
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">YTD return</div>
            <div className="metric-value up">
              {(ytdRet * 100).toFixed(2)}%<span className="sub">vs SPY +6.2%</span>
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">1Y return (TWR)</div>
            <div className={`metric-value ${oneYearTwrClass}`}>
              {oneYearTwrDisplay}<span className="sub">annualized</span>
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">All-time XIRR</div>
            <div className={`metric-value ${allTimeXirrClass}`}>
              {allTimeXirrDisplay}<span className="sub">{xirrSinceLabel}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title-row">
          <div className="card-title">Brokerages</div>
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {new Set(data.accounts.map(a => a.brokerage)).size} custodians · {data.accounts.length} accounts
          </span>
        </div>
        <div className="brokerage-grid">
          {Object.entries(
            data.accounts.reduce<Record<string, { name: string; value: number; count: number; dayChange: number }>>(
              (acc, a) => {
                if (!acc[a.brokerage]) acc[a.brokerage] = { name: a.brokerage, value: 0, count: 0, dayChange: 0 };
                acc[a.brokerage].value += a.value;
                acc[a.brokerage].count += 1;
                acc[a.brokerage].dayChange += a.dayChange;
                return acc;
              },
              {},
            ),
          )
            .map(([, b]) => ({ ...b, share: b.value / data.totalValue }))
            .sort((a, b) => b.value - a.value)
            .map(b => (
              <button
                className="brokerage-tile"
                key={b.name}
                onClick={() => onNavigate('buckets')}
                title={`View ${b.name} accounts`}
              >
                <BrokerageLogo name={b.name} />
                <div className="brokerage-tile-name">{b.name}</div>
                <div className="brokerage-tile-value">{fmtMoney(b.value, { cents: false })}</div>
                <div className="brokerage-tile-meta">
                  {b.count} account{b.count === 1 ? '' : 's'} · {(b.share * 100).toFixed(1)}%
                </div>
                <div className={`brokerage-tile-delta ${b.dayChange >= 0 ? 'up' : 'down'}`}>
                  {b.dayChange >= 0 ? '+' : ''}
                  {fmtMoney(b.dayChange, { cents: false })} today
                </div>
              </button>
            ))}
          <button
            className="brokerage-add"
            onClick={() => (onAddAccount ? onAddAccount() : onNavigate('import'))}
            aria-label="Add an account"
          >
            <div className="brokerage-add-glyph">+</div>
            <div className="brokerage-add-label">Add an account</div>
            <div className="brokerage-add-sub">Drop a CSV from anywhere</div>
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18, marginTop: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Composition · by account type</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {typeTotals.length} types
            </span>
          </div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <Donut
              segments={typeTotals.map(t => ({ label: t.label, value: t.value, color: t.color }))}
              size={148}
              thickness={20}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {typeTotals.map(t => (
                <div
                  key={t.id}
                  style={{ display: 'grid', gridTemplateColumns: '10px 1fr auto', gap: 8, alignItems: 'center' }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color }} />
                  <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>{t.label}</span>
                  <span className="num muted" style={{ fontSize: 12 }}>
                    {((t.value / data.totalValue) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Accounts · {data.accounts.length}</div>
            <a
              className="muted"
              style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textDecoration: 'none', cursor: 'pointer' }}
              onClick={() => onNavigate('buckets')}
            >
              Manage →
            </a>
          </div>
          <div className="accounts-list">
            {data.accounts.map(a => {
              const t = data.accountTypes.find(x => x.id === a.type)!;
              const glyph = a.brokerage[0];
              return (
                <div className="account-row" key={a.id}>
                  <div className="acct-glyph">{glyph}</div>
                  <div>
                    <div className="acct-name">{a.name}</div>
                    <div className="acct-meta">
                      {a.brokerage} · {t.label}
                    </div>
                  </div>
                  <div>
                    <div className="acct-value">{fmtMoney(a.value, { cents: true })}</div>
                    <div
                      className="acct-meta right"
                      style={{ color: a.dayChange >= 0 ? 'var(--gain)' : 'var(--loss)' }}
                    >
                      {a.dayChange >= 0 ? '+' : ''}
                      {fmtMoney(a.dayChange, { cents: true })}
                    </div>
                  </div>
                  <div className="acct-share">{((a.value / data.totalValue) * 100).toFixed(1)}%</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, marginTop: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Recent activity</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              Last 14 days
            </span>
          </div>
          <div>
            {data.activity.map((a, i) => (
              <div className="activity-row" key={i}>
                <span className="activity-date">{a.date}</span>
                <span>
                  <span className={`activity-act ${a.action}`}>{a.action === 'div' ? 'Div' : a.action}</span>
                  <span style={{ color: 'var(--ink)' }}>{a.desc}</span>
                </span>
                <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  {a.account}
                </span>
                <span
                  className="activity-amt"
                  style={{ color: a.amount >= 0 ? 'var(--gain)' : 'var(--ink)' }}
                >
                  {a.amount >= 0 ? '+' : ''}
                  {fmtMoney(a.amount, { cents: true })}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Dividends · 2026 YTD</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              $4,820
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {[
              { mo: 'Jan', v: 1240 },
              { mo: 'Feb', v: 380 },
              { mo: 'Mar', v: 1620 },
              { mo: 'Apr', v: 420 },
              { mo: 'May', v: 1160 },
            ].map(m => (
              <div
                key={m.mo}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr 80px',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <span className="num muted" style={{ fontSize: 11 }}>
                  {m.mo}
                </span>
                <div style={{ height: 6, background: 'var(--paper-3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(m.v / 1700) * 100}%`,
                      background: 'var(--accent)',
                      borderRadius: 3,
                    }}
                  />
                </div>
                <span className="num right" style={{ fontSize: 12 }}>
                  ${m.v.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <div
            className="disclaimer"
            style={{ borderTop: '1px solid var(--line-soft)', marginTop: 16, fontSize: 11 }}
          >
            Lifetime dividends ·{' '}
            <span className="num" style={{ color: 'var(--ink)' }}>
              $28,640
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
