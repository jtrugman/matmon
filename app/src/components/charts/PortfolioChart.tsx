import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDate, fmtMoney } from '../../lib/format';
import type { SeriesPoint } from '../../data';

type Props = {
  series: SeriesPoint[];
  benchmark?: SeriesPoint[];
  benchmarkLabel?: string;
  showBenchmark?: boolean;
  variant?: 'area' | 'line' | 'bars';
  height?: number;
  /**
   * When true, the series is already normalized to a baseline of 100 (used
   * by the "vs SPY" overlay). The Y-axis labels and the hover tooltip then
   * format as percent-from-baseline rather than dollar magnitudes. The
   * caller can also pass `valueAxisFormatter` / `hoverValueFormatter`
   * directly to override; `normalized` is a convenience flag that flips
   * legend labels (the "Portfolio" pill shows "Matmon portfolio" in the
   * tooltip so the user sees what they're looking at).
   */
  normalized?: boolean;
  /**
   * Override for the Y-axis tick labels. Defaults to dollar-compact when
   * `normalized` is false; index-from-100 when `normalized` is true.
   */
  valueAxisFormatter?: (v: number) => string;
  /**
   * Override for the hover tooltip's value formatting. Defaults to dollar-
   * compact when `normalized` is false; index-from-100 percent change when
   * true. Receives the raw series value (which is already normalized when
   * normalized=true).
   */
  hoverValueFormatter?: (v: number) => string;
};

// Hoisted out of the component so the object identity is stable across renders,
// which keeps the useMemo dependency list tidy (padding.left/top are constants).
// The left padding has to leave room for the widest tick label, including the
// "+12,083K%" / "$13M" formats that surface on extreme-growth windows. The
// 72px value here was picked by measuring the widest realistic tick at 10.5px
// JetBrains Mono (8 characters x ~7px advance + 10px gap to gridline = ~66px,
// rounded up to 72px). The 56px the chart shipped with clipped 7-digit
// percent labels on the ALL view for portfolios that grew 1000x+.
const PADDING = { top: 14, right: 18, bottom: 28, left: 72 } as const;

// SPY benchmark line color. Picked to be both (a) visibly distinct from the
// portfolio's accent blue and (b) high-contrast against the cream paper
// background. The previous `var(--ink-4)` at opacity 0.7 was so muted on
// `--paper` that the dashed line was effectively invisible, which made the
// "vs SPY" overlay look broken even though the path was rendering. A
// saturated violet at full opacity reads as a deliberate second series.
const BENCHMARK_STROKE = '#a78bfa';

