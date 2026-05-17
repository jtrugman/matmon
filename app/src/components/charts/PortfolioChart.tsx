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
};

export function PortfolioChart({
  series,
  benchmark,
  benchmarkLabel = 'SPY',
  showBenchmark = true,
  variant = 'area',
  height = 340,
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

  const padding = { top: 14, right: 18, bottom: 28, left: 56 };
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

    const xScale = (d: Date) => padding.left + ((d.getTime() - t0) / (t1 - t0)) * innerW;
    const yScale = (v: number) => padding.top + (1 - (v - minV) / (maxV - minV)) * innerH;

    const portfolioPath = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`)
      .join(' ');
    const portfolioArea = `${portfolioPath} L ${xScale(series[series.length - 1].date).toFixed(2)} ${padding.top + innerH} L ${xScale(series[0].date).toFixed(2)} ${padding.top + innerH} Z`;
    const benchmarkPath =
      showBenchmark && benchmark
        ? benchmark.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.date).toFixed(2)} ${yScale(p.value).toFixed(2)}`).join(' ')
        : null;

    const tickCount = 5;
    const yTicks = Array.from({ length: tickCount }, (_, i) => {
      const v = minV + ((maxV - minV) * i) / (tickCount - 1);
      return { v, y: yScale(v) };
    });
    const years: { label: string; x: number }[] = [];
    const startY = series[0].date.getFullYear();
    const endY = series[series.length - 1].date.getFullYear();
    for (let y = startY; y <= endY; y++) {
      const d = new Date(y, 0, 1);
      if (d >= series[0].date && d <= series[series.length - 1].date) {
        years.push({ label: String(y), x: xScale(d) });
      }
    }
    return { xScale, yScale, yTicks, xTicks: years, portfolioPath, portfolioArea, benchmarkPath };
  }, [series, benchmark, showBenchmark, innerW, innerH, width]);

  if (!computed) return null;
  const { xScale, yScale, yTicks, xTicks, portfolioPath, portfolioArea, benchmarkPath } = computed;

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

  return (
    <div ref={wrapRef} className="chart-wrap">
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
              {fmtMoney(t.v, { compact: true })}
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
            fill="none"
            stroke="var(--ink-4)"
            strokeWidth="1.25"
            strokeDasharray="3 4"
            opacity="0.7"
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
            {showBenchmark && benchmark && benchmark[hover] && (
              <circle
                cx={xScale(benchmark[hover].date)}
                cy={yScale(benchmark[hover].value)}
                r="3"
                fill="var(--paper)"
                stroke="var(--ink-3)"
                strokeWidth="1.25"
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
              Portfolio
            </span>
            <span style={{ fontWeight: 600 }}>{fmtMoney(series[hover].value, { compact: true })}</span>
          </div>
          {showBenchmark && benchmark && benchmark[hover] && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
              <span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--ink-4)',
                    marginRight: 6,
                  }}
                />
                {benchmarkLabel}
              </span>
              <span style={{ color: 'var(--ink-3)' }}>{fmtMoney(benchmark[hover].value, { compact: true })}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
