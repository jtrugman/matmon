// Cash-flow row labeling in TransactionsView.
//
// The bug Justin reported: a cash_in row (Electronic Funds Transfer Received)
// was displayed as "BUY" because the old view bucketed every non-sell /
// non-income action into 'buy'. The fix moves the display label + visual
// tier into src/lib/format.ts (formatActionLabel) so every action code maps
// to its own humanized label and color tier.
//
// What we cover here:
//   1. formatActionLabel returns the right (label, tier) for every
//      supported action code, including unknown ones (title-cased fallback).
//   2. matchesActionFilter routes rows to the correct segment.
//   3. The full TransactionsView render assigns the correct label + class
//      for each action code: a cash_in row reads "Deposit" with the
//      cashflow tier, never "Buy".
//   4. The "Cash flows" filter segment surfaces only cash-flow actions,
//      and composes with the date range (e.g. cashflow + 1Y).

import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatActionLabel, matchesActionFilter } from '../src/lib/format';
import { TransactionsView } from '../src/views/TransactionsView';
import { MATMON_DATA } from './__fixtures__/sampleData';
import * as repos from '../src/lib/db/repos';
import type { ParsedTransaction } from '../src/lib/importers/types';

afterEach(() => {
  cleanup();
});

describe('formatActionLabel', () => {
  it('maps buy → Buy / buy tier', () => {
    expect(formatActionLabel('buy')).toEqual({ label: 'Buy', tier: 'buy' });
  });
  it('maps sell → Sell / sell tier', () => {
    expect(formatActionLabel('sell')).toEqual({ label: 'Sell', tier: 'sell' });
  });
  it('maps dividend → Dividend / income tier', () => {
    expect(formatActionLabel('dividend')).toEqual({ label: 'Dividend', tier: 'income' });
  });
  it('maps div_reinvest → Reinvest / income tier', () => {
    expect(formatActionLabel('div_reinvest')).toEqual({ label: 'Reinvest', tier: 'income' });
  });
  it('maps interest → Interest / income tier', () => {
    expect(formatActionLabel('interest')).toEqual({ label: 'Interest', tier: 'income' });
  });
  it('maps cash_in → Deposit / cashflow tier (NOT buy)', () => {
    // This is the bug Justin reported in the screenshot batch: the row was
    // displaying as "BUY" instead of a proper deposit label. Guard rails.
    const result = formatActionLabel('cash_in');
    expect(result.label).toBe('Deposit');
    expect(result.tier).toBe('cashflow');
    expect(result.label).not.toBe('Buy');
  });
  it('maps cash_out → Withdrawal / cashflow tier', () => {
    expect(formatActionLabel('cash_out')).toEqual({ label: 'Withdrawal', tier: 'cashflow' });
  });
  it('maps transfer_in → Transfer in / cashflow tier', () => {
    expect(formatActionLabel('transfer_in')).toEqual({ label: 'Transfer in', tier: 'cashflow' });
  });
  it('maps transfer_out → Transfer out / cashflow tier', () => {
    expect(formatActionLabel('transfer_out')).toEqual({ label: 'Transfer out', tier: 'cashflow' });
  });
  it('maps contribution → Contribution / cashflow tier', () => {
    expect(formatActionLabel('contribution')).toEqual({ label: 'Contribution', tier: 'cashflow' });
  });
  it('maps withdrawal → Withdrawal / cashflow tier', () => {
    expect(formatActionLabel('withdrawal')).toEqual({ label: 'Withdrawal', tier: 'cashflow' });
  });
  it('maps fee → Fee / fee tier', () => {
    expect(formatActionLabel('fee')).toEqual({ label: 'Fee', tier: 'fee' });
  });
  it('maps unknown action codes to title-cased label / other tier', () => {
    // The importer ACTION_MAP includes split and spinoff. These aren't in
    // the curated table above, so they should fall through to the
    // title-case branch. Same goes for any future addition.
    expect(formatActionLabel('split')).toEqual({ label: 'Split', tier: 'other' });
    expect(formatActionLabel('spinoff')).toEqual({ label: 'Spinoff', tier: 'other' });
  });
  it('preserves multi-word unknown codes via underscore-to-space', () => {
    expect(formatActionLabel('return_of_capital')).toEqual({
      label: 'Return Of Capital',
      tier: 'other',
    });
  });
  it('falls back to "Other" for the empty string', () => {
    expect(formatActionLabel('')).toEqual({ label: 'Other', tier: 'other' });
  });
});

