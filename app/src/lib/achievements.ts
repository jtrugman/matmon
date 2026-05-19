// Shared helper that joins the static milestone catalog with per-user unlock
// rows from the achievements DB table. Used by both portfolio.ts (so
// MatmonData.achievements reflects the user's real unlocks) and the
// AchievementsView (which renders the joined list).
//
// Keeping the join in one place means the achievement-derived UI is always
// driven by what the user has actually accomplished, with the static catalog
// supplying the glyph / title / copy.

import { listAchievements } from './db/repos';
import { MILESTONE_CATALOG } from './milestoneCatalog';
import type { Achievement } from '../data';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row from the achievements table, normalized for view/portfolio joining. */
export type UnlockRow = { key: string; date: Date };

/**
 * Load achievement unlock rows from the DB. Returns an empty array on any
 * failure (so a flaky DB never crashes the portfolio build).
 */
export async function loadUnlockRows(): Promise<UnlockRow[]> {
  try {
    const rows = await listAchievements();
    return rows.map(r => ({ key: r.milestone_key, date: new Date(r.unlocked_at) }));
  } catch {
    return [];
  }
}

/**
 * Join the milestone catalog with the given unlock rows. Returns the catalog
 * in its declared order, with each entry annotated by whether the user has
 * unlocked it, the unlock date (or null), and a `fresh` flag set for unlocks
 * within the last 24 hours so the App.tsx toast can fire on a real unlock.
 *
 * Catalog metadata (glyph / title / copy) is preserved verbatim; the demo
 * data file is no longer consulted.
 */
export function joinCatalogWithUnlocks(unlocks: UnlockRow[], now: Date = new Date()): Achievement[] {
  const byKey = new Map(unlocks.map(u => [u.key, u]));
  return MILESTONE_CATALOG.map(entry => {
    const row = byKey.get(entry.key);
    const date = row?.date ?? null;
    const fresh = date != null && now.getTime() - date.getTime() < DAY_MS;
    const out: Achievement = {
      key: entry.key,
      glyph: entry.glyph,
      title: entry.title,
      copy: entry.copy,
      unlocked: !!row,
    };
    if (date) {
      out.date = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    }
    if (fresh) out.fresh = true;
    return out;
  });
}

/**
 * Convenience: load + join in one call. Used by portfolio.ts so the
 * MatmonData shape ships the real per-user state.
 */
export async function buildAchievements(now: Date = new Date()): Promise<Achievement[]> {
  const unlocks = await loadUnlockRows();
  return joinCatalogWithUnlocks(unlocks, now);
}
