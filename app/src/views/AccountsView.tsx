import { useEffect, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { EmptyState } from '../components/EmptyState';
import { fmtMoney } from '../lib/format';
import { getTaxConstants } from '../lib/taxConstants';
import { loadAllTransactions } from '../lib/db/repos';
import type { MatmonData, Account } from '../data';

type Props = {
  data: MatmonData;
  onAddAccount?: (brokerage?: string) => void;
  onOpenAccount?: (accountId: string) => void;
};

type ContribPanel = {
  name: string;
  label: string;
  used: number;
  limit: number;
  year: number;
};

// Build real YTD contribution panels grouped by account type. We only render a
// panel when the user actually owns at least one account of that type. The
// "used" number sums real cash_in / transfer_in / contribution / buy actions
// for the current calendar year, scoped to accounts of that type.
function buildContributionPanels(
  accounts: Account[],
  txs: Array<{ account_id: string; date: Date; action: string; amount: number | null; price: number; quantity: number; fees: number }>,
  tax: { year: number; contributionLimits: { traditional_401k: number; roth_ira: number; hsa_self_only: number; hsa_family: number } },
): ContribPanel[] {
  const accountsByType = new Map<string, Account[]>();
  for (const a of accounts) {
    const list = accountsByType.get(a.type) || [];
    list.push(a);
    accountsByType.set(a.type, list);
  }
  const ytdYear = new Date().getFullYear();

  // Sum of inflows for a given account type within the current calendar year.
  // We treat cash_in, transfer_in, contribution, and buys as "money you put
  // in". For buys we use abs(qty * price + fees) since buys are typically
  // recorded with a negative amount.
  const ytdInflowFor = (accountIds: Set<string>): number => {
    let sum = 0;
    for (const t of txs) {
      if (!accountIds.has(t.account_id)) continue;
      if (t.date.getFullYear() !== ytdYear) continue;
      const a = t.action;
      if (a === 'cash_in' || a === 'transfer_in' || a === 'contribution') {
        sum += Math.abs(t.amount ?? 0);
      } else if (a === 'buy') {
        const derived = t.amount != null ? Math.abs(t.amount) : Math.abs(t.quantity * t.price + t.fees);
        sum += derived;
      }
    }
    return sum;
  };

  const panels: ContribPanel[] = [];
  const k401 = accountsByType.get('401k');
  if (k401 && k401.length > 0) {
    const ids = new Set(k401.map(a => a.id));
    panels.push({
      name: '401(k)',
      label: k401[0].name,
      used: ytdInflowFor(ids),
      limit: tax.contributionLimits.traditional_401k,
      year: tax.year,
    });
  }
  const roth = accountsByType.get('roth_ira');
  if (roth && roth.length > 0) {
    const ids = new Set(roth.map(a => a.id));
    panels.push({
      name: 'Roth IRA',
      label: roth[0].name,
      used: ytdInflowFor(ids),
      limit: tax.contributionLimits.roth_ira,
      year: tax.year,
    });
  }
  const hsa = accountsByType.get('hsa');
  if (hsa && hsa.length > 0) {
    const ids = new Set(hsa.map(a => a.id));
    // We don't know whether the user has self-only vs family coverage; default
    // to family because most users hitting an HSA panel are couples. They can
    // mentally compare to whichever limit applies.
    panels.push({
      name: 'HSA',
      label: hsa[0].name,
      used: ytdInflowFor(ids),
      limit: tax.contributionLimits.hsa_family,
      year: tax.year,
    });
  }
  return panels;
}

export function AccountsView({ data, onAddAccount, onOpenAccount }: Props) {
  const tax = getTaxConstants();
  const [contributionPanels, setContributionPanels] = useState<ContribPanel[]>([]);
  // Per-account transaction counts and cost-basis totals. Used by the
  // skeleton-account filter below so a $0-value account with a $0 cost basis
  // and zero transactions never lands on the page. The filter is defense in
  // depth: even with upsertAccountByFingerprint in place at insert time, this
  // catches any future regression that re-introduces phantom rows.
  const [txCounts, setTxCounts] = useState<Map<string, number>>(new Map());
  const [costBases, setCostBases] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadAllTransactions();
        if (cancelled) return;
        const txs = rows.map(r => ({
          account_id: r.account_id,
          date: new Date(r.date),
          action: r.action,
          amount: r.amount,
          price: r.price,
          quantity: r.quantity,
          fees: r.fees,
        }));
        // Roll up the per-account stats we need for the skeleton filter.
        const tc = new Map<string, number>();
        const cb = new Map<string, number>();
        for (const r of rows) {
          tc.set(r.account_id, (tc.get(r.account_id) || 0) + 1);
          // Money in is "cost basis touched" (buys + transfer_in + reinvests).
          // We only need a non-zero signal to release the filter, not the
          // accurate cost basis the portfolio aggregator computes.
          if (r.action === 'buy' || r.action === 'transfer_in' || r.action === 'div_reinvest') {
            cb.set(
              r.account_id,
              (cb.get(r.account_id) || 0) + Math.abs(r.quantity * r.price + r.fees),
            );
          }
        }
        setTxCounts(tc);
        setCostBases(cb);
        // Contribution panels derive from non-skeleton accounts only. A
        // skeleton has value === 0, costBasis === 0, and no transactions.
        const nonSkeleton = data.accounts.filter(a => {
          if (a.value > 0) return true;
          if ((cb.get(a.id) || 0) > 0) return true;
          if ((tc.get(a.id) || 0) > 0) return true;
          return false;
        });
        setContributionPanels(buildContributionPanels(nonSkeleton, txs, tax));
      } catch {
        if (!cancelled) {
          setTxCounts(new Map());
          setCostBases(new Map());
          setContributionPanels([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.accounts, tax]);

  // Defense-in-depth filter: hide accounts that look like leftover skeletons
  // from a previous duplicate-insert bug. An account qualifies as a skeleton
  // iff value === 0 AND costBasis === 0 AND it has zero transactions. The
  // moment the user imports anything against the account (or types in a
  // genuine empty account by hand and then imports a CSV) the filter releases.
  const isSkeleton = (a: Account): boolean => {
    if (a.value > 0) return false;
    if ((costBases.get(a.id) || 0) > 0) return false;
    if ((txCounts.get(a.id) || 0) > 0) return false;
    return true;
  };
  const visibleAccounts = data.accounts.filter(a => !isSkeleton(a));
  const hasAccounts = visibleAccounts.length > 0;

  const groups = visibleAccounts.reduce<
    Record<string, { name: string; accounts: Account[]; total: number; dayChange: number }>
  >((acc, a) => {
    if (!acc[a.brokerage]) acc[a.brokerage] = { name: a.brokerage, accounts: [], total: 0, dayChange: 0 };
    acc[a.brokerage].accounts.push(a);
    acc[a.brokerage].total += a.value;
    acc[a.brokerage].dayChange += a.dayChange;
    return acc;
  }, {});
  const sorted = Object.values(groups).sort((a, b) => b.total - a.total);

  return (
    <div>
      <PageHead
        title="Accounts"
        meta={
          <div>
            <div>{fmtMoney(data.totalValue, { cents: false })} total</div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              {sorted.length} brokerages · {visibleAccounts.length} accounts
            </div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => onAddAccount?.()}>
              Add an Account
            </button>
          </div>
        }
      />

      {!hasAccounts && (
        <EmptyState
          title="You don't have any accounts yet."
          body="Matmon needs at least one to start showing your numbers. Drop a CSV from any of your brokerages."
          onCta={() => onAddAccount?.()}
        />
      )}

      {hasAccounts && (
        <div className="brokerage-groups">
          {sorted.map(g => (
            <div className="brokerage-group" key={g.name}>
              <div className="brokerage-group-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <BrokerageLogo name={g.name} size="large" />
                  <div>
                    <div className="brokerage-group-name">{g.name}</div>
                    <div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
                      {g.accounts.length} account{g.accounts.length === 1 ? '' : 's'} ·{' '}
                      {((g.total / data.totalValue) * 100).toFixed(1)}% of portfolio
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontSize: 22, color: 'var(--ink)' }}>
                    {fmtMoney(g.total, { cents: false })}
                  </div>
                  <div
                    className="num"
                    style={{ fontSize: 12, color: g.dayChange >= 0 ? 'var(--gain)' : 'var(--loss)' }}
                  >
                    {g.dayChange >= 0 ? '+' : ''}
                    {fmtMoney(g.dayChange, { cents: true })} today
                  </div>
                </div>
              </div>

              <div className="brokerage-accounts">
                {g.accounts.map(a => {
                  const t = data.accountTypes.find(x => x.id === a.type)!;
                  // Click-anywhere row: the entire .brokerage-account-row is a
                  // button-roled element that fires onOpenAccount. We keep the
                  // "Open →" affordance on the right as a visual hint but it
                  // no longer has its own click handler (clicks bubble up to
                  // the row). Keyboard: Enter / Space also navigate.
                  const handleRowOpen = () => onOpenAccount?.(a.id);
                  const handleRowKey = (ev: React.KeyboardEvent<HTMLDivElement>) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      handleRowOpen();
                    }
                  };
                  return (
                    <div
                      className="brokerage-account-row"
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      data-testid={`account-row-${a.id}`}
                      onClick={handleRowOpen}
                      onKeyDown={handleRowKey}
                      aria-label={`Open ${a.name}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className="bar-type-pip" style={{ background: t.color }} />
                      <div>
                        <div className="bar-name">{a.name}</div>
                        <div className="bar-meta">{t.label}</div>
                      </div>
                      <div className="bar-value">
                        <div className="num" style={{ fontSize: 15, color: 'var(--ink)' }}>
                          {fmtMoney(a.value, { cents: true })}
                        </div>
                        <div
                          className="num"
                          style={{
                            fontSize: 11,
                            color: a.dayChange >= 0 ? 'var(--gain)' : 'var(--loss)',
                          }}
                        >
                          {a.dayChange >= 0 ? '+' : ''}
                          {fmtMoney(a.dayChange, { cents: true })}
                        </div>
                      </div>
                      <div className="bar-share">{((a.value / g.total) * 100).toFixed(1)}%</div>
                      <button
                        type="button"
                        className="bar-open"
                        onClick={ev => {
                          // The whole row already navigates via the parent's
                          // onClick handler. Keeping a button here preserves
                          // the existing "Open →" affordance + an alternate
                          // click target (and the full-app-smoke spec asserts
                          // button.bar-open is clickable). We stop propagation
                          // because the parent row would otherwise re-fire
                          // navigation; the explicit call here handles both
                          // click sources identically.
                          ev.stopPropagation();
                          handleRowOpen();
                        }}
                        aria-label={`Open ${a.name}`}
                      >
                        Open →
                      </button>
                    </div>
                  );
                })}
                <button className="brokerage-account-add" onClick={() => onAddAccount?.(g.name)}>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 22,
                      color: 'var(--ink-3)',
                      lineHeight: 1,
                    }}
                  >
                    +
                  </span>
                  Add another {g.name} account
                </button>
              </div>
            </div>
          ))}

          <button className="brokerage-group-add" onClick={() => onAddAccount?.()}>
            <div className="brokerage-add-glyph">+</div>
            <div>
              <div className="brokerage-add-label">Add a new brokerage</div>
              <div className="brokerage-add-sub">Drop in a CSV from anywhere</div>
            </div>
          </button>
        </div>
      )}

      {hasAccounts && contributionPanels.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${contributionPanels.length}, 1fr)`,
            gap: 14,
            marginTop: 28,
          }}
        >
          {contributionPanels.map(c => (
            <div
              className="card"
              key={c.name}
              style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}
            >
              <div className="card-title">
                {c.name} · {c.year}
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="num" style={{ fontSize: 22, color: 'var(--ink)' }}>
                  ${c.used.toLocaleString()}
                </span>
                <span className="muted num" style={{ fontSize: 12 }}>
                  of ${c.limit.toLocaleString()}
                </span>
              </div>
              <div
                style={{
                  height: 5,
                  background: 'var(--paper-3)',
                  borderRadius: 3,
                  marginTop: 12,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: c.limit > 0 ? `${Math.min(100, (c.used / c.limit) * 100)}%` : '0%',
                    background: 'var(--accent)',
                    borderRadius: 3,
                  }}
                />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8, fontFamily: 'var(--font-mono)' }}>
                ${(c.limit - c.used).toLocaleString()} of room left
              </div>
            </div>
          ))}
        </div>
      )}

      {hasAccounts && contributionPanels.length > 0 && (
        <p className="disclaimer">
          Contribution limits reflect IRS values for tax year {tax.year}. Surfaced for awareness, not as a
          nag.
        </p>
      )}
    </div>
  );
}
