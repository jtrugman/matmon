// Tests for HoldingsView column-header sorting.
//
// Repro for the bug: clicking a sortable column header was reported to
// "spawn another row" instead of sorting the table. These tests pin down the
// expected behavior: the header click sorts the table, surfaces an arrow
// indicator on the active column, toggles direction on repeated clicks, and
// crucially does NOT fire the row-level onSelect handler.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MATMON_DATA } from './__fixtures__/sampleData';
import { HoldingsView } from '../src/views/HoldingsView';

function symbolOrderFromTable(): string[] {
  // Each <tr> in <tbody> renders the symbol inside a <div class="sym"> in its
  // first cell, so reading textContent on those gives us the row order.
  const rows = document.querySelectorAll('table.tbl tbody tr');
  return Array.from(rows).map(r => r.querySelector('.sym')?.textContent?.trim() ?? '');
}

describe('HoldingsView column sort', () => {
  it('default sort is by value DESC and the Value header shows the down arrow', () => {
    render(<HoldingsView data={MATMON_DATA} />);
    const valueHeader = screen.getByRole('columnheader', { name: /Value/ });
    expect(valueHeader.textContent).toMatch(/↓/);

    const order = symbolOrderFromTable();
    const valuesInOrder = order.map(sym => MATMON_DATA.holdings.find(h => h.sym === sym)!.value);
    // Descending: each value should be <= the previous one.
    for (let i = 1; i < valuesInOrder.length; i++) {
      expect(valuesInOrder[i]).toBeLessThanOrEqual(valuesInOrder[i - 1]);
    }
  });

  it('clicking the Symbol header sorts by symbol DESC on first click', async () => {
    render(<HoldingsView data={MATMON_DATA} />);
    const before = symbolOrderFromTable();

    const symbolHeader = screen.getByRole('columnheader', { name: /Symbol/ });
    await userEvent.click(symbolHeader);

    const after = symbolOrderFromTable();
    // Same set of symbols, different order.
    expect(after.slice().sort()).toEqual(before.slice().sort());
    expect(after).not.toEqual(before);

    // Default first-click direction is DESC, so we expect reverse-alphabetical.
    const expected = [...after].sort((a, b) => b.localeCompare(a));
    expect(after).toEqual(expected);

    // And the active column should now show the down arrow.
    const symbolHeaderAfter = screen.getByRole('columnheader', { name: /Symbol/ });
    expect(symbolHeaderAfter.textContent).toMatch(/↓/);
  });

  it('clicking the same header twice toggles to ASC', async () => {
    render(<HoldingsView data={MATMON_DATA} />);
    const symbolHeader = screen.getByRole('columnheader', { name: /Symbol/ });
    await userEvent.click(symbolHeader);
    await userEvent.click(symbolHeader);

    const after = symbolOrderFromTable();
    const expected = [...after].sort((a, b) => a.localeCompare(b));
    expect(after).toEqual(expected);

    expect(screen.getByRole('columnheader', { name: /Symbol/ }).textContent).toMatch(/↑/);
  });

  it('clicking a header does NOT trigger row onSelect navigation', async () => {
    const onSelect = vi.fn();
    render(<HoldingsView data={MATMON_DATA} onSelect={onSelect} />);

    const priceHeader = screen.getByRole('columnheader', { name: /Price/ });
    await userEvent.click(priceHeader);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('header click does not change the number of rendered rows', async () => {
    render(<HoldingsView data={MATMON_DATA} />);
    const before = document.querySelectorAll('table.tbl tbody tr').length;

    const gainHeader = screen.getByRole('columnheader', { name: /Gain/ });
    await userEvent.click(gainHeader);
    await userEvent.click(gainHeader);
    await userEvent.click(gainHeader);

    const after = document.querySelectorAll('table.tbl tbody tr').length;
    expect(after).toBe(before);
    expect(after).toBe(MATMON_DATA.holdings.length);
  });

  it('Sector and % headers also show an arrow when active', async () => {
    render(<HoldingsView data={MATMON_DATA} />);

    const sectorHeader = screen.getByRole('columnheader', { name: /Sector/ });
    await userEvent.click(sectorHeader);
    expect(screen.getByRole('columnheader', { name: /Sector/ }).textContent).toMatch(/[↑↓]/);

    const pctHeader = screen.getByRole('columnheader', { name: /^\s*%/ });
    await userEvent.click(pctHeader);
    expect(screen.getByRole('columnheader', { name: /^\s*%/ }).textContent).toMatch(/[↑↓]/);
  });

  it('sort works in the filtered (account-detail) HoldingsView too', async () => {
    // fid-tax holds VTI, VXUS, AAPL, SPAXX in the demo data.
    render(<HoldingsView data={MATMON_DATA} filterAccountId="fid-tax" onBack={() => {}} />);

    const onlyExpected = MATMON_DATA.holdings
      .filter(h => h.account === 'fid-tax')
      .map(h => h.sym)
      .sort();
    expect(symbolOrderFromTable().slice().sort()).toEqual(onlyExpected);

    const symbolHeader = screen.getByRole('columnheader', { name: /Symbol/ });
    await userEvent.click(symbolHeader);

    const after = symbolOrderFromTable();
    const expectedDesc = [...onlyExpected].sort((a, b) => b.localeCompare(a));
    expect(after).toEqual(expectedDesc);

    // Still the same number of rows we started with.
    expect(after.length).toBe(onlyExpected.length);
  });

  it('header cells live in <thead>, not <tbody> (regression: no extra body row)', () => {
    render(<HoldingsView data={MATMON_DATA} />);
    const table = document.querySelector('table.tbl')!;
    const thead = within(table.querySelector('thead') as HTMLElement);
    const tbody = table.querySelector('tbody') as HTMLElement;

    // Header row contains the "Symbol" label.
    expect(thead.getByText(/Symbol/)).toBeInTheDocument();
    // tbody should contain exactly one row per holding, no header echo.
    expect(tbody.querySelectorAll('tr').length).toBe(MATMON_DATA.holdings.length);
  });
});
