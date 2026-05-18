import { describe, it, expect } from 'vitest';
import { slugifyAccountId } from '../src/lib/db/accountId';

describe('slugifyAccountId', () => {
  it('returns a clean lowercase-dashed slug for a simple name', () => {
    expect(slugifyAccountId('Fidelity Taxable', 'Fidelity', [])).toBe('fidelity-taxable');
  });

  it('appends -2 on first collision', () => {
    expect(slugifyAccountId('Fidelity Taxable', 'Fidelity', ['fidelity-taxable'])).toBe('fidelity-taxable-2');
  });

  it('appends -3 when -2 is also taken', () => {
    expect(slugifyAccountId('Fidelity Taxable', 'Fidelity', ['fidelity-taxable', 'fidelity-taxable-2'])).toBe(
      'fidelity-taxable-3',
    );
  });

  it('skips over occupied numeric suffixes', () => {
    expect(
      slugifyAccountId('Fidelity Taxable', 'Fidelity', [
        'fidelity-taxable',
        'fidelity-taxable-2',
        'fidelity-taxable-3',
        'fidelity-taxable-4',
      ]),
    ).toBe('fidelity-taxable-5');
  });

  it('cleans apostrophes, ampersands, and slashes into dashes', () => {
    expect(slugifyAccountId("Justin's Taxable", 'Fidelity', [])).toBe('justin-s-taxable');
    expect(slugifyAccountId('Mom & Dad Joint', 'Schwab', [])).toBe('mom-dad-joint');
    expect(slugifyAccountId('Roth/IRA', 'Vanguard', [])).toBe('roth-ira');
  });

  it('caps the base slug at 40 characters before applying the dedupe suffix', () => {
    const longName = 'A'.repeat(80);
    const first = slugifyAccountId(longName, 'Fidelity', []);
    expect(first.length).toBe(40);
    expect(first).toBe('a'.repeat(40));

    const second = slugifyAccountId(longName, 'Fidelity', [first]);
    // Base remains 40 chars, then "-2" appended.
    expect(second).toBe('a'.repeat(40) + '-2');
    expect(second.length).toBe(42);
  });

  it('is deterministic: the same name always yields the same base slug', () => {
    const a = slugifyAccountId('Fidelity Taxable', 'Fidelity', []);
    const b = slugifyAccountId('Fidelity Taxable', 'Fidelity', []);
    const c = slugifyAccountId('Fidelity Taxable', 'Fidelity', []);
    expect(a).toBe('fidelity-taxable');
    expect(b).toBe('fidelity-taxable');
    expect(c).toBe('fidelity-taxable');
  });

  it('falls back to "account" when the input has no alphanumerics', () => {
    expect(slugifyAccountId('!!!', 'Custom', [])).toBe('account');
    expect(slugifyAccountId('   ', 'Custom', ['account'])).toBe('account-2');
  });
});
