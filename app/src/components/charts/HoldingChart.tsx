import { useEffect, useRef, useState } from 'react';
import { fmtDate, fmtMoney } from '../../lib/format';
import type { SeriesPoint } from '../../data';

export type ChartTx = {
  id: number;
  date: Date;
  qty: number;
  price: number;
  amount?: number;
  account?: string;
};

type Props = {
  series: SeriesPoint[];
  benchmarkSeries?: SeriesPoint[] | null;
  benchmarkLabel?: string;
  buys?: ChartTx[];
  sells?: ChartTx[];
  divs?: ChartTx[];
  height?: number;
};

type MarkerHover = { tx: ChartTx; kind: 'buy' | 'sell' | 'div'; x: number; y: number };

export function HoldingChart({
  series,
  benchmarkSeries,
  benchmarkLabel = 'SPY',
  buys = [],
  sells = [],
  divs = [],
  height = 340,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [markerHover, setMarkerHover] = useState<MarkerHover | null>(null);
  const [lineHover, setLineHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(Math.max(420, Math.floor(e.contentRect.width)));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const padding = { top: 16, right: 18, bottom: 28, left: 60 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = [
    ...series.map(p => p.value),
    ...(benchmarkSeries ? benchmarkSeries.map(p => p.value) : []),
  ];
  const minV = Math.min(...allValues) * 0.95;
  const maxV = Math.max(...allValues) * 1.05;
  const t0 = series[0].date.getTime();
  const t1 = series[series.length - 1].date.getTime();

  const xScale = (d: Date) => padding.left + ((d.getTime() - t0) / (t1 - t0)) * innerW;
  const yScale = (v: number) => padding.top + (1 - (v - minV) / (maxV - minV)) * innerH;

  const linePath = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L ${xScale(series[series.length - 1].date)} ${padding.top + innerH} L ${xScale(series[0].date)} ${padding.top + innerH} Z`;
  const benchmarkPath = benchmarkSeries
    ? benchmarkSeries
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`)
        .join(' ')
    : null;

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minV + ((maxV - minV) * i) / 4;
    return { v, y: yScale(v) };
  });
  const xTicks: { x: number; label: string }[] = [];
  for (let y = series[0].date.getFullYear() + 1; y <= series[series.length - 1].date.getFullYear(); y++) {
    const d = new Date(y, 0, 1);
    if (d >= series[0].date && d <= series[series.length - 1].date) {
      xTicks.push({ x: xScale(d), label: String(y) });
    }
  }

  const priceAt = (date: Date): number => {
    if (date < series[0].date) return series[0].value;
    if (date > series[series.length - 1].date) return series[series.length - 1].value;
    let prev = series[0];
    let next = series[series.length - 1];
    for (let i = 0; i < series.length - 1; i++) {
      if (series[i].date <= date && series[i + 1].date >= date) {
        prev = series[i];
        next = series[i + 1];
        break;
      }
    }
    const span = next.date.getTime() - prev.date.getTime();
    const t = span === 0 ? 0 : (date.getTime() - prev.date.getTime()) / span;
    return prev.value + (next.value - prev.value) * t;
  };

  const renderMarker = (tx: ChartTx, kind: 'buy' | 'sell' | 'div') => {
    if (tx.date < series[0].date) return null;
    const x = xScale(tx.date);
    const y = yScale(priceAt(tx.date));
    const color = kind === 'buy' ? 'var(--gain)' : kind === 'sell' ? 'var(--loss)' : 'var(--accent)';
    const onEnter = () => setMarkerHover({ tx, kind, x, y });
    const onLeave = () => setMarkerHover(null);
    if (kind === 'div') {
      return (
        <g key={`d${tx.id}`} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ cursor: 'help' }}>
          <circle cx={x} cy={y} r={8} fill="transparent" />
          <circle cx={x} cy={y} r={3.5} fill={color} stroke="var(--paper)" strokeWidth="1.2" />
        </g>
      );
    }
    if (kind === 'sell') {
      const r = 5.5;
      return (
        <g key={`s${tx.id}`} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ cursor: 'help' }}>
          <rect x={x - 9} y={y - 9} width="18" height="18" fill="transparent" />
          <path
            d={`M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`}
            fill={color}
            stroke="var(--paper)"
            strokeWidth="0.9"
          />
        </g>
      );
    }
    const tri = `M ${x} ${y + 6} L ${x - 5} ${y + 14} L ${x + 5} ${y + 14} Z`;
    return (
      <g key={`b${tx.id}`} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ cursor: 'help' }}>
        <rect x={x - 8} y={y + 4} width="16" height="14" fill="transparent" />
        <path d={tri} fill={color} stroke="var(--paper)" strokeWidth="0.8" />
      </g>
    );
  };

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (markerHover) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    if (px < padding.left || px > padding.left + innerW) {
      setLineHover(null);
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
    setLineHover(best);
  };

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="chart-svg"
        onMouseMove={handleMove}
        onMouseLeave={() => setLineHover(null)}
      >
        <defs>
          <linearGradient id="holdingFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
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
              strokeDasharray={i === 0 || i === yTicks.length - 1 ? '0' : '2 4'}
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
              {fmtMoney(t.v, { compact: true, cents: t.v < 100 })}
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

        {benchmarkPath && (
          <path
            d={benchmarkPath}
            fill="none"
            stroke="var(--ink-4)"
            strokeWidth="1.25"
            strokeDasharray="3 4"
            opacity="0.7"
          />
        )}
        <path d={areaPath} fill="url(#holdingFill)" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {buys.map(t => renderMarker(t, 'buy'))}
        {sells.map(t => renderMarker(t, 'sell'))}
        {divs.map(t => renderMarker(t, 'div'))}

        {lineHover != null && !markerHover && (
          <g>
            <line
              x1={xScale(series[lineHover].date)}
              x2={xScale(series[lineHover].date)}
              y1={padding.top}
              y2={padding.top + innerH}
              stroke="var(--ink-3)"
              strokeWidth="0.75"
              strokeDasharray="3 3"
            />
            <circle
              cx={xScale(series[lineHover].date)}
              cy={yScale(series[lineHover].value)}
              r="4"
              fill="var(--paper)"
              stroke="var(--accent)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {markerHover && (
        <div
          className="hd-tooltip"
          style={{
            left: `${(markerHover.x / width) * 100}%`,
            top: `${(markerHover.y / height) * 100}%`,
          }}
        >
          <div
            className="hd-tooltip-eyebrow"
            style={{
              color:
                markerHover.kind === 'buy'
                  ? 'var(--gain)'
                  : markerHover.kind === 'sell'
                  ? 'var(--loss)'
                  : 'var(--accent)',
            }}
          >
            {markerHover.kind === 'buy'
              ? 'You bought'
              : markerHover.kind === 'sell'
              ? 'You sold'
              : 'Dividend received'}
          </div>
          <div className="hd-tooltip-title">
            {markerHover.tx.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
          {markerHover.kind !== 'div' ? (
            <div className="hd-tooltip-body">
              <div>
                <span>Qty</span>
                <span className="num">{markerHover.tx.qty.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              </div>
              <div>
                <span>Price</span>
                <span className="num">{fmtMoney(markerHover.tx.price, { cents: true })}</span>
              </div>
              <div>
                <span>Total</span>
                <span className="num">
                  {fmtMoney(markerHover.tx.qty * markerHover.tx.price, { cents: true })}
                </span>
              </div>
            </div>
          ) : (
            <div className="hd-tooltip-body">
              <div>
                <span>Amount</span>
                <span className="num">{fmtMoney(markerHover.tx.amount || 0, { cents: true })}</span>
              </div>
              <div>
                <span>Account</span>
                <span style={{ fontSize: 11 }}>{markerHover.tx.account}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {lineHover != null && !markerHover && (
        <div className="hd-readout">
          <div className="hd-readout-date">{fmtDate(series[lineHover].date, 'monthYear')}</div>
          <div className="hd-readout-row">
            <span>
              <span className="hd-readout-swatch" style={{ background: 'var(--accent)' }} />
              Price
            </span>
            <span className="num">{fmtMoney(series[lineHover].value, { cents: true })}</span>
          </div>
          {benchmarkSeries && benchmarkSeries[lineHover] && (
            <div className="hd-readout-row">
              <span>
                <svg width="14" height="2" style={{ marginRight: 6 }}>
                  <line x1="0" y1="1" x2="14" y2="1" stroke="var(--ink-4)" strokeWidth="1.25" strokeDasharray="3 2" />
                </svg>
                {benchmarkLabel}
              </span>
              <span className="num muted">{fmtMoney(benchmarkSeries[lineHover].value, { cents: true })}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
