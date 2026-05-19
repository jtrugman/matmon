// TickerLogo: company / fund logo with a colored monogram fallback.
//
// Lookup order on mount:
//   1. Check the local DB (ticker_logos table).
//      - status='ok' with bytes → render <img> with a data URL.
//      - status='missing' / 'error' and < 30 days old → render monogram, no fetch.
//   2. If no row exists (or the existing row is older than 30 days), kick off
//      a background fetch via fetchTickerLogo() and save the result, then
//      re-render so the now-cached logo replaces the monogram.
//
// We never block render on the network. Every ticker always has a visible
// fallback so a CSV import that arrives offline still looks polished.
//
// To keep the component dependency-light it manages its own cache lookup +
// optional fetch. The prefetcher (src/lib/logos.ts) handles the bulk path on
// CSV import; this component handles the one-off path for any holding that
// somehow slipped through (e.g. a manually added transaction).

import { useEffect, useRef, useState } from 'react';
import { fetchTickerLogo } from '../lib/logos';
import { getLogo, markLogoMissing, saveLogo } from '../lib/db/repos';

const MISSING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Props = {
  ticker: string;
  /** Pixel size of the square logo. Defaults to 24 for table cells. */
  size?: number;
};

/** Deterministic per-ticker color so the monogram doesn't look random across renders. */
function colorForTicker(ticker: string): string {
  // Cheap hash → hue. Same ticker → same color across the entire app.
  let h = 0;
  for (let i = 0; i < ticker.length; i++) {
    h = (h * 31 + ticker.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `oklch(0.55 0.11 ${hue})`;
}

function monogramFor(ticker: string): string {
  const clean = ticker.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (clean.length === 0) return '?';
  if (clean.length === 1) return clean;
  return clean.slice(0, 2);
}

function bytesToDataUrl(bytes: Uint8Array, format: string): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return `data:image/${format};base64,${btoa(binary)}`;
}

export function TickerLogo({ ticker, size = 24 }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  // Track whether we've already attempted a network fetch this mount so we
  // don't double-dispatch if a parent re-renders rapidly.
  const attempted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const key = (ticker || '').trim().toUpperCase();
    if (!key) {
      setSrc(null);
      return;
    }
    attempted.current = false;
    setSrc(null);

    (async () => {
      try {
        const cached = await getLogo(key);
        if (cancelled) return;
        if (cached && cached.status === 'ok' && cached.bytes && cached.bytes.length > 0) {
          setSrc(bytesToDataUrl(cached.bytes, cached.format || 'png'));
          return;
        }
        // Honor recent 'missing' / 'error' rows: no monogram refetch within TTL.
        if (cached && Date.now() - cached.fetchedAt.getTime() < MISSING_TTL_MS) {
          return;
        }
        if (attempted.current) return;
        attempted.current = true;
        const bytes = await fetchTickerLogo(key);
        if (cancelled) return;
        if (bytes && bytes.length > 0) {
          await saveLogo(key, bytes, 'png').catch(() => {});
          if (!cancelled) setSrc(bytesToDataUrl(bytes, 'png'));
        } else {
          await markLogoMissing(key, 'missing').catch(() => {});
        }
      } catch {
        // Network reject. Stamp it as 'error' so we honor the cooldown.
        try {
          await markLogoMissing(key, 'error');
        } catch {
          /* best-effort */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const display = (ticker || '').trim().toUpperCase();
  const initials = monogramFor(display);
  const bg = colorForTicker(display);

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.22),
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    verticalAlign: 'middle',
  };

  if (src) {
    return (
      <span
        className="ticker-logo has-logo"
        style={{
          ...baseStyle,
          background: 'var(--paper)',
          border: '1px solid var(--line)',
        }}
        aria-label={`${display} logo`}
        role="img"
      >
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={() => setSrc(null)}
        />
      </span>
    );
  }

  return (
    <span
      className="ticker-logo monogram"
      style={{
        ...baseStyle,
        background: bg,
        color: 'white',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        letterSpacing: '0.02em',
      }}
      aria-label={`${display} placeholder`}
      role="img"
    >
      {initials}
    </span>
  );
}