describe('matchesActionFilter', () => {
  it('all segment matches every tier', () => {
    expect(matchesActionFilter('all', 'buy')).toBe(true);
    expect(matchesActionFilter('all', 'sell')).toBe(true);
    expect(matchesActionFilter('all', 'income')).toBe(true);
    expect(matchesActionFilter('all', 'cashflow')).toBe(true);
    expect(matchesActionFilter('all', 'fee')).toBe(true);
    expect(matchesActionFilter('all', 'other')).toBe(true);
  });
  it('buy segment matches only buy tier', () => {
    expect(matchesActionFilter('buy', 'buy')).toBe(true);
    expect(matchesActionFilter('buy', 'sell')).toBe(false);
    expect(matchesActionFilter('buy', 'cashflow')).toBe(false);
  });
  it('sell segment matches only sell tier', () => {
    expect(matchesActionFilter('sell', 'sell')).toBe(true);
    expect(matchesActionFilter('sell', 'buy')).toBe(false);
  });
  it('div segment matches only income tier (dividend, div_reinvest, interest)', () => {
    expect(matchesActionFilter('div', 'income')).toBe(true);
    expect(matchesActionFilter('div', 'buy')).toBe(false);
    expect(matchesActionFilter('div', 'cashflow')).toBe(false);
  });
  it('cashflow segment matches only cashflow tier', () => {
    expect(matchesActionFilter('cashflow', 'cashflow')).toBe(true);
    expect(matchesActionFilter('cashflow', 'buy')).toBe(false);
    expect(matchesActionFilter('cashflow', 'income')).toBe(false);
    expect(matchesActionFilter('cashflow', 'sell')).toBe(false);
    expect(matchesActionFilter('cashflow', 'fee')).toBe(false);
  });
});

/**
 * Seed the DB with one of each action code under a single account so we can
 * assert the rendered labels in TransactionsView. Dates are spaced so the
 * "ALL" range catches every row.
 */
async function seedOneOfEachAction(accountId: string): Promise<ParsedTransaction[]> {
  const today = new Date();
  const baseDate = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return d;
  };
  const txs: ParsedTransaction[] = [
    {
      date: baseDate(1),
      symbol: null,
      action: 'cash_in',
      quantity: 0,
      price: 0,
      fees: 0,
      amount: 300,
      currency: 'USD',
      notes: 'Electronic Funds Transfer Received',
      rawHash: 'fixture-cash_in',
    },
    {
      date: baseDate(2),
      symbol: null,
      action: 'cash_out',
      quantity: 0,
      price: 0,
      fees: 0,
      amount: -150,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-cash_out',
    },
    {
      date: baseDate(3),
      symbol: 'XFER',
      action: 'transfer_in',
      quantity: 10,
      price: 50,
      fees: 0,
      amount: 500,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-transfer_in',
    },
    {
      date: baseDate(4),
      symbol: 'XFER',
      action: 'transfer_out',
      quantity: 5,
      price: 50,
      fees: 0,
      amount: 250,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-transfer_out',
    },
    {
      date: baseDate(5),
      symbol: 'AAPL',
      action: 'buy',
      quantity: 1,
      price: 200,
      fees: 0,
      amount: -200,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-buy',
    },
    {
      date: baseDate(6),
      symbol: 'AAPL',
      action: 'sell',
      quantity: 1,
      price: 220,
      fees: 0,
      amount: 220,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-sell',
    },
    {
      date: baseDate(7),
      symbol: 'AAPL',
      action: 'dividend',
      quantity: 0,
      price: 0,
      fees: 0,
      amount: 5,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-dividend',
    },
    {
      date: baseDate(8),
      symbol: 'VTI',
      action: 'div_reinvest',
      quantity: 0.05,
      price: 200,
      fees: 0,
      amount: 10,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-div_reinvest',
    },
    {
      date: baseDate(9),
      symbol: null,
      action: 'interest',
      quantity: 0,
      price: 0,
      fees: 0,
      amount: 0.42,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-interest',
    },
    {
      date: baseDate(10),
      symbol: null,
      action: 'fee',
      quantity: 0,
      price: 0,
      fees: 1,
      amount: -1,
      currency: 'USD',
      notes: '',
      rawHash: 'fixture-fee',
    },
  ];
  await repos.insertAccount({
    id: accountId,
    name: 'Fixture Account',
    brokerage: 'Fixture',
    account_type: 'taxable',
    currency: 'USD',
    created_at: new Date().toISOString(),
  });
  await repos.insertTransactions(accountId, txs);
  return txs;
}

