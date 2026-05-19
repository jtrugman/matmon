import { useEffect, useMemo, useState } from 'react';
import { Timeframe } from '../components/Timeframe';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { TickerLogo } from '../components/TickerLogo';
import { HoldingChart } from '../components/charts/HoldingChart';
import { EmptyState } from '../components/EmptyState';
import { fmtMoney, fmtPct, formatActionLabel, type ActionTier } from '../lib/format';
import { listPriceHistory, loadAllTransactions } from '../lib/db/repos';
import { backfillHistoricalPrices, filterBackfillSymbols } from '../lib/quotes/backfill';
import { awaitBackfillRecovery, isBackfillRecoveryInFlight } from '../lib/usePortfolio';
import type { Holding, MatmonData, SeriesPoint } from '../data';

type Tx = {
  id: string;
  date: Date;
  /** Raw action code from the DB (e.g. 'dividend', 'div_reinvest'). */
  action: string;
  /** Display label (e.g. "Dividend", "Reinvest"). */
  actionLabel: string;
  /** Visual tier for the badge color. */
  tier: ActionTier;
  /** Coarse bucket retained for the chart annotation hover ('buy' / 'sell' / 'div'). */
  bucket: 'buy' | 'sell' | 'div';
  qty: number;
  price: number;
  amount: number | null;
  account: string;
  notes: string;
  symbol: string;
};

type Props = {
  data: MatmonData;
  holding: Holding;
  onBack: () => void;
};

/**
 * Chart loading state for the per-holding view. The state machine:
 *
 *   idle      ── price history exists, render the chart
 *   loading   ── auto-backfill in progress, show inline progress card
 *   error     ── backfill failed or returned nothing useful, show recovery hint
 *
 * We deliberately model this as a discriminated union so the empty-state
 * branch can't fire while the loading spinner is up: prior implementations
 * showed the "Refresh quotes from Home" hint UNDER the spinner, which was
 * doubly wrong (wrong copy + double UI).
 */
type ChartLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'error'; message: string };

