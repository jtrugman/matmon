import { describe, expect, it } from 'vitest';
import {
  listScenarios,
  loadUserProfile,
  saveGoalScenario,
  saveUserProfile,
  type OnboardingProfile,
} from '../src/lib/db/repos';

function profile(overrides: Partial<OnboardingProfile> = {}): OnboardingProfile {
  return {
    name: 'Justin',
    birthYear: 1985,
    retireAge: 67,
    household: 'partnered',
    theme: 'light',
    ...overrides,
  };
}

describe('saveUserProfile + loadUserProfile', () => {
  it('returns null before any profile has been saved', async () => {
    expect(await loadUserProfile()).toBeNull();
  });

  it('round-trips every field', async () => {
    await saveUserProfile(profile({ name: 'Justin', birthYear: 1985, retireAge: 67, household: 'partnered' }));
    const out = await loadUserProfile();
    expect(out).not.toBeNull();
    expect(out!.name).toBe('Justin');
    expect(out!.birth_year).toBe(1985);
    expect(out!.target_retirement_age).toBe(67);
    expect(out!.household_size).toBe(2); // 'partnered' → 2
    expect(out!.expected_retirement_income).toBeNull();
  });

  it('maps household enum to numeric size', async () => {
    await saveUserProfile(profile({ household: 'single' }));
    expect((await loadUserProfile())!.household_size).toBe(1);

    await saveUserProfile(profile({ household: 'partnered' }));
    expect((await loadUserProfile())!.household_size).toBe(2);

    await saveUserProfile(profile({ household: 'family' }));
    expect((await loadUserProfile())!.household_size).toBe(3);
  });

  it('replaces the prior row on re-save (single-row table)', async () => {
    await saveUserProfile(profile({ name: 'First' }));
    await saveUserProfile(profile({ name: 'Second', birthYear: 1990 }));
    const out = await loadUserProfile();
    expect(out!.name).toBe('Second');
    expect(out!.birth_year).toBe(1990);
  });
});

describe('saveGoalScenario', () => {
  it('writes a row to the scenarios table with name + inputs_json containing the goal', async () => {
    const goal = 3_000_000;
    await saveGoalScenario(goal, profile());

    const rows = await listScenarios();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.name).toContain('$3.0M');
    expect(typeof row.inputs_json).toBe('string');

    const parsed = JSON.parse(row.inputs_json);
    expect(parsed.goal).toBe(goal);
    expect(parsed.source).toBe('onboarding');
    expect(parsed.years).toBeGreaterThan(0);
    expect(typeof parsed.created_at === 'undefined').toBe(true); // created_at is a column, not an input
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it('appends rather than overwrites when called twice (each scenario is a row)', async () => {
    await saveGoalScenario(2_000_000, profile());
    await saveGoalScenario(5_000_000, profile());
    const rows = await listScenarios();
    expect(rows).toHaveLength(2);
    const goals = rows.map(r => JSON.parse(r.inputs_json).goal).sort();
    expect(goals).toEqual([2_000_000, 5_000_000]);
  });
});
