// Shared pool of playful account-name suggestions used by both the onboarding
// flow and the standalone Add Account view. A deterministic shuffle keyed off a
// per-mount seed gives each session a stable but varied subset, so the same
// user doesn't see "The Lighthouse" first every single time they open the page.

export const SUGGEST_POOL: readonly string[] = [
  'The Lighthouse',
  'The Roost',
  'The Greenhouse',
  'The Workshop',
  'The Hatch',
  'The Annex',
  "My Girlfriend's a Princess Fund",
  "My Boyfriend's a Prince Fund",
  'Future Me Thanks You',
  'The Slow Boat',
  'The Beach House Bet',
  'Operation Touch Grass',
  'The Quiet Wealth',
  'Bagel Money',
  'The Long Lever',
  'Compound, Baby',
  'The Acorn Pile',
  'Dragon Vault',
  'Buy the Dip Society',
  "Don't Touch This",
  'The Patience Project',
  'The Forever Account',
  'Coast Mode',
  'The Rainy Day',
  'My Eventual Cabin',
  'The Slow Cooker',
  'Yacht Optional',
  'The Big Quiet',
];

/**
 * Deterministically pick `count` distinct names from SUGGEST_POOL using a
 * Fisher-Yates shuffle seeded by `seed`. Same seed always yields the same
 * sequence (useful for stable-per-mount suggestions); different seeds yield
 * different sequences (useful for "fresh feel on each new session").
 */
export function pickFunNames(seed: number, count = 5): string[] {
  const out = [...SUGGEST_POOL];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(((Math.sin(seed * (i + 1) * 12.9898) + 1) / 2) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, count);
}

/**
 * Deal `rows` x `perRow` distinct names from SUGGEST_POOL. The same name never
 * appears in more than one row. If `rows * perRow > pool.length`, perRow is
 * reduced proportionally (to `Math.floor(pool.length / rows)`) so every row
 * still gets a non-empty unique slice.
 *
 * Uses the same seeded shuffle as `pickFunNames` so a given seed produces a
 * stable partitioning across renders; different seeds yield different splits.
 *
 * Edge cases:
 *  - `rows <= 0` returns `[]`.
 *  - `rows > pool.length` clamps effective rows to the pool size (every row
 *    that "fits" gets exactly one name; remaining rows would yield empty, so
 *    we cap rows at the pool length and any caller asking for more rows than
 *    we can serve uniquely will see the cap reflected in the returned length).
 */
export function pickFunNamesForRows(seed: number, rows: number, perRow = 5): string[][] {
  if (rows <= 0) return [];
  const pool = [...SUGGEST_POOL];
  // Same Fisher-Yates seeded shuffle as pickFunNames so behavior matches.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(((Math.sin(seed * (i + 1) * 12.9898) + 1) / 2) * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Cap rows at pool size so every row is guaranteed at least one unique name.
  const effectiveRows = Math.min(rows, pool.length);
  // Shrink perRow proportionally when the request would otherwise overflow.
  // floor(pool.length / rows) is the largest size that keeps every row's slice
  // disjoint and non-empty. We never grow perRow beyond the caller's ask.
  const cap = Math.max(1, Math.floor(pool.length / effectiveRows));
  const size = Math.min(perRow, cap);
  const out: string[][] = [];
  for (let r = 0; r < effectiveRows; r++) {
    out.push(pool.slice(r * size, r * size + size));
  }
  return out;
}
