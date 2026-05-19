// Logos pipeline: fetch + cache + prefetch coordinator.
//
// We stub global.fetch directly. The httpGet helper in src/lib/logos.ts
// branches on a Tauri global that the test environment never sets, so the
// browser `fetch` path is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTickerLogo, prefetchLogos, __resetLogoQueueForTests } from '../src/lib/logos';
import { getLogo, markLogoMissing, saveLogo } from '../src/lib/db/repos';

const SAMPLE_PNG = new Uint8Array([
  // PNG magic header (8 bytes) + a tiny dummy payload. Not a valid image,
  // but the code under test only cares about (length > 0).
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

function mockFetchOnce(status: number, body: Uint8Array | null = null) {
  const buf = body
    ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    : new ArrayBuffer(0);
  return vi.fn().mockResolvedValueOnce({
    status,
    arrayBuffer: () => Promise.resolve(buf),
  } as unknown as Response);
}

describe('fetchTickerLogo', () => {
  beforeEach(() => {
    __resetLogoQueueForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the PNG bytes on a 200 response', async () => {
    (globalThis as any).fetch = mockFetchOnce(200, SAMPLE_PNG);
    const bytes = await fetchTickerLogo('AAPL');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.length).toBe(SAMPLE_PNG.length);
    expect(Array.from(bytes!)).toEqual(Array.from(SAMPLE_PNG));
  });

  it('returns null on a 404', async () => {
    (globalThis as any).fetch = mockFetchOnce(404);
    const bytes = await fetchTickerLogo('NOPE');
    expect(bytes).toBeNull();
  });

  it('returns null when the bytes payload is empty', async () => {
    (globalThis as any).fetch = mockFetchOnce(200, new Uint8Array(0));
    const bytes = await fetchTickerLogo('EMPTY');
    expect(bytes).toBeNull();
  });

  it('normalizes lowercase / whitespace tickers before requesting', async () => {
    const spy = mockFetchOnce(200, SAMPLE_PNG);
    (globalThis as any).fetch = spy;
    await fetchTickerLogo('  aapl  ');
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('/ticker/AAPL?');
  });

  it('returns null for an empty ticker without making a request', async () => {
    const spy = vi.fn();
    (globalThis as any).fetch = spy;
    const bytes = await fetchTickerLogo('');
    expect(bytes).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('logo cache round-trip · browser shim', () => {
  beforeEach(() => {
    __resetLogoQueueForTests();
  });

  it('saveLogo + getLogo preserves byte content', async () => {
    await saveLogo('MSFT', SAMPLE_PNG, 'png');
    const hit = await getLogo('MSFT');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('ok');
    expect(hit!.bytes).not.toBeNull();
    expect(Array.from(hit!.bytes!)).toEqual(Array.from(SAMPLE_PNG));
    expect(hit!.format).toBe('png');
  });

  it('getLogo is case-insensitive on ticker lookup', async () => {
    await saveLogo('vti', SAMPLE_PNG);
    const hit = await getLogo('VTI');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('ok');
  });

  it('markLogoMissing sets status=missing and bytes are null', async () => {
    await markLogoMissing('XYZZY');
    const hit = await getLogo('XYZZY');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('missing');
    expect(hit!.bytes).toBeNull();
  });

  it('saveLogo overwrites a prior missing record', async () => {
    await markLogoMissing('GME');
    await saveLogo('GME', SAMPLE_PNG);
    const hit = await getLogo('GME');
    expect(hit!.status).toBe('ok');
    expect(hit!.bytes).not.toBeNull();
  });

  it('returns null for a ticker that was never recorded', async () => {
    const hit = await getLogo('NEVERSEEN');
    expect(hit).toBeNull();
  });
});

describe('prefetchLogos', () => {
  beforeEach(() => {
    __resetLogoQueueForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips tickers that already have an ok logo cached', async () => {
    await saveLogo('AAPL', SAMPLE_PNG);
    const spy = vi.fn();
    (globalThis as any).fetch = spy;
    await prefetchLogos(['AAPL']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips tickers that were recently marked missing', async () => {
    await markLogoMissing('XYZZY');
    const spy = vi.fn();
    (globalThis as any).fetch = spy;
    await prefetchLogos(['XYZZY']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches an uncached ticker and persists the bytes', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: () => Promise.resolve(SAMPLE_PNG.buffer.slice(0)),
    } as unknown as Response);
    await prefetchLogos(['VOO']);
    const hit = await getLogo('VOO');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('ok');
    expect(hit!.bytes).not.toBeNull();
  });

  it('records 404s as status=missing', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      status: 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response);
    await prefetchLogos(['ZZZZ']);
    const hit = await getLogo('ZZZZ');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('missing');
  });

  it('records network rejections as status=error and does not throw', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(prefetchLogos(['OFFL'])).resolves.toBeUndefined();
    const hit = await getLogo('OFFL');
    expect(hit).not.toBeNull();
    expect(hit!.status).toBe('error');
  });

  it('deduplicates and skips empty / null tickers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: () => Promise.resolve(SAMPLE_PNG.buffer.slice(0)),
    } as unknown as Response);
    (globalThis as any).fetch = fetchSpy;
    await prefetchLogos(['AAPL', 'aapl', '  AAPL  ', '', null, undefined]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
