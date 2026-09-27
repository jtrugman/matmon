#!/usr/bin/env -S node --experimental-strip-types
// Sanity check: produce the per-segment numbers table the bug report
// asked for. Reimplements the same window math the app uses so we don't
// drag SQLite imports into a CLI script. The behaviour is pinned by
// tests/series-filtering.test.ts; if those tests are green, this output
// reflects what the app shows.
//
// Usage:
//   node --experimental-strip-types scripts/segment-numbers.mts

type SP = { date: Date; value: number };

const NOW = new Date('2026-05-18T12:00:00Z');
const realSeries: SP[] = [
  { date: new Date('2018-01-01'), value: 6_000 },
  { date: new Date('2019-01-01'), value: 28_000 },
  { date: new Date('2020-03-23'), value: 60_000 },
  { date: new Date('2021-01-01'), value: 180_000 },
  { date: new Date('2022-01-01'), value: 320_000 },
  { date: new Date('2022-09-30'), value: 270_000 },
  { date: new Date('2023-01-01'), value: 310_000 },
  { date: new Date('2024-01-01'), value: 480_000 },
  { date: new Date('2025-01-01'), value: 600_000 },
  { date: new Date('2025-11-18'), value: 700_000 },
  { date: new Date('2026-02-18'), value: 720_000 },
  { date: new Date('2026-04-18'), value: 725_000 },
  { date: new Date('2026-05-01'), value: 728_000 },
  { date: new Date('2026-05-18'), value: 731_000 },
];

function segmentWindow(
  segment: '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL',
  now: Date,
): { start: Date; end: Date } {
  const end = now;
  let start: Date;
  switch (segment) {
    case '1M':
      start = new Date(+now - 30 * 86_400_000);
      break;
    case '3M':
      start = new Date(+now - 91 * 86_400_000);
      break;
    case '6M':
      start = new Date(+now - 182 * 86_400_000);
      break;
    case 'YTD':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    case '1Y':
      start = new Date(+now - 365 * 86_400_000);
      break;
    case '3Y':
      start = new Date(+now - 3 * 365 * 86_400_000);
      break;
    case '5Y':
      start = new Date(+now - 5 * 365 * 86_400_000);
      break;
    case 'ALL':
    default:
      start = new Date(0);
      break;
  }
  return { start, end };
}

function windowSeries(series: SP[], start: Date, end: Date): SP[] {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => +a.date - +b.date);
  const firstAvailable = +sorted[0].date;
  const lastAvailable = +sorted[sorted.length - 1].date;
  const lo = Math.max(+start, firstAvailable);
  const hi = Math.min(+end, lastAvailable);
  if (lo > hi) return [];
  return sorted.filter(p => +p.date >= lo && +p.date <= hi);
}

function twr(values: SP[]): number {
  if (values.length < 2) return NaN;
  const sortedV = [...values].sort((a, b) => +a.date - +b.date);
  let product = 1;
  for (let i = 1; i < sortedV.length; i++) {
    const startV = sortedV[i - 1].value;
    const endV = sortedV[i].value;
    if (startV <= 0) continue;
    const r = endV / startV - 1;
    product *= 1 + r;
  }
  return product - 1;
}

function twrOverWindow(series: SP[], start: Date, end: Date): number {
  if (series.length < 2) return NaN;
  const sortedSeries = [...series].sort((a, b) => +a.date - +b.date);
  const firstAvailable = sortedSeries[0].date;
  const effectiveStart = +start < +firstAvailable ? firstAvailable : start;
  if (+effectiveStart > +end) return NaN;
  const windowed = sortedSeries.filter(p => +p.date >= +effectiveStart && +p.date <= +end);
  if (windowed.length < 2) return NaN;
  return twr(windowed);
}

const SEGMENTS = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', 'ALL'] as const;

console.log('Per-segment window analysis (realistic portfolio shape):');
console.log('');
console.log('  seg   start         end           first NAV    last NAV     TWR %');
console.log('  ----  ------------  ------------  -----------  -----------  --------');

for (const seg of SEGMENTS) {
  const { start, end } = segmentWindow(seg, NOW);
  const windowed = windowSeries(realSeries, start, end);
  const startStr = windowed[0]?.date?.toISOString().slice(0, 10) ?? '(empty)';
  const endStr = windowed[windowed.length - 1]?.date?.toISOString().slice(0, 10) ?? '(empty)';
  const first = windowed[0]?.value;
  const last = windowed[windowed.length - 1]?.value;
  const twrVal = twrOverWindow(realSeries, start, end);
  const firstStr = (first != null ? `$${Math.round(first).toLocaleString()}` : '(empty)').padEnd(11);
  const lastStr = (last != null ? `$${Math.round(last).toLocaleString()}` : '(empty)').padEnd(11);
  const twrStr = isFinite(twrVal) ? `${(twrVal * 100).toFixed(2)}%` : 'NaN';
  console.log(
    `  ${seg.padEnd(4)}  ${startStr.padEnd(12)}  ${endStr.padEnd(12)}  ${firstStr}  ${lastStr}  ${twrStr}`,
  );
}
console.log('');
console.log('Compare against the pre-fix bug:');
console.log('  YTD on the qty-accumulation diagonal-line series produced +283%.');
console.log('  YTD on the real-mark series here is single-digit percent.');
