import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { ProjectionChart } from '../components/charts/ProjectionChart';
import { fmtMoney } from '../lib/format';
import { getTaxConstants } from '../lib/taxConstants';
import type { MatmonData } from '../data';

export function PlannerView({ data }: { data: MatmonData }) {
  const [monthly, setMonthly] = useState(2500);
  const [annualIncrease, setAnnualIncrease] = useState(3);
  const [returnMode, setReturnMode] = useState<'manual' | 'auto'>('manual');
  const [returnPct, setReturnPct] = useState(7);
  const [years, setYears] = useState(22);
  const [inflationAdjust, setInflationAdjust] = useState(true);
  const [goal, setGoal] = useState(3_000_000);

  const projection = useMemo(() => {
    const startBalance = data.accounts
      .filter(a => ['trad_ira', '401k', 'roth_ira', 'hsa'].includes(a.type))
      .reduce((s, a) => s + a.value, 0);
    const realReturn = inflationAdjust ? (returnPct - 3) / 100 : returnPct / 100;
    let bal = startBalance;
    let monthlyContrib = monthly;
    const rows = [{ year: 2026, balance: bal, contributed: 0, growth: 0 }];
    let totalContrib = 0;
    for (let i = 1; i <= years; i++) {
      const annualContrib = monthlyContrib * 12;
      bal = bal * (1 + realReturn) + annualContrib * (1 + realReturn / 2);
      totalContrib += annualContrib;
      rows.push({
        year: 2026 + i,
        balance: bal,
        contributed: totalContrib,
        growth: bal - startBalance - totalContrib,
      });
      monthlyContrib *= 1 + annualIncrease / 100;
    }
    return { rows, startBalance, finalBalance: bal, totalContrib };
  }, [monthly, annualIncrease, returnPct, returnMode, years, inflationAdjust, data]);

  const contribSeries = projection.rows.map(r => ({ year: r.year, value: projection.startBalance + r.contributed }));
  const growthSeries = projection.rows.map(r => ({
    year: r.year,
    value: Math.max(0, r.balance - (projection.startBalance + r.contributed)),
  }));

  // Healthcare panel: pull contribution and cost benchmarks from the tax-year
  // config so they can be refreshed yearly without touching this view.
  const tax = getTaxConstants();
  // Today's HSA balance from demo data. When household plumbing lands, swap
  // for sum of accounts where type === 'hsa'.
  const hsaToday = 48720;
  // Project HSA growth from today to age 65 at 7% real return, no further
  // contributions, matching the existing copy. Years-to-65 is a placeholder
  // until age plumbing lands; keep ~19.6y so the rendered figure stays close
  // to what the panel showed previously (~$184k from $48.7k).
  const hsaRealReturn = 0.07;
  const yearsToAge65 = 19.6;
  const hsaAt65 = hsaToday * Math.pow(1 + hsaRealReturn, yearsToAge65);
  const lifetimeHealthcareCost = tax.healthcare.fidelityRetireeEstimateCouple;
  const hsaCoveragePct = Math.min(100, (hsaAt65 / lifetimeHealthcareCost) * 100);

  return (
    <div>
      <PageHead
        title="Planner"
        meta={
          <div>
            <div>
              Target · {fmtMoney(goal, { compact: true })} by {2026 + years} · age 67
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Scenario · Default</div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn">Compare scenarios</button>
            <button className="btn btn-primary">Save scenario</button>
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: '440px 1fr', gap: 18 }}>
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Inputs</div>
            <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              Live · {projection.rows.length - 1}y horizon
            </span>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Starting balance
              <span className="hint">Retirement accounts only · IRA + 401(k) + HSA</span>
            </div>
            <div className="slider-track">
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--paper-3)' }}>
                <div style={{ width: '100%', height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
              </div>
            </div>
            <div className="slider-value">{fmtMoney(projection.startBalance, { compact: true })}</div>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Monthly contribution
              <span className="hint">Across all retirement accounts</span>
            </div>
            <input
              className="matmon-slider"
              type="range"
              min="0"
              max="6000"
              step="50"
              value={monthly}
              onChange={e => setMonthly(+e.target.value)}
            />
            <div className="slider-value">${monthly.toLocaleString()}</div>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Annual contribution increase
              <span className="hint">Match inflation? Bump each year?</span>
            </div>
            <input
              className="matmon-slider"
              type="range"
              min="0"
              max="10"
              step="0.5"
              value={annualIncrease}
              onChange={e => setAnnualIncrease(+e.target.value)}
            />
            <div className="slider-value">+{annualIncrease}%</div>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Expected annual return
              <span className="hint">Nominal · pre-inflation</span>
            </div>
            <input
              className="matmon-slider"
              type="range"
              min="-2"
              max="12"
              step="0.1"
              value={returnPct}
              onChange={e => setReturnPct(+e.target.value)}
            />
            <div className="slider-value">{returnPct.toFixed(1)}%</div>
          </div>

          <div style={{ padding: '12px 0' }}>
            <div className="chips">
              <button className={`chip ${returnPct === 4 ? 'active' : ''}`} onClick={() => setReturnPct(4)}>
                4% · conservative
              </button>
              <button className={`chip ${returnPct === 7 ? 'active' : ''}`} onClick={() => setReturnPct(7)}>
                7% · S&P real avg
              </button>
              <button className={`chip ${returnPct === 10 ? 'active' : ''}`} onClick={() => setReturnPct(10)}>
                10% · S&P nominal
              </button>
              <button
                className={`chip ${returnMode === 'auto' ? 'active' : ''}`}
                onClick={() => {
                  setReturnMode('auto');
                  setReturnPct(10.8);
                }}
              >
                Use my 5Y · 10.8%
              </button>
            </div>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Years to project
              <span className="hint">Defaults to age 67</span>
            </div>
            <input
              className="matmon-slider"
              type="range"
              min="1"
              max="40"
              step="1"
              value={years}
              onChange={e => setYears(+e.target.value)}
            />
            <div className="slider-value">{years}y</div>
          </div>

          <div className="slider-row">
            <div className="slider-label">
              Goal · target balance
              <span className="hint">The number you'd like to land on</span>
            </div>
            <input
              className="matmon-slider"
              type="range"
              min="500000"
              max="10000000"
              step="50000"
              value={goal}
              onChange={e => setGoal(+e.target.value)}
            />
            <div className="slider-value">{fmtMoney(goal, { compact: true })}</div>
          </div>

          <div style={{ padding: '4px 0 12px' }}>
            <div className="chips">
              {[1_500_000, 2_500_000, 3_000_000, 5_000_000].map(g => (
                <button key={g} className={`chip ${goal === g ? 'active' : ''}`} onClick={() => setGoal(g)}>
                  {fmtMoney(g, { compact: true })}
                </button>
              ))}
            </div>
          </div>

          <div className="slider-row" style={{ borderBottom: 'none' }}>
            <div className="slider-label">
              Show in today's dollars
              <span className="hint">Applies 3% deflator</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <button
                onClick={() => setInflationAdjust(!inflationAdjust)}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 999,
                  background: inflationAdjust ? 'var(--accent)' : 'var(--paper-3)',
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
                    left: inflationAdjust ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--paper)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    transition: 'left 150ms',
                  }}
                />
              </button>
            </div>
            <div className="slider-value muted" style={{ fontSize: 12 }}>
              {inflationAdjust ? 'On' : 'Off'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="card">
            <div className="card-title">
              Projected value in {years} years · {2026 + years}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginTop: 10, flexWrap: 'wrap' }}>
              <div className="total-figure">
                <span className="dollar">$</span>
                {(projection.finalBalance / 1_000_000).toFixed(2)}
                <span className="cents">M</span>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div className="delta up" style={{ marginBottom: 6 }}>
                  <span className="arrow">↑</span>
                  {fmtMoney(projection.finalBalance - projection.startBalance, { compact: true })} of growth
                </div>
                <div className="muted" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                  ≈ {(projection.finalBalance / projection.startBalance).toFixed(1)}× your start
                </div>
              </div>
              <div
                style={{
                  minWidth: 200,
                  background: 'var(--paper-3)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  marginLeft: 'auto',
                }}
              >
                <div
                  className="muted"
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  Goal · {fmtMoney(goal, { compact: true })}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                  }}
                >
                  <span
                    className="num"
                    style={{
                      fontSize: 18,
                      color: projection.finalBalance >= goal ? 'var(--gain)' : 'var(--loss)',
                    }}
                  >
                    {projection.finalBalance >= goal ? 'On track' : 'Short'}
                  </span>
                  <span className="num muted" style={{ fontSize: 12 }}>
                    {Math.min(999, Math.round((projection.finalBalance / goal) * 100))}%
                  </span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: 'var(--paper)',
                    borderRadius: 2,
                    marginTop: 8,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, (projection.finalBalance / goal) * 100)}%`,
                      background: projection.finalBalance >= goal ? 'var(--gain)' : 'var(--accent)',
                      borderRadius: 2,
                      transition: 'width 250ms ease',
                    }}
                  />
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', marginTop: 6 }}
                >
                  {projection.finalBalance >= goal
                    ? `${fmtMoney(projection.finalBalance - goal, { compact: true })} over`
                    : `${fmtMoney(goal - projection.finalBalance, { compact: true })} short`}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 20 }}>
              <ProjectionChart contributions={contribSeries} growth={growthSeries} goal={goal} height={240} />
              <div style={{ display: 'flex', gap: 14, marginTop: 6, paddingLeft: 56 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--ink-3)',
                  }}
                >
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--accent)', opacity: 0.5 }} />
                  Investment growth
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--ink-3)',
                  }}
                >
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--ink-3)', opacity: 0.4 }} />
                  Your contributions
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title-row">
              <div className="card-title">Sensitivity</div>
              <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                If you change one input…
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Return −1%', delta: -0.18 },
                { label: 'Return +1%', delta: 0.22 },
                { label: 'Contrib −$200', delta: -0.06 },
                { label: 'Contrib +$200', delta: 0.06 },
              ].map(s => (
                <div key={s.label} style={{ padding: 12, background: 'var(--paper-3)', borderRadius: 10 }}>
                  <div
                    className="muted"
                    style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                    }}
                  >
                    {s.label}
                  </div>
                  <div
                    className="num"
                    style={{
                      fontSize: 17,
                      marginTop: 4,
                      color: s.delta >= 0 ? 'var(--gain)' : 'var(--loss)',
                    }}
                  >
                    {s.delta >= 0 ? '+' : ''}
                    {fmtMoney(projection.finalBalance * s.delta, { compact: true })}
                  </div>
                  <div className="muted" style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
                    {s.delta >= 0 ? '+' : ''}
                    {(s.delta * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-title-row">
          <div className="card-title">Healthcare in retirement · HSA at work</div>
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            Informational
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 18, alignItems: 'start' }}>
          <div>
            <div
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              HSA at age 65
            </div>
            <div className="total-figure" style={{ fontSize: 36, marginTop: 6 }}>
              <span className="dollar" style={{ fontSize: 22, top: -10 }}>
                $
              </span>
              {fmtMoney(hsaAt65, { cents: false }).replace(/^\$/, '')}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              Projected from {fmtMoney(hsaToday, { cents: false })} today at {(hsaRealReturn * 100).toFixed(0)}% real return, no further contributions
            </div>
          </div>
          <div>
            <div
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Projected lifetime cost
            </div>
            <div className="total-figure" style={{ fontSize: 36, marginTop: 6 }}>
              <span className="dollar" style={{ fontSize: 22, top: -10 }}>
                $
              </span>
              {fmtMoney(lifetimeHealthcareCost, { cents: false }).replace(/^\$/, '')}
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              Per Fidelity Retiree Health Care Estimate · 2 people, age 65
            </div>
          </div>
          <div>
            <div
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}
            >
              Coverage
            </div>
            <div className="total-figure up" style={{ fontSize: 36, marginTop: 6, color: 'var(--accent)' }}>
              {Math.round(hsaCoveragePct)}<span className="cents">%</span>
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--paper-3)',
                borderRadius: 3,
                marginTop: 12,
                overflow: 'hidden',
              }}
            >
              <div style={{ height: '100%', width: `${hsaCoveragePct}%`, background: 'var(--accent)', borderRadius: 3 }} />
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              HSA covers ~{Math.round(hsaCoveragePct)}% of projected healthcare. The 401(k) and Roth cover the rest.
            </div>
          </div>
        </div>
      </div>

      <p className="disclaimer">
        These projections are educational illustrations based on the inputs you've provided. Markets do not
        produce a steady return. Past returns do not predict future returns. This is not financial advice.
      </p>
    </div>
  );
}
