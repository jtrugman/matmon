import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../../lib/format';

type YearPoint = { year: number; value: number };

type Props = {
  contributions: YearPoint[];
  growth: YearPoint[];
  goal?: number;
  height?: number;
};

export function ProjectionChart({ contributions, growth, goal, height = 240 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(Math.max(400, Math.floor(e.contentRect.width)));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const padding = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const total = contributions.map((c, i) => c.value + growth[i].value);
  const maxV = Math.max(...total, goal ?? 0) * 1.05;
  const minV = 0;
  const x0 = contributions[0].year;
  const x1 = contributions[contributions.length - 1].year;
  const xScale = (y: number) => padding.left + ((y - x0) / (x1 - x0)) * innerW;
  const yScale = (v: number) => padding.top + (1 - (v - minV) / (maxV - minV)) * innerH;

  const contribArea = [
    ...contributions.map(
      (c, i) => `${i === 0 ? 'M' : 'L'} ${xScale(c.year).toFixed(1)} ${yScale(c.value).toFixed(1)}`,
    ),
    `L ${xScale(x1).toFixed(1)} ${padding.top + innerH}`,
    `L ${xScale(x0).toFixed(1)} ${padding.top + innerH}`,
    'Z',
  ].join(' ');
  const totalArea = [
    ...contributions.map(
      (c, i) => `${i === 0 ? 'M' : 'L'} ${xScale(c.year).toFixed(1)} ${yScale(total[i]).toFixed(1)}`,
    ),
    ...contributions
      .slice()
      .reverse()
      .map((c, i) => {
        const idx = contributions.length - 1 - i;
        return `L ${xScale(c.year).toFixed(1)} ${yScale(contributions[idx].value).toFixed(1)}`;
      }),
    'Z',
  ].join(' ');
  const totalLine = contributions
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${xScale(c.year).toFixed(1)} ${yScale(total[i]).toFixed(1)}`)
    .join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minV + ((maxV - minV) * i) / 4;
    return { v, y: yScale(v) };
  });

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="chart-svg">
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
              x={padding.left - 8}
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
        {contributions
          .filter(
            (_, i) => i % Math.max(1, Math.floor(contributions.length / 6)) === 0 || i === contributions.length - 1,
          )
          .map((c, i) => (
            <text
              key={i}
              x={xScale(c.year)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10.5"
              fontFamily="var(--font-mono)"
              fill="var(--ink-4)"
            >
              {c.year}
            </text>
          ))}

        <path d={totalArea} fill="var(--accent)" opacity="0.16" />
        <path d={contribArea} fill="var(--ink-3)" opacity="0.18" />
        <path
          d={contributions
            .map((c, i) => `${i === 0 ? 'M' : 'L'} ${xScale(c.year).toFixed(1)} ${yScale(c.value).toFixed(1)}`)
            .join(' ')}
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="1.25"
          strokeDasharray="3 3"
        />
        <path
          d={totalLine}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {goal != null && (
          <g>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={yScale(goal)}
              y2={yScale(goal)}
              stroke="var(--loss)"
              strokeWidth="1.25"
              strokeDasharray="4 4"
              opacity="0.75"
            />
            <rect
              x={width - padding.right - 76}
              y={yScale(goal) - 11}
              width="74"
              height="18"
              rx="4"
              fill="var(--paper)"
              stroke="var(--loss)"
              strokeWidth="0.75"
            />
            <text
              x={width - padding.right - 39}
              y={yScale(goal) + 3}
              textAnchor="middle"
              fontSize="10.5"
              fontFamily="var(--font-mono)"
              fill="var(--loss)"
              fontWeight="600"
            >
              Goal · {fmtMoney(goal, { compact: true })}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
