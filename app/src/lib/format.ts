export function fmtMoney(
  v: number | null | undefined,
  { compact = false, cents = false }: { compact?: boolean; cents?: boolean } = {},
): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (compact) {
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

export function fmtPct(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(decimals)}%`;
}

export function fmtDate(d: Date, fmt: 'short' | 'monthYear' | 'year' = 'short'): string {
  if (fmt === 'monthYear') return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  if (fmt === 'year') return d.getFullYear().toString();
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}