describe('TransactionsView cash-flow row labels', () => {
  it('renders a cash_in row as "Deposit" (not "Buy")', async () => {
    await seedOneOfEachAction('fixture-acct');
    render(<TransactionsView data={MATMON_DATA} />);
    // Wait for the table to mount with the cash_in row.
    await waitFor(() => {
      expect(screen.queryByTestId('tx-row-cash_in')).toBeInTheDocument();
    });
    const badge = screen.getByTestId('tx-action-cash_in');
    expect(badge.textContent).toBe('Deposit');
    expect(badge.className).toContain('cashflow');
    expect(badge.className).not.toContain('buy');
  });

  it('renders the full set of action labels with distinct classes', async () => {
    await seedOneOfEachAction('fixture-acct');
    render(<TransactionsView data={MATMON_DATA} />);
    await waitFor(() => {
      expect(screen.queryByTestId('tx-action-cash_in')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tx-action-cash_in').textContent).toBe('Deposit');
    expect(screen.getByTestId('tx-action-cash_out').textContent).toBe('Withdrawal');
    expect(screen.getByTestId('tx-action-transfer_in').textContent).toBe('Transfer in');
    expect(screen.getByTestId('tx-action-transfer_out').textContent).toBe('Transfer out');
    expect(screen.getByTestId('tx-action-buy').textContent).toBe('Buy');
    expect(screen.getByTestId('tx-action-sell').textContent).toBe('Sell');
    expect(screen.getByTestId('tx-action-dividend').textContent).toBe('Dividend');
    expect(screen.getByTestId('tx-action-div_reinvest').textContent).toBe('Reinvest');
    expect(screen.getByTestId('tx-action-interest').textContent).toBe('Interest');
    expect(screen.getByTestId('tx-action-fee').textContent).toBe('Fee');
  });

  it('Cash flows filter segment shows only cash-flow actions', async () => {
    await seedOneOfEachAction('fixture-acct');
    render(<TransactionsView data={MATMON_DATA} />);
    await waitFor(() => {
      expect(screen.queryByTestId('tx-row-cash_in')).toBeInTheDocument();
    });
    // Click the "Cash flows" segment.
    const cashflowBtn = screen.getByTestId('tx-filter-cashflow');
    await userEvent.click(cashflowBtn);
    // After filtering: cash_in, cash_out, transfer_in, transfer_out must
    // remain. Buys / sells / dividends / fees must be gone.
    await waitFor(() => {
      expect(screen.queryByTestId('tx-row-cash_in')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tx-row-cash_in')).toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-cash_out')).toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-transfer_in')).toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-transfer_out')).toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-buy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-sell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-dividend')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tx-row-fee')).not.toBeInTheDocument();
  });

  it('Cash flows filter empty-state message reads "No deposits or withdrawals" with prompt', async () => {
    // Seed only a buy: cash flows filter will yield zero rows.
    await repos.insertAccount({
      id: 'fixture-acct',
      name: 'Fixture',
      brokerage: 'Fixture',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await repos.insertTransactions('fixture-acct', [
      {
        date: new Date('2024-06-01'),
        symbol: 'AAPL',
        action: 'buy',
        quantity: 1,
        price: 200,
        fees: 0,
        amount: -200,
        currency: 'USD',
        notes: '',
        rawHash: 'only-buy',
      },
    ]);
    render(<TransactionsView data={MATMON_DATA} />);
    await waitFor(() => {
      expect(screen.queryByTestId('tx-row-buy')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('tx-filter-cashflow'));
    // The empty-state card should be visible with the cashflow copy.
    await waitFor(() => {
      expect(screen.getByTestId('tx-empty-state')).toBeInTheDocument();
    });
    const empty = screen.getByTestId('tx-empty-state');
    expect(empty.textContent).toMatch(/No deposits or withdrawals/i);
    expect(empty.textContent).toMatch(/Capital coming soon/i);
  });

  it('Cash flows + 1Y date range composes correctly', async () => {
    // Seed mixed dates: one cash_in within 1Y, one cash_in 2 years ago.
    const now = new Date();
    const recent = new Date(now);
    recent.setDate(recent.getDate() - 60);
    const old = new Date(now);
    old.setFullYear(now.getFullYear() - 2);

    await repos.insertAccount({
      id: 'fixture-acct',
      name: 'Fixture',
      brokerage: 'Fixture',
      account_type: 'taxable',
      currency: 'USD',
      created_at: new Date().toISOString(),
    });
    await repos.insertTransactions('fixture-acct', [
      {
        date: recent,
        symbol: null,
        action: 'cash_in',
        quantity: 0,
        price: 0,
        fees: 0,
        amount: 100,
        currency: 'USD',
        notes: '',
        rawHash: 'cash_in-recent',
      },
      {
        date: old,
        symbol: null,
        action: 'cash_in',
        quantity: 0,
        price: 0,
        fees: 0,
        amount: 200,
        currency: 'USD',
        notes: '',
        rawHash: 'cash_in-old',
      },
      {
        date: recent,
        symbol: 'AAPL',
        action: 'buy',
        quantity: 1,
        price: 200,
        fees: 0,
        amount: -200,
        currency: 'USD',
        notes: '',
        rawHash: 'buy-recent',
      },
    ]);
    render(<TransactionsView data={MATMON_DATA} />);
    await waitFor(() => {
      // ALL range default; both cash_in rows visible (plus the buy).
      const rows = screen.queryAllByTestId('tx-row-cash_in');
      expect(rows.length).toBe(2);
    });
    // Switch to Cash flows segment.
    await userEvent.click(screen.getByTestId('tx-filter-cashflow'));
    await waitFor(() => {
      const rows = screen.queryAllByTestId('tx-row-cash_in');
      // Both still visible; buy is hidden.
      expect(rows.length).toBe(2);
    });
    expect(screen.queryByTestId('tx-row-buy')).not.toBeInTheDocument();
    // Switch range to 1Y. The old cash_in (2 years ago) should drop out.
    const rangeGroup = screen.getByRole('group', { name: /Filter by date range/i });
    const oneYBtn = rangeGroup.querySelector('button:nth-of-type(4)');
    expect(oneYBtn).not.toBeNull();
    await userEvent.click(oneYBtn!);
    await waitFor(() => {
      const rows = screen.queryAllByTestId('tx-row-cash_in');
      expect(rows.length).toBe(1);
    });
  });
});
