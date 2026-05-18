// Unit tests for the fun-name pickers in src/lib/funNames.ts.
//
// pickFunNamesForRows is the per-row dealer that fixes the onboarding bug
// where every UploadRow shared the same 5 suggestions. The key invariants:
//  - each row gets a non-empty distinct slice
//  - no name appears in more than one row
//  - over-allocation (rows * perRow > pool size) gracefully shrinks perRow
//  - same seed yields same partitioning (deterministic)
//  - different seeds yield different partitioning

import { describe, expect, it } from 'vitest';
import { SUGGEST_POOL, pickFunNames, pickFunNamesForRows } from '../src/lib/funNames';

describe('pickFunNames', () => {
  it('returns the requested count of distinct names', () => {
    const out = pickFunNames(12345, 5);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
  });

  it('is deterministic for the same seed', () => {
    const a = pickFunNames(99, 5);
    const b = pickFunNames(99, 5);
    expect(a).toEqual(b);
  });

  it('different seeds produce different orderings', () => {
    const a = pickFunNames(1, 5);
    const b = pickFunNames(2, 5);
    expect(a).not.toEqual(b);
  });
});

describe('pickFunNamesForRows', () => {
  it('returns rows arrays of perRow names, all globally distinct', () => {
    const result = pickFunNamesForRows(42, 3, 5);
    expect(result).toHaveLength(3);
    for (const row of result) {
      expect(row).toHaveLength(5);
    }
    // All 15 names must be unique across the three rows.
    const all = result.flat();
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
  });

  it('gracefully reduces perRow when rows * perRow exceeds the pool', () => {
    // Pool is 28 names; 6 * 5 = 30 > 28. Helper must shrink perRow so every
    // row still gets a non-empty disjoint slice. floor(28 / 6) = 4.
    const result = pickFunNamesForRows(7, 6, 5);
    expect(result).toHaveLength(6);
    for (const row of result) {
      expect(row.length).toBeGreaterThan(0);
      // Shrunk size never exceeds what the pool can support per row.
      expect(row.length).toBeLessThanOrEqual(Math.floor(SUGGEST_POOL.length / 6));
    }
    // Still globally distinct.
    const all = result.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('same seed yields the same partitioning across calls', () => {
    const a = pickFunNamesForRows(2026, 4, 5);
    const b = pickFunNamesForRows(2026, 4, 5);
    expect(a).toEqual(b);
  });

  it('different seeds yield different partitioning', () => {
    const a = pickFunNamesForRows(1, 4, 5);
    const b = pickFunNamesForRows(2, 4, 5);
    expect(a).not.toEqual(b);
  });

  it('handles a single row exactly like a 1-row slice from the same shuffle', () => {
    // pickFunNamesForRows(seed, 1, n) should return the first n names of the
    // shuffled pool, matching pickFunNames(seed, n) byte for byte.
    const single = pickFunNamesForRows(31415, 1, 5);
    expect(single).toHaveLength(1);
    expect(single[0]).toEqual(pickFunNames(31415, 5));
  });

  it('returns an empty array when rows is zero or negative', () => {
    expect(pickFunNamesForRows(1, 0, 5)).toEqual([]);
    expect(pickFunNamesForRows(1, -3, 5)).toEqual([]);
  });

  it('every name dealt comes from SUGGEST_POOL', () => {
    const result = pickFunNamesForRows(555, 5, 5);
    const pool = new Set(SUGGEST_POOL);
    for (const row of result) {
      for (const name of row) {
        expect(pool.has(name)).toBe(true);
      }
    }
  });
});