export function PortfolioChart({
  series,
  benchmark,
  benchmarkLabel = 'SPY',
  showBenchmark = true,
  variant = 'area',
  height = 340,
  normalized = false,
  valueAxisFormatter,
  hoverValueFormatter,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(Math.max(400, Math.floor(e.contentRect.width)));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const padding = PADDING;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const computed = useMemo(() => {
    if (!series || series.length === 0) return null;
    const allValues = [
      ...series.map(p => p.value),
      ...(showBenchmark && benchmark ? benchmark.map(p => p.value) : []),
    ];
    const minV = Math.min(...allValues) * 0.92;
    const maxV = Math.max(...allValues) * 1.04;
    const t0 = series[0].date.getTime();
    const t1 = series[series.length - 1].date.getTime();

    const xScale = (d: Date) => PADDING.left + ((d.getTime() - t0) / (t1 - t0)) * innerW;
    const yScale = (v: number) => PADDING.top + (1 - (v - minV) / (maxV - minV)) * innerH;

    const portfolioPath = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`)
      .join(' ');
    const portfolioArea = `${portfolioPath} L ${xScale(series[series.length - 1].date).toFixed(2)} ${PADDING.top + innerH} L ${xScale(series[0].date).toFixed(2)} ${PADDING.top + innerH} Z`;
    const benchmarkPath =
      showBenchmark && benchmark
        ? benchmark
            .map(
              (p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`,
            )
            .join(' ')
        : null;

    const tickCount = 5;
    const yTicks = Array.from({ length: tickCount }, (_, i) => {
      const v = minV + ((maxV - minV) * i) / (tickCount - 1);
      return { v, y: yScale(v) };
    });
    // X-axis tick policy. Short windows show month-year labels evenly
    // spaced; long windows show year labels at Jan 1. This is what makes
    // the YTD segment read "Jan / Feb / Mar / Apr / May" rather than a
    // single "2026" floating mid-chart.
    const startDate = series[0].date;
    const endDate = series[series.length - 1].date;
    const spanDays = (+endDate - +startDate) / 86_400_000;
    const xTicks: { label: string; x: number }[] = [];
    if (spanDays <= 400) {
      // Short window: monthly ticks. Skip the first month if the series
      // starts past mid-month so we don't crowd the left edge with a
      // half-visible "May" right next to the next "Jun".
      const startY = startDate.getUTCFullYear();
      const startM = startDate.getUTCMonth();
      const endY = endDate.getUTCFullYear();
      const endM = endDate.getUTCMonth();
      let y = startY;
      let m = startM;
      // Advance to first-of-month >= startDate.
      const firstOfStartMonth = new Date(Date.UTC(startY, startM, 1));
      if (+firstOfStartMonth < +startDate) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
      const MONTH_LABELS = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      // For very short windows (<= 90 days) every month label is shown.
      // For 90-400 day windows we step every 2 months to avoid crowding.
      const stride = spanDays <= 90 ? 1 : 2;
      let count = 0;
      while (y < endY || (y === endY && m <= endM)) {
        const d = new Date(Date.UTC(y, m, 1));
        if (+d >= +startDate && +d <= +endDate) {
          if (count % stride === 0) {
            // Always include the year on the first tick OR when the
            // month wraps past December so the reader doesn't lose
            // track on a YTD-style window that straddles a year boundary.
            const label = m === 0 || count === 0 ? `${MONTH_LABELS[m]} ${y}` : MONTH_LABELS[m];
            xTicks.push({ label, x: xScale(d) });
          }
          count++;
        }
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
    } else {
      // Long window: year ticks at Jan 1 within the visible range.
      const startY = startDate.getFullYear();
      const endY = endDate.getFullYear();
      for (let y = startY; y <= endY; y++) {
        const d = new Date(y, 0, 1);
        if (d >= startDate && d <= endDate) {
          xTicks.push({ label: String(y), x: xScale(d) });
        }
      }
    }
    return { xScale, yScale, yTicks, xTicks, portfolioPath, portfolioArea, benchmarkPath };
  }, [series, benchmark, showBenchmark, innerW, innerH]);

  if (!computed) return null;
  const { xScale, yScale, yTicks, xTicks, portfolioPath, portfolioArea, benchmarkPath } = computed;

  // Find the benchmark point nearest to the portfolio's hover date. We can't
  // assume benchmark[hover] aligns with series[hover]: portfolio and SPY have
  // different trading-day footprints (SPY closes during market holidays the
  // portfolio's holdings don't, and the SPY history can start after the
  // portfolio's earliest tx). Walking the array on every hover tick is fine:
  // n is bounded by visible-window-days (< 2000 for a 5Y view).
  const benchmarkAtHover = (() => {
    if (hover == null || !series[hover] || !benchmark || benchmark.length === 0) {
      return null;
    }
    const targetMs = +series[hover].date;
    let best = benchmark[0];
    let bestD = Math.abs(+benchmark[0].date - targetMs);
    for (let i = 1; i < benchmark.length; i++) {
      const d = Math.abs(+benchmark[i].date - targetMs);
      if (d < bestD) {
        bestD = d;
        best = benchmark[i];
      }
    }
    return best;
  })();

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    if (px < padding.left || px > padding.left + innerW) {
      setHover(null);
      return;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(xScale(series[i].date) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };
  const handleLeave = () => setHover(null);

  const accent = 'var(--accent)';
  const accentFill = 'var(--accent)';

  // Default formatters. The caller can override either; when not overridden
  // they switch between dollar-compact and index-from-100-percent based on
  // the `normalized` flag.
  const tickFmt = valueAxisFormatter
    ? valueAxisFormatter
    : normalized
      ? (v: number) => `${v >= 100 ? '+' : ''}${(v - 100).toFixed(0)}%`
      : (v: number) => fmtMoney(v, { compact: true });
  const hoverFmt = hoverValueFormatter
    ? hoverValueFormatter
    : normalized
      ? (v: number) => `${v >= 100 ? '+' : ''}${(v - 100).toFixed(1)}%`
      : (v: number) => fmtMoney(v, { compact: true });
  const portfolioLegendLabel = normalized ? 'Matmon portfolio' : 'Portfolio';

  // Static legend pill in the top-left of the chart card. Shown only when
  // the benchmark overlay is active so the chart doesn't add UI weight when
  // it's a single line. Helps the user identify "this dashed line is SPY"
  // without having to hover to pop the tooltip.
  const showLegend = showBenchmark && benchmark && benchmark.length > 0;

  return (
    <div ref={wrapRef} className="chart-wrap" style={{ position: 'relative' }}>
      {showLegend && (
        <div
          data-testid="chart-legend"
          style={{
            position: 'absolute',
            top: 6,
            left: 64,
            display: 'flex',
            gap: 14,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--ink-3)',
            background: 'var(--paper)',
            border: '1px solid var(--line-soft)',
            borderRadius: 8,
            padding: '4px 10px',
            pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 2,
                background: 'var(--accent)',
                borderRadius: 1,
              }}
            />
            {portfolioLegendLabel}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 0,
                borderTop: `2px dashed ${BENCHMARK_STROKE}`,
              }}
            />
            {benchmarkLabel}
          </span>
        </div>
      )}
      <svg
        className="chart-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <defs>
          <linearGradient id="portfolioFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accentFill} stopOpacity="0.22" />
            <stop offset="60%" stopColor={accentFill} stopOpacity="0.08" />
            <stop offset="100%" stopColor={accentFill} stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={t.y}
              y2={t.y}
              stroke="var(--line-soft)"
              strokeDasharray={i === yTicks.length - 1 || i === 0 ? '0' : '2 4'}
              strokeWidth="0.75"
            />
            <text
              x={padding.left - 10}
              y={t.y + 4}
              textAnchor="end"
              fontSize="10.5"
              fontFamily="var(--font-mono)"
              fill="var(--ink-4)"
            >
              {tickFmt(t.v)}
            </text>
          </g>
        ))}

        {xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={height - 8}
            textAnchor="middle"
            fontSize="10.5"
            fontFamily="var(--font-mono)"
            fill="var(--ink-4)"
          >
            {t.label}
          </text>
        ))}

        {showBenchmark && benchmarkPath && variant !== 'bars' && (
          <path
            d={benchmarkPath}
            data-testid="benchmark-line"
            fill="none"
            stroke={BENCHMARK_STROKE}
            strokeWidth="1.75"
            strokeDasharray="4 4"
            strokeLinecap="round"
            opacity="0.95"
          />
        )}

        {variant === 'area' && (
          <>
            <path d={portfolioArea} fill="url(#portfolioFill)" />
            <path
              d={portfolioPath}
              fill="none"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {variant === 'line' && (
          <path
            d={portfolioPath}
            fill="none"
            stroke={accent}
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {variant === 'bars' && (
          <g>
            {series.map((p, i) => {
              const y = yScale(p.value);
              const prev = i > 0 ? series[i - 1].value : p.value;
              const up = p.value >= prev;
              const x = xScale(p.date);
              const barW = Math.max(2, (innerW / series.length) * 0.45);
              const baseY = padding.top + innerH;
              return (
                <rect
                  key={i}
                  x={x - barW / 2}
                  y={y}
                  width={barW}
                  height={baseY - y}
                  fill={up ? 'var(--gain)' : 'var(--loss)'}
                  opacity="0.78"
                  rx="1"
                />
              );
            })}
            <path d={portfolioPath} fill="none" stroke={accent} strokeWidth="1.25" opacity="0.4" />
          </g>
        )}

        {hover != null && series[hover] && (
          <g>
            <line
              x1={xScale(series[hover].date)}
              x2={xScale(series[hover].date)}
              y1={padding.top}
              y2={padding.top + innerH}
              stroke="var(--ink-3)"
              strokeWidth="0.75"
              strokeDasharray="3 3"
            />
            <circle
              cx={xScale(series[hover].date)}
              cy={yScale(series[hover].value)}
              r="4.5"
              fill="var(--paper)"
              stroke={accent}
              strokeWidth="2"
            />
            {showBenchmark && benchmarkAtHover && (
              <circle
                cx={xScale(series[hover].date)}
                cy={yScale(benchmarkAtHover.value)}
                r="3.5"
                fill="var(--paper)"
                stroke={BENCHMARK_STROKE}
                strokeWidth="1.75"
              />
            )}
          </g>
        )}
      </svg>

      {hover != null && series[hover] && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 12,
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            boxShadow: 'var(--shadow)',
            color: 'var(--ink)',
            pointerEvents: 'none',
            minWidth: 160,
          }}
        >
          <div
            style={{
              color: 'var(--ink-4)',
              fontSize: 10,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            {fmtDate(series[hover].date, 'monthYear')}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  marginRight: 6,
                }}
              />
              {portfolioLegendLabel}
            </span>
            <span style={{ fontWeight: 600 }}>{hoverFmt(series[hover].value)}</span>
          </div>
          {showBenchmark && benchmarkAtHover && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginTop: 4,
              }}
            >
              <span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: BENCHMARK_STROKE,
                    marginRight: 6,
                  }}
                />
                {benchmarkLabel}
              </span>
              <span style={{ color: 'var(--ink-3)' }}>
                {hoverFmt(benchmarkAtHover.value)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
