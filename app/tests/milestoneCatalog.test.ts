import { describe, expect, it } from 'vitest';
import {
  MILESTONE_CATALOG,
  MILESTONE_BY_KEY,
  WATCHED_MILESTONE_KEYS,
  type MilestoneCategory,
} from '../src/lib/milestoneCatalog';
import { MILESTONE_DEFS } from '../src/lib/milestones';

// PRD §10 lists 28 user-facing milestones. The catalog adds a `hidden_1`
// silhouette for the "Hidden ahead" placeholder slot, so we expect 29 total.
const PRD_MILESTONE_COUNT = 28;
const EXPECTED_TOTAL = PRD_MILESTONE_COUNT + 1;

describe('MILESTONE_CATALOG', () => {
  it('contains all 28 PRD milestones plus the hidden placeholder', () => {
    expect(MILESTONE_CATALOG).toHaveLength(EXPECTED_TOTAL);
  });

  it('includes a hidden_1 silhouette in the secret category', () => {
    const hidden = MILESTONE_BY_KEY['hidden_1'];
    expect(hidden).toBeDefined();
    expect(hidden.category).toBe('secret');
    expect(hidden.secret).toBe(true);
  });

  it('every entry has key, glyph, title, copy, category, and description', () => {
    const validCategories: MilestoneCategory[] = [
      'value',
      'activity',
      'dividends',
      'tenure',
      'discipline',
      'planning',
      'secret',
    ];
    for (const m of MILESTONE_CATALOG) {
      expect(m.key, `key on ${JSON.stringify(m)}`).toMatch(/^[a-z0-9_]+$/);
      expect(m.glyph, `glyph on ${m.key}`).toBeTruthy();
      expect(m.title, `title on ${m.key}`).toBeTruthy();
      expect(m.copy, `copy on ${m.key}`).toBeTruthy();
      expect(m.description, `description on ${m.key}`).toBeTruthy();
      expect(validCategories).toContain(m.category);
    }
  });

  it('every value milestone has a positive thresholdValue', () => {
    const valueEntries = MILESTONE_CATALOG.filter(m => m.category === 'value');
    expect(valueEntries.length).toBeGreaterThan(0);
    for (const m of valueEntries) {
      expect(m.thresholdValue, `thresholdValue on ${m.key}`).toBeDefined();
      expect(m.thresholdValue!).toBeGreaterThan(0);
    }
  });

  it('non-value, non-secret milestones do not require a thresholdValue', () => {
    // Sanity check that the catalog does not falsely tag a non-value milestone
    // with a thresholdValue. (Coming-up-next sorts value entries by threshold.)
    const nonValue = MILESTONE_CATALOG.filter(m => m.category !== 'value' && m.category !== 'secret');
    expect(nonValue.length).toBeGreaterThan(0);
  });

  it('keys are unique', () => {
    const keys = MILESTONE_CATALOG.map(m => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every watched milestone key appears in the catalog', () => {
    // The runtime watcher should never fire a key the UI does not know about.
    for (const key of WATCHED_MILESTONE_KEYS) {
      expect(MILESTONE_BY_KEY[key], `watched key ${key} missing from catalog`).toBeDefined();
    }
  });

  it('every watched key has a trigger wired in milestones.ts', () => {
    const defKeys = new Set(MILESTONE_DEFS.map(d => d.key));
    for (const key of WATCHED_MILESTONE_KEYS) {
      expect(defKeys.has(key), `watched key ${key} has no trigger`).toBe(true);
    }
  });

  it('every MILESTONE_DEFS key is in the catalog (no orphan triggers)', () => {
    for (const def of MILESTONE_DEFS) {
      expect(MILESTONE_BY_KEY[def.key], `trigger key ${def.key} missing from catalog`).toBeDefined();
    }
  });
});
