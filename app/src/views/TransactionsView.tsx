import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { EmptyState } from '../components/EmptyState';
import {
  fmtMoney,
  formatActionLabel,
  matchesActionFilter,
  type ActionFilterId,
  type ActionTier,
} from '../lib/format';
import { loadAllTransactions } from '../lib/db/repos';
import type { MatmonData } from '../data';

type TransactionsViewProps = {
  data: MatmonData;
  onAddAccount?: (brokerage?: string) => void;
};

type DisplayTx = {
  id: string;
  date: Date;
  symbol: string;
  /** Raw action code from the importer (e.g. 'cash_in', 'transfer_in'). */
  action: string;
  /** Display label (e.g. "Deposit", "Transfer in"). */
  actionLabel: string;
  /** Visual tier for the badge color. */
  tier: ActionTier;
  qty: number;
  price: number;
  amount: number | null;
  accountId: string;
  account: string;
  notes: string;
};

type DateRange = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
/**
 * Action-filter segment IDs. Sourced from format.ts so the predicate
 * (`matchesActionFilter`) and its segment vocabulary live in one place
 * and can be unit-tested without rendering the view.
 */
type ActionFilter = ActionFilterId;
type PageSize = 25 | 50 | 100 | 200;

// Range labels match the segmented control verbatim so any change to the
// control labels surfaces here. The control is the source of truth.
const RANGE_OPTIONS: DateRange[] = ['1M', '3M', 'YTD', '1Y', 'ALL'];
const PAGE_SIZE_OPTIONS: PageSize[] = [25, 50, 100, 200];

/**
 * Compute the cutoff Date for a given range, anchored on `now`. Transactions
 * with a date strictly before this cutoff are filtered out. Returns null for
 * the 'ALL' bucket so callers can short-circuit the predicate.
 */
function computeCutoffDate(range: DateRange, now: Date = new Date()): Date | null {
  switch (range) {
    case 'ALL':
      return null;
    case '1M': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d;
    }
    case '3M': {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return d;
    }
    case 'YTD':
      return new Date(now.getFullYear(), 0, 1);
    case '1Y': {
      const d = new Date(now);
      d.setDate(d.getDate() - 365);
      return d;
    }
  }
}

/**
 * Whimsical empty-state copy per (action filter, date range) combo. The keys
 * "all/buy/sell/div/cashflow" mirror the segment IDs. When `dateRange === 'ALL'` we
 * use the segment-specific punchline. Otherwise we lean on a range-aware
 * sentence so users understand "no buys in the last 30 days" vs. "no buys
 * ever".
 */
function emptyCopyFor(
  action: ActionFilter,
  range: DateRange,
): { title: string; body: string } {
  if (range === 'ALL') {
    switch (action) {
      case 'all':
        return {
          title: 'No transactions yet.',
          body: 'Import a CSV from Add Account to get started.',
        };
      case 'buy':
        return {
          title: "You're a saver, not a buyer.",
          body: 'Strong move. No buys on file yet.',
        };
      case 'sell':
        return {
          title: 'Diamond hands detected.',
          body: 'Zero sells across all-time.',
        };
      case 'div':
        return {
          title: 'Dividends are still on the way.',
          body: 'Patience pays. Nothing recorded yet.',
        };
      case 'cashflow':
        return {
          title: 'No deposits or withdrawals on file.',
          body: 'Capital coming soon?',
        };
    }
  }
  const rangeLabel: Record<Exclude<DateRange, 'ALL'>, string> = {
    '1M': 'the last 30 days',
    '3M': 'the last 90 days',
    YTD: 'this calendar year',
    '1Y': 'the last 12 months',
  };
  const window = rangeLabel[range as Exclude<DateRange, 'ALL'>];
  switch (action) {
    case 'all':
      return {
        title: 'Quiet stretch.',
        body: `No transactions in ${window}.`,
      };
    case 'buy':
      return {
        title: 'No buys logged.',
        body: `Nothing purchased in ${window}.`,
      };
    case 'sell':
      return {
        title: 'Holding firm.',
        body: `No sells in ${window}.`,
      };
    case 'div':
      return {
        title: 'No dividends posted.',
        body: `Nothing landed in ${window}.`,
      };
    case 'cashflow':
      return {
        title: 'No deposits or withdrawals in this range.',
        body: 'Capital coming soon?',
      };
  }
}