export function HoldingDetailView({ data, holding, onBack }: Props) {
  const [timeframe, setTimeframe] = useState('5Y');
  const [comparisons, setComparisons] = useState<string[]>(['SPY']);
  const [compareInput, setCompareInput] = useState('');

  // Real price history from the prices table. Empty until we have stored
  // history for this symbol; we used to fabricate a sine-wave curve here.
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [chartState, setChartState] = useState<ChartLoadState>({ kind: 'idle' });

  // Real transactions for this symbol from the DB. The old call to
  // generateTransactions(data) fabricated transactions from holdings.
  const [allTxs, setAllTxs] = useState<Tx[]>([]);
  const accountNameById = useMemo(
    () => new Map(data.accounts.map(a => [a.id, a.name])),
    [data.accounts],
  );

  // Auto-backfill on mount when this symbol has no price history.
  //
  // The mount-time effect runs three steps in sequence:
  //   1. Read whatever's already in the prices table for this symbol.
  //   2. If empty AND the holding has shares AND we have a transaction date
  //      to bound the fetch window, fire backfillHistoricalPrices.
  //   3. After the fetch lands, re-read the prices table so the chart
  //      reflects the freshly-stored bars.
  //
  // We coordinate with the global recovery (usePortfolio) so we don't fire
  // a parallel single-symbol fetch when the global recovery is already
  // pulling every held symbol. If a recovery is in flight, we await it,
  // then re-read the prices table.
  //
  // Cleanup: the `cancelled` flag short-circuits every async branch so
  // navigating away mid-fetch won't fire a setState on an unmounted
  // component. Backfill itself is fire-and-forget at the orchestrator level
  // (it never throws), so there's nothing to abort upstream; the local
  // cancelled-check is enough to keep React from warning.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const exposeSeriesForTests = (mapped: SeriesPoint[]) => {
        // Debug hook for Playwright specs. The historical-backfill spec asserts
        // that the per-holding chart series has > 1500 daily points for a
        // long-held position; without an exposed handle the only way to get
        // at the array would be to scrape the rendered SVG. Window-level so
        // page.evaluate(() => window.__matmonDebug.lastChartSeries) works.
        if (typeof window !== 'undefined') {
          const w = window as any;
          w.__matmonDebug = w.__matmonDebug || {};
          w.__matmonDebug.lastChartSeries = mapped;
          w.__matmonDebug.lastChartSymbol = holding.sym;
        }
      };

      // Step 1: pull whatever's already stored for this symbol. A read
      // failure (rare; only the browser shim or a torn DB connection can
      // throw) is treated as "no history" and we fall through to backfill.
      const rows = await listPriceHistory(holding.sym).catch(
        () => [] as { date: Date; close: number }[],
      );
      if (cancelled) return;

      if (rows.length > 0) {
        const mapped = rows.map(r => ({ date: r.date, value: r.close }));
        setSeries(mapped);
        setChartState({ kind: 'idle' });
        exposeSeriesForTests(mapped);
        return;
      }

      // No stored history. If the holding has no shares we have no earliest
      // date to bound the fetch (and arguably no reason to build the chart),
      // so we just leave the empty state up.
      if (!(holding.qty > 0)) {
        setSeries([]);
        setChartState({ kind: 'idle' });
        exposeSeriesForTests([]);
        return;
      }

      // Step 2: cooperate with the global recovery. If it's running we wait
      // for it rather than firing a parallel fetch for this one symbol.
      if (isBackfillRecoveryInFlight()) {
        setChartState({
          kind: 'loading',
          message: `Fetching price history for ${holding.sym}…`,
        });
        try {
          await awaitBackfillRecovery();
        } catch {
          // awaitBackfillRecovery never throws today; defensive guard.
        }
        if (cancelled) return;
        const recoveredRows = await listPriceHistory(holding.sym).catch(
          () => [] as { date: Date; close: number }[],
        );
        if (cancelled) return;
        if (recoveredRows.length > 0) {
          const mapped = recoveredRows.map(r => ({ date: r.date, value: r.close }));
          setSeries(mapped);
          setChartState({ kind: 'idle' });
          exposeSeriesForTests(mapped);
          return;
        }
        // Recovery didn't land bars for this symbol. Fall through to the
        // direct single-symbol path below in case the recovery skipped it.
      }

      // Compute earliest tx date for this symbol so the backfill window is
      // bounded. If there's no matching transaction we can't infer a start
      // date; this happens for holdings-only imports (JPM positions) where
      // the user gave us a snapshot but no flows. In that case we fall back
      // to "8 years ago" so the chart shows something meaningful.
      const matchingTxs: { date: Date }[] = [];
      try {
        const allRows = await loadAllTransactions();
        if (cancelled) return;
        for (const r of allRows) {
          if (r.symbol === holding.sym) matchingTxs.push({ date: new Date(r.date) });
        }
      } catch {
        // Transactions read failure is non-fatal. We fall through with an
        // empty matchingTxs list and the 8-year window kicks in below.
      }
      let earliestDate: Date;
      if (matchingTxs.length > 0) {
        earliestDate = matchingTxs.reduce((a, b) => (a.date < b.date ? a : b)).date;
      } else {
        // 8 years matches the typical mutual-fund holding period and gives
        // the chart something to render even when we lack flow history.
        const fallback = new Date();
        fallback.setUTCFullYear(fallback.getUTCFullYear() - 8);
        earliestDate = fallback;
      }

      const yearsBack = Math.max(
        1,
        Math.round((Date.now() - +earliestDate) / (365.25 * 24 * 60 * 60 * 1000)),
      );
      setChartState({
        kind: 'loading',
        message: `Fetching ${yearsBack} year${yearsBack === 1 ? '' : 's'} of price history for ${holding.sym}…`,
      });

      const cleanedSymbols = filterBackfillSymbols([holding.sym]);
      if (cleanedSymbols.length === 0) {
        // Cash sweep or otherwise filtered out at the source. Drop to idle
        // with the corrected empty-state copy.
        setSeries([]);
        setChartState({ kind: 'idle' });
        exposeSeriesForTests([]);
        return;
      }

      let result: { ok: string[]; failed: string[] };
      try {
        result = await backfillHistoricalPrices([holding.sym], earliestDate);
      } catch {
        if (cancelled) return;
        setChartState({
          kind: 'error',
          message:
            "Couldn't fetch history right now. Try the Refresh history button in Settings, then Market data.",
        });
        return;
      }
      if (cancelled) return;

      if (result.ok.includes(holding.sym)) {
        const freshRows = await listPriceHistory(holding.sym).catch(
          () => [] as { date: Date; close: number }[],
        );
        if (cancelled) return;
        const mapped = freshRows.map(r => ({ date: r.date, value: r.close }));
        setSeries(mapped);
        setChartState({ kind: 'idle' });
        exposeSeriesForTests(mapped);
        return;
      }

      // The backfill orchestrator reported a failure (offline, Yahoo blocked,
      // empty response). Surface the actionable hint that points the user
      // to the manual recovery path in Settings.
      setSeries([]);
      setChartState({
        kind: 'error',
        message:
          "Price history isn't available right now. Try Settings, then Market data, then Refresh history.",
      });
      exposeSeriesForTests([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [holding.sym, holding.qty]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAllTransactions();
        if (cancelled) return;
        const mapped: Tx[] = rows
          .filter(r => r.symbol)
          .map((r, idx) => {
            const { label, tier } = formatActionLabel(r.action);
            // Coarse bucket for chart annotations: every income-tier row
            // (dividend, div_reinvest, interest) gets a 'div' bucket so it
            // surfaces in the lifetime-dividend metric AND the chart dot.
            // sell + transfer_out share a 'sell' bucket; everything else
            // is a buy (covers buy, transfer_in, div_reinvest-as-shares).
            const bucket: 'buy' | 'sell' | 'div' =
              tier === 'income'
                ? 'div'
                : tier === 'sell' || r.action === 'transfer_out'
                  ? 'sell'
                  : 'buy';
            return {
              id: `${r.id}-${idx}`,
              date: new Date(r.date),
              action: r.action,
              actionLabel: label,
              tier,
              bucket,
              qty: r.quantity,
              price: r.price,
              amount: r.amount,
              account: accountNameById.get(r.account_id) || r.account_id,
              notes: r.notes || '',
              symbol: r.symbol || '',
            };
          })
          .sort((a, b) => +b.date - +a.date);
        setAllTxs(mapped);
      } catch {
        if (!cancelled) setAllTxs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.accounts, accountNameById]);

  const txsForHolding = useMemo(() => allTxs.filter(t => t.symbol === holding.sym), [allTxs, holding.sym]);
  // Use the coarse bucket for the chart annotation arrays so dots align with
  // the legend ("Buy" = green triangle, "Sell" = red diamond, "Dividend" = blue
  // dot). The bucket lumps every income-tier row into 'div' which matches
  // what the chart legend already advertises.
  const buys = txsForHolding.filter(t => t.bucket === 'buy');
  const sells = txsForHolding.filter(t => t.bucket === 'sell');
  const divs = txsForHolding.filter(t => t.bucket === 'div');
  // Lifetime dividends counts dividend + div_reinvest only, matching the
  // HomeView convention. Interest income is income but not a dividend, so
  // it does NOT count toward this position-level "dividend" metric (it
  // would lie about what the company / fund paid). Each row's amount is
  // taken once: a div_reinvest row records the dividend that was paid AND
  // immediately turned into shares, but it's still a single dividend event.
  const lifetimeDividends = txsForHolding
    .filter(t => t.action === 'dividend' || t.action === 'div_reinvest')
    .reduce((s, t) => s + Math.abs(t.amount || 0), 0);

  const benchmarkSeries = useMemo(() => {
    // Without a real benchmark feed, leave this null. The old fabricated
    // benchmark series was a faux SPY curve that misled users.
    return null;
  }, []);

  const allMyAccounts = data.accounts;

  return (
    <div>
      <button className="back-btn" onClick={onBack}>
        ← Holdings
      </button>

      <div className="hd-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <TickerLogo ticker={holding.sym} size={60} />
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
                {/*
                  Sector + industry + currency. Falls back to "Unknown" only
                  when neither sector nor industry has landed yet (e.g. fresh
                  symbol that hasn't been backfilled). The legacy hardcoded
                  "NYSEARCA · USD" string was misleading: it implied an
                  exchange listing we never actually fetched.
                */}
                {[holding.sector || (!holding.industry ? 'Unknown' : ''), holding.industry, 'USD']
                  .filter(Boolean)
                  .join(' · ')}
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
                  <line
                    x1="0"
                    y1="1"
                    x2="14"
                    y2="1"
                    stroke="var(--ink-4)"
                    strokeWidth="1.25"
                    strokeDasharray="3 2"
                  />
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
        {series.length >= 2 ? (
          <HoldingChart
            series={series}
            benchmarkSeries={comparisons.length > 0 ? benchmarkSeries : null}
            benchmarkLabel={comparisons[0]}
            buys={buys}
            sells={sells}
            divs={divs}
          />
        ) : chartState.kind === 'loading' ? (
          <div
            data-testid="chart-loading"
            role="status"
            aria-live="polite"
            style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <div className="empty-state empty-state-compact">
              <div
                className="empty-state-glyph"
                aria-hidden="true"
                style={{ borderStyle: 'solid' }}
              >
                <span
                  className="btn-spinner"
                  style={{
                    width: 16,
                    height: 16,
                    border: '2px solid var(--paper-3)',
                    borderTopColor: 'var(--accent)',
                    borderRadius: '50%',
                    display: 'inline-block',
                  }}
                />
              </div>
              <div className="empty-state-title">{chartState.message}</div>
              <div className="empty-state-body">
                Pulling daily closes from Yahoo Finance. Long histories can take a few seconds.
              </div>
            </div>
          </div>
        ) : chartState.kind === 'error' ? (
          <div
            data-testid="chart-error"
            style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <EmptyState
              compact
              title="Price history isn't available right now."
              body={chartState.message}
            />
          </div>
        ) : (
          <div style={{ minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState
              compact
              title="Price history will fill in as quotes are fetched."
              body="Open Settings, then Market data, then Refresh history to build a series."
            />
          </div>
        )}
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

      <div
        className="card"
        style={{ marginTop: 18, padding: txsForHolding.length === 0 ? 18 : 0, overflow: 'hidden' }}
      >
        <div className="card-title-row" style={{ padding: txsForHolding.length === 0 ? 0 : '18px 20px 0' }}>
          <div className="card-title">Activity · {holding.sym}</div>
          <span className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {txsForHolding.length} entries
          </span>
        </div>
        {txsForHolding.length === 0 ? (
          <EmptyState
            compact
            title="No recorded transactions for this position yet."
            body="As your trades come in, they'll show up here."
          />
        ) : (
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
                  t.amount != null ? t.amount : t.tier === 'sell' ? +(t.qty * t.price) : -(t.qty * t.price);
                return (
                  <tr key={t.id} data-testid={`hd-tx-row-${t.action}`}>
                    <td className="num">
                      {t.date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: '2-digit',
                        year: 'numeric',
                      })}
                    </td>
                    <td>
                      <span className={`activity-act ${t.tier}`} data-testid={`hd-tx-action-${t.action}`}>
                        {t.actionLabel}
                      </span>
                    </td>
                    <td className="r num">
                      {t.qty > 0 ? t.qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '--'}
                    </td>
                    <td className="r num">{t.price > 0 ? fmtMoney(t.price, { cents: true }) : '--'}</td>
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
        )}
      </div>
    </div>
  );
}
