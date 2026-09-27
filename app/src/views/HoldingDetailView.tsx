import { useMemo, useState } from 'react';
import { Timeframe } from '../components/Timeframe';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { HoldingChart } from '../components/charts/HoldingChart';
import { fmtMoney, fmtPct } from '../lib/format';
import { generateTransactions } from '../lib/transactions';
import type { Holding, MatmonData, SeriesPoint } from '../data';

function buildHoldingHistory(holding: Holding): SeriesPoint[] {
  const points = 72;
  const data: SeriesPoint[] = [];
  const startDate = new Date(2020, 4, 1);
  const startPrice = holding.basis * 0.85;
  const endPrice = holding.price;
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const wobble = Math.sin(i * 0.6) * 0.05 + Math.cos(i * 1.3) * 0.04;
    const p = startPrice + (endPrice - startPrice) * Math.pow(t, 0.9) * (1 + wobble);
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + i);
    data.push({ date: d, value: Math.max(0.1, p) });
  }
  return data;
}

type Props = {
  data: MatmonData;
  holding: Holding;
  onBack: () => void;
};

export function HoldingDetailView({ data, holding, onBack }: Props) {
  const [timeframe, setTimeframe] = useState('5Y');
  const [comparisons, setComparisons] = useState<string[]>(['SPY']);
  const [compareInput, setCompareInput] = useState('');

  const series = useMemo(() => buildHoldingHistory(holding), [holding]);
  const benchmarkSeries = useMemo(() => {
    const base = series[0].value;
    return series.map((p, i) => ({
      date: p.date,
      value: base * (1 + i * 0.012 + Math.sin(i * 0.4) * 0.04),
    }));
  }, [series]);

  const allTxs = useMemo(() => generateTransactions(data), [data]);
  const txsForHolding = allTxs.filter(t => t.symbol === holding.sym);
  const buys = txsForHolding.filter(t => t.action === 'buy');
  const sells = txsForHolding.filter(t => t.action === 'sell');
  const divs = txsForHolding.filter(t => t.action === 'div');
  const lifetimeDividends = divs.reduce((s, t) => s + (t.amount || 0), 0);

  const allMyAccounts = data.accounts;

  return (
    <div>
      <button className="back-btn" onClick={onBack}>
        ← Holdings
      </button>

      <div className="hd-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <div className="hd-sym">{holding.sym}</div>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 28,
                  color: 'var(--ink)',
                  lineHeight: 1.05,
                }}
              >
                {holding.name}
              </div>
              <div className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 2 }}>
                {holding.sector} · NYSEARCA · USD
              </div>
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="total-figure" style={{ fontSize: 36 }}>
            <span className="dollar" style={{ fontSize: 22, top: -10 }}>
              $
            </span>
            {Math.floor(holding.price).toLocaleString()}
            <span className="cents">.{(holding.price % 1).toFixed(2).slice(2)}</span>
          </div>
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <span className={`delta ${holding.gain >= 0 ? 'up' : 'down'}`}>
              <span className="arrow">{holding.gain >= 0 ? '↑' : '↓'}</span>
              {fmtPct(holding.gainPct)}
              <span style={{ opacity: 0.7 }}>all-time</span>
            </span>
            <span className="muted" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              {fmtMoney(holding.value)} value
            </span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: '20px 24px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Timeframe value={timeframe} onChange={setTimeframe} />
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {comparisons.map(c => (
                <span key={c} className="compare-pill">
                  vs {c}
                  <span className="x" onClick={() => setComparisons(comparisons.filter(x => x !== c))}>
                    ×
                  </span>
                </span>
              ))}
              <form
                onSubmit={e => {
                  e.preventDefault();
                  if (compareInput.trim()) {
                    setComparisons([...comparisons, compareInput.toUpperCase()]);
                    setCompareInput('');
                  }
                }}
              >
                <input
                  className="compare-add"
                  placeholder="+ compare to…"
                  value={compareInput}
                  onChange={e => setCompareInput(e.target.value)}
                />
              </form>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--ink-3)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 2, background: 'var(--accent)', borderRadius: 1 }} />
              <span>{holding.sym}</span>
            </span>
            {comparisons.length > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="14" height="2">
                  <line x1="0" y1="1" x2="14" y2="1" stroke="var(--ink-4)" strokeWidth="1.25" strokeDasharray="3 2" />
                </svg>
                <span>{comparisons[0]}</span>
              </span>
            )}
            <span style={{ width: 1, height: 14, background: 'var(--line)' }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Each buy transaction">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M5 1 L9 9 L1 9 Z" fill="var(--gain)" />
              </svg>
              <span>Buy</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Each sell transaction">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M5 0.5 L9.5 5 L5 9.5 L0.5 5 Z" fill="var(--loss)" />
              </svg>
              <span>Sell</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }} title="Dividend received">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />
              <span>Dividend</span>
            </span>
          </div>
        </div>
        <HoldingChart
          series={series}
          benchmarkSeries={comparisons.length > 0 ? benchmarkSeries : null}
          benchmarkLabel={comparisons[0]}
          buys={buys}
          sells={sells}
          divs={divs}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Position</div>
          </div>
          <div className="hd-metrics">
            {[
              { l: 'Shares', v: holding.qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) },
              { l: 'Avg cost', v: fmtMoney(holding.basis, { cents: true }) },
              { l: 'Market price', v: fmtMoney(holding.price, { cents: true }) },
              { l: 'Cost basis', v: fmtMoney(holding.cost) },
              { l: 'Market value', v: fmtMoney(holding.value) },
              {
                l: 'Unrealized',
                v: (holding.gain >= 0 ? '+' : '') + fmtMoney(holding.gain),
                pos: holding.gain >= 0,
              },
              { l: 'Lifetime div', v: fmtMoney(lifetimeDividends) },
              { l: '% of portfolio', v: (holding.share * 100).toFixed(1) + '%' },
            ].map(m => (
              <div className="hd-metric" key={m.l}>
                <div className="hd-metric-l">{m.l}</div>
                <div
                  className="hd-metric-v"
                  style={
                    m.pos === false
                      ? { color: 'var(--loss)' }
                      : m.pos === true
                      ? { color: 'var(--gain)' }
                      : undefined
                  }
                >
                  {m.v}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Held in</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {allMyAccounts.filter(a => a.id === holding.account).length} of {allMyAccounts.length} accounts
            </span>
          </div>
          <div className="brokerage-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            {allMyAccounts
              .filter(a => a.id === holding.account)
              .map(a => (
                <div key={a.id} className="brokerage-tile">
                  <BrokerageLogo name={a.brokerage} />
                  <div className="brokerage-tile-name">{a.name}</div>
                  <div className="brokerage-tile-value">
                    {holding.qty.toLocaleString('en-US', { maximumFractionDigits: 0 })} shares
                  </div>
                  <div className="brokerage-tile-meta">
                    {fmtMoney(holding.value, { cents: false })} · {(holding.share * 100).toFixed(1)}% of total
                  </div>
                </div>
              ))}
            <button className="brokerage-add" style={{ minHeight: 0, padding: '14px 12px' }}>
              <div className="brokerage-add-glyph" style={{ fontSize: 24 }}>
                +
              </div>
              <div className="brokerage-add-label" style={{ fontSize: 12 }}>
                Hold elsewhere?
              </div>
              <div className="brokerage-add-sub">Add an account</div>
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
        <div className="card-title-row" style={{ padding: '18px 20px 0' }}>
          <div className="card-title">Activity · {holding.sym}</div>
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {txsForHolding.length} entries
          </span>
        </div>
        <table className="tbl" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th className="r">Qty</th>
              <th className="r">Price</th>
              <th className="r">Amount</th>
              <th>Account</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {txsForHolding.slice(0, 12).map(t => {
              const amount =
                t.amount != null ? t.amount : t.action === 'sell' ? +(t.qty * t.price) : -(t.qty * t.price);
              return (
                <tr key={t.id}>
                  <td className="num">
                    {t.date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}
                  </td>
                  <td>
                    <span className={`activity-act ${t.action}`}>
                      {t.action === 'div' ? 'Div' : t.action === 'buy' ? 'Buy' : 'Sell'}
                    </span>
                  </td>
                  <td className="r num">
                    {t.qty > 0 ? t.qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
                  </td>
                  <td className="r num">{t.price > 0 ? fmtMoney(t.price, { cents: true }) : '—'}</td>
                  <td className="r num" style={{ color: amount >= 0 ? 'var(--gain)' : 'var(--ink)' }}>
                    {amount >= 0 ? '+' : ''}
                    {fmtMoney(amount, { cents: true })}
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{t.account}</td>
                  <td style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t.notes || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