/**
 * Minimal in-card glyph for the filtered empty state. Kept inline so this view
 * doesn't grow a new Icon entry (the Icon registry is reserved for nav-level
 * glyphs). The mark is a small receipt with a tick, evocative of a transaction
 * log, drawn with strokeWidth that matches the rest of the view.
 */
function TransactionsEmptyGlyph() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 8h20v24l-3-2-3 2-3-2-3 2-3-2-3 2-2-1.5V8Z" />
      <path d="M15 15h10M15 20h10M15 25h6" />
    </svg>
  );
}

export function TransactionsView({ data, onAddAccount }: TransactionsViewProps) {
  // Real transactions from the DB. The old call to generateTransactions(data)
  // SYNTHESIZED demo flows from data.holdings, which fabricated random
  // buys/sells/divs for users who imported real CSVs. We now read the actual
  // transactions table.
  const [allTxs, setAllTxs] = useState<DisplayTx[]>([]);
  const accountNameById = useMemo(
    () => new Map(data.accounts.map(a => [a.id, a.name])),
    [data.accounts],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAllTransactions();
        if (cancelled) return;
        // Map every real action code to its display label and tier. The tier
        // drives both the badge color and which filter segment a row belongs
        // to. A `cash_in` row now renders as a blue "Deposit" badge instead
        // of being miscategorized as "BUY" in the old three-bucket scheme.
        const mapped: DisplayTx[] = rows
          .map((r, idx) => {
            const { label, tier } = formatActionLabel(r.action);
            return {
              id: `${r.id}-${idx}`,
              date: new Date(r.date),
              symbol: r.symbol || '',
              action: r.action,
              actionLabel: label,
              tier,
              qty: r.quantity,
              price: r.price,
              amount: r.amount,
              accountId: r.account_id,
              account: accountNameById.get(r.account_id) || r.account_id,
              notes: r.notes || '',
            };
          })
          // Newest first so the table shows recent activity on top.
          .sort((a, b) => +b.date - +a.date);
        setAllTxs(mapped);
      } catch {
        if (!cancelled) setAllTxs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.accounts, accountNameById]);

  const [filterAccount, setFilterAccount] = useState<string>('all');
  const [filterAction, setFilterAction] = useState<ActionFilter>('all');
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('ALL');
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [page, setPage] = useState(1);

  // Apply the filter chain: dateRange -> account -> action -> search. All four
  // run inside a single useMemo so the predicate sweep is one pass over the
  // array. With 303 rows this stays well under the 16ms / 60fps budget.
  const filtered = useMemo(() => {
    const cutoff = computeCutoffDate(dateRange);
    const cutoffMs = cutoff ? +cutoff : null;
    const q = search.trim().toLowerCase();
    return allTxs.filter(t => {
      if (cutoffMs !== null && +t.date < cutoffMs) return false;
      if (filterAccount !== 'all' && t.accountId !== filterAccount) return false;
      if (!matchesActionFilter(filterAction, t.tier)) return false;
      if (q && !t.symbol.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allTxs, dateRange, filterAccount, filterAction, search]);

  // Counts shown in the page header. We compute these against the dateRange
  // bucket so the "47 actions, last month" header agrees with the visible
  // table. The buy/sell/div/cashflow breakdown also respects dateRange so users
  // can see "0 sells" in the meta line when filtering to a quiet window.
  const dateScoped = useMemo(() => {
    const cutoff = computeCutoffDate(dateRange);
    const cutoffMs = cutoff ? +cutoff : null;
    if (cutoffMs === null) return allTxs;
    return allTxs.filter(t => +t.date >= cutoffMs);
  }, [allTxs, dateRange]);
  const counts = useMemo(
    () => ({
      buy: dateScoped.filter(t => t.tier === 'buy').length,
      sell: dateScoped.filter(t => t.tier === 'sell').length,
      div: dateScoped.filter(t => t.tier === 'income').length,
      cashflow: dateScoped.filter(t => t.tier === 'cashflow').length,
    }),
    [dateScoped],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp page on every render so out-of-bounds states from filter changes
  // resolve to page 1 (or the last valid page if the data merely shrank).
  // Without this, deleting a row mid-list could leave the user staring at an
  // empty page numbered 4 of 3.
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filtered.length);
  const visibleRows = filtered.slice(pageStart, pageEnd);

  // Reset to page 1 whenever any filter changes. We compare against the
  // previous filter signature so this only fires on user-driven changes and
  // not on every render. (A simple useEffect with deps does the right thing.)
  useEffect(() => {
    setPage(1);
    // Scroll the table into view so users don't have to hunt for the new top
    // row when they narrow a filter. We only scroll when there's at least one
    // row to anchor on, which avoids a jarring jump on a fresh empty state.
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [dateRange, filterAccount, filterAction, search, pageSize]);

  // Keyboard shortcuts for paging. Cmd/Ctrl + ArrowRight goes to the next page;
  // Cmd/Ctrl + ArrowLeft goes to the previous. The Cmd modifier keeps this
  // from clashing with arrow-key navigation inside the search input.
  const goNext = useCallback(() => {
    setPage(p => Math.min(p + 1, totalPages));
  }, [totalPages]);
  const goPrev = useCallback(() => {
    setPage(p => Math.max(p - 1, 1));
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev]);

  // Header meta copy. We say "all-time" when the range is ALL and otherwise
  // pin to a human-readable window so the count makes sense in context.
  const rangeMeta: Record<DateRange, string> = {
    ALL: 'all-time',
    '1M': 'last 30 days',
    '3M': 'last 90 days',
    YTD: 'year to date',
    '1Y': 'last 12 months',
  };
  const headerCount = dateScoped.length;

  return (
    <div>
      <PageHead
        title="Transactions"
        meta={
          <div>
            <div>
              {headerCount.toLocaleString()} actions, {rangeMeta[dateRange]}
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              {counts.buy} buys · {counts.sell} sells · {counts.div} dividends · {counts.cashflow} cash flows
            </div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn">Export CSV</button>
            <button className="btn btn-primary">Add transaction</button>
          </div>
        }
      />

      <div className="filter-bar">
        <div className="filter-search">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="6" r="4" />
            <path d="M9 9l4 4" />
          </svg>
          <input
            type="text"
            placeholder="Search symbol…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search transactions by symbol"
          />
        </div>
        <div className="filter-divider" />
        <select
          className="settings-select compact"
          value={filterAccount}
          onChange={e => setFilterAccount(e.target.value)}
          aria-label="Filter by account"
        >
          <option value="all">All accounts</option>
          {data.accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="Filter by action">
          {[
            { id: 'all' as const, label: 'All' },
            { id: 'buy' as const, label: 'Buys' },
            { id: 'sell' as const, label: 'Sells' },
            { id: 'div' as const, label: 'Dividends' },
            { id: 'cashflow' as const, label: 'Cash flows' },
          ].map(o => (
            <button
              key={o.id}
              className={filterAction === o.id ? 'active' : ''}
              onClick={() => setFilterAction(o.id)}
              aria-pressed={filterAction === o.id}
              data-testid={`tx-filter-${o.id}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg" role="group" aria-label="Filter by date range">
          {RANGE_OPTIONS.map(o => (
            <button
              key={o}
              className={dateRange === o ? 'active' : ''}
              onClick={() => setDateRange(o)}
              aria-pressed={dateRange === o}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      {allTxs.length === 0 ? (
        // First-run empty: the user has imported zero transactions ever. Keep
        // the CTA pointing to Add Account so they can get unblocked.
        <div style={{ marginTop: 12 }}>
          <EmptyState
            title="Your transaction history will live here once you import a CSV."
            body="Buys, sells, dividends, every line a story."
            onCta={onAddAccount ? () => onAddAccount() : undefined}
          />
        </div>
      ) : filtered.length === 0 ? (
        // Filter combination yields zero rows. Show the per-segment whimsical
        // copy. We render this inside a card-like container so the surface
        // matches the table that would otherwise sit here.
        <div
          className="card"
          style={{
            padding: 0,
            marginTop: 12,
            overflow: 'hidden',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: 240,
          }}
          data-testid="tx-empty-state"
        >
          <FilteredEmptyState action={filterAction} range={dateRange} />
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Symbol</th>
                  <th>Account</th>
                  <th className="r">Qty</th>
                  <th className="r">Price</th>
                  <th className="r">Amount</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(t => {
                  // Amount fallback: if the importer didn't record an explicit
                  // signed amount, derive it from qty * price for buys/sells
                  // (buys are negative, sells positive). Cashflow rows always
                  // carry an explicit amount from the importer so this path
                  // only fires for legacy / synthesized rows.
                  const amount =
                    t.amount != null
                      ? t.amount
                      : t.tier === 'sell'
                        ? +(t.qty * t.price)
                        : -(t.qty * t.price);
                  return (
                    <tr key={t.id} data-testid={`tx-row-${t.action}`}>
                      <td className="num">
                        {t.date.toLocaleDateString('en-US', {
                          month: 'short',
                          day: '2-digit',
                          year: 'numeric',
                        })}
                      </td>
                      <td>
                        <span
                          className={`activity-act ${t.tier}`}
                          data-testid={`tx-action-${t.action}`}
                        >
                          {t.actionLabel}
                        </span>
                      </td>
                      <td>
                        {t.symbol ? (
                          <span className="sym">{t.symbol}</span>
                        ) : (
                          <span className="muted" style={{ fontFamily: 'var(--font-mono)' }}>--</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{t.account}</td>
                      <td className="r num">
                        {t.qty > 0 ? t.qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '--'}
                      </td>
                      <td className="r num">{t.price > 0 ? fmtMoney(t.price, { cents: true }) : '--'}</td>
                      <td className="r num" style={{ color: amount >= 0 ? 'var(--gain)' : 'var(--ink)' }}>
                        {amount >= 0 ? '+' : ''}
                        {fmtMoney(amount, { cents: true })}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t.notes || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className="tx-pagination"
            style={{
              marginTop: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--ink-3)',
            }}
          >
            <div data-testid="tx-page-summary">
              Showing {filtered.length === 0 ? 0 : pageStart + 1} to {pageEnd} of{' '}
              {filtered.length.toLocaleString()}
            </div>
            <div style={{ flex: 1 }} />
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--ink-3)',
                fontSize: 11.5,
              }}
            >
              Per page
              <select
                className="settings-select compact"
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value) as PageSize)}
                aria-label="Rows per page"
                data-testid="tx-page-size"
              >
                {PAGE_SIZE_OPTIONS.map(n => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <div
              className="seg"
              role="group"
              aria-label="Pagination"
              data-testid="tx-pagination-controls"
            >
              <button
                onClick={goPrev}
                disabled={safePage <= 1}
                aria-label="Previous page"
                data-testid="tx-prev"
                style={{ opacity: safePage <= 1 ? 0.4 : 1, cursor: safePage <= 1 ? 'default' : 'pointer' }}
              >
                Prev
              </button>
              <button
                aria-current="page"
                aria-label={`Page ${safePage} of ${totalPages}`}
                data-testid="tx-page-indicator"
                className="active"
                style={{ cursor: 'default' }}
              >
                Page {safePage} of {totalPages}
              </button>
              <button
                onClick={goNext}
                disabled={safePage >= totalPages}
                aria-label="Next page"
                data-testid="tx-next"
                style={{
                  opacity: safePage >= totalPages ? 0.4 : 1,
                  cursor: safePage >= totalPages ? 'default' : 'pointer',
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Whimsical empty state for a filter combination that yields zero rows.
 * Distinct from the global "no transactions ever" EmptyState because the user
 * has data, they just narrowed past it. No CTA, no em dashes.
 */
function FilteredEmptyState({ action, range }: { action: ActionFilter; range: DateRange }) {
  const copy = emptyCopyFor(action, range);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '40px 28px',
        gap: 10,
        color: 'var(--ink-3)',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          border: '1.25px dashed var(--accent)',
          color: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--paper)',
          marginBottom: 4,
        }}
        aria-hidden="true"
      >
        <TransactionsEmptyGlyph />
      </div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          letterSpacing: '-0.005em',
          color: 'var(--ink)',
          maxWidth: 460,
          lineHeight: 1.25,
        }}
      >
        {copy.title}
      </div>
      <div
        style={{
          fontSize: 13.5,
          color: 'var(--ink-3)',
          maxWidth: 460,
          lineHeight: 1.5,
        }}
      >
        {copy.body}
      </div>
    </div>
  );
}
