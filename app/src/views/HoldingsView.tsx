import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { Sparkline } from '../components/charts/Sparkline';
import { TickerLogo } from '../components/TickerLogo';
import { EmptyState } from '../components/EmptyState';
import { fmtMoney, fmtPct } from '../lib/format';
import { aggregateHoldingsBySymbol } from '../lib/portfolio';
import { insertTransactions } from '../lib/db/repos';
import type { Holding, MatmonData } from '../data';

type Props = {
  data: MatmonData;
  onSelect?: (sym: string) => void;
  /** If set, only show holdings belonging to this account id. */
  filterAccountId?: string;
  /** Click handler for the "← Accounts" back link. Only rendered when set. */
  onBack?: () => void;
  /** When the unfiltered view is empty, the CTA routes to Add Account. */
  onAddAccount?: (brokerage?: string) => void;
  /**
   * Refresh the portfolio after a successful manual transaction insert from
   * the in-page modal. Optional: the unfiltered Holdings view doesn't expose
   * the "Add transaction" affordance, so this is only required by the
   * account-detail path (filterAccountId set).
   */
  onReloadPortfolio?: () => void | Promise<void>;
};

export function HoldingsView({
  data,
  onSelect,
  filterAccountId,
  onBack,
  onAddAccount,
  onReloadPortfolio,
}: Props) {
  const [sortKey, setSortKey] = useState<keyof Holding>('value');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // "Add transaction" modal state, only used when the view is account-scoped.
  const [showAddTx, setShowAddTx] = useState(false);

  const filteredAccount = filterAccountId ? data.accounts.find(a => a.id === filterAccountId) || null : null;

  // In account-detail mode we keep the unaggregated (one-row-per-symbol-in-this-
  // account) shape. In the unfiltered Holdings view we collapse rows that share
  // a symbol across accounts so the user sees "VITAX × 1" instead of "VITAX × 5".
  const scopedHoldings = useMemo(() => {
    if (filterAccountId) return data.holdings.filter(h => h.account === filterAccountId);
    return aggregateHoldingsBySymbol(data.holdings);
  }, [data.holdings, filterAccountId]);

  const scopedValue = useMemo(() => scopedHoldings.reduce((s, h) => s + h.value, 0), [scopedHoldings]);

  const sorted = useMemo(() => {
    const out = [...scopedHoldings].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const r =
        typeof av === 'string' ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? r : -r;
    });
    return out;
  }, [scopedHoldings, sortKey, sortDir]);

  function sortBy(k: keyof Holding) {
    if (sortKey === k) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir('desc');
    }
  }
  const arrow = (k: keyof Holding) => (sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  const isFiltered = Boolean(filterAccountId);
  const titleText = filteredAccount ? filteredAccount.name : 'Holdings';
  const eyebrow = filteredAccount ? `${filteredAccount.brokerage} · account holdings` : null;

  return (
    <div>
      {onBack && (
        <button className="back-btn" onClick={onBack}>
          ← Accounts
        </button>
      )}
      <PageHead
        title={titleText}
        meta={
          <div>
            {eyebrow && <div style={{ color: 'var(--ink-4)', marginBottom: 2 }}>{eyebrow}</div>}
            <div>
              {scopedHoldings.length} positions · {fmtMoney(isFiltered ? scopedValue : data.totalValue)}
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Average-cost basis</div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            {/*
              Header actions. We only render these in the account-detail mode
              (filterAccountId set) because the unfiltered Holdings page has
              no implicit target account to dispatch them against. In the
              filtered view:
                - "Add transaction" pops a tiny inline form (buy/sell/div)
                  that calls insertTransactions(filterAccountId, ...) and then
                  reloads the portfolio.
                - "Import CSV" routes to Add Account with the brokerage hint
                  prefilled so the user can drop a fresh CSV onto this account.
                  The Add Account flow's upsertAccountByFingerprint will
                  collapse the import onto this same row (last4 match) so the
                  new transactions land here rather than a new account.
            */}
            {isFiltered && filteredAccount ? (
              <>
                <button
                  className="btn"
                  data-testid="account-add-transaction"
                  onClick={() => setShowAddTx(true)}
                  aria-label="Add a manual transaction to this account"
                >
                  Add transaction
                </button>
                <button
                  className="btn btn-primary"
                  data-testid="account-import-csv"
                  onClick={() => onAddAccount?.(filteredAccount.brokerage)}
                  aria-label={`Import a CSV into ${filteredAccount.name}`}
                >
                  Import CSV
                </button>
              </>
            ) : null}
          </div>
        }
      />

      {scopedHoldings.length === 0 ? (
        isFiltered ? (
          <EmptyState
            title="Looks like this account has no positions yet, just cash."
            body="As you import more history or new trades come in, they'll show up here."
          />
        ) : (
          <EmptyState
            title="No holdings yet."
            body="Once you import a brokerage CSV, every position lives here, sortable."
            onCta={onAddAccount ? () => onAddAccount() : undefined}
          />
        )
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th onClick={() => sortBy('sym')} style={{ cursor: 'pointer' }}>
                  Symbol{arrow('sym')}
                </th>
                <th onClick={() => sortBy('sector')} style={{ cursor: 'pointer' }}>
                  Sector{arrow('sector')}
                </th>
                <th className="r" onClick={() => sortBy('qty')} style={{ cursor: 'pointer' }}>
                  Qty{arrow('qty')}
                </th>
                <th className="r" onClick={() => sortBy('price')} style={{ cursor: 'pointer' }}>
                  Price{arrow('price')}
                </th>
                <th className="r" onClick={() => sortBy('cost')} style={{ cursor: 'pointer' }}>
                  Cost basis{arrow('cost')}
                </th>
                <th className="r" onClick={() => sortBy('value')} style={{ cursor: 'pointer' }}>
                  Value{arrow('value')}
                </th>
                <th className="r" onClick={() => sortBy('gain')} style={{ cursor: 'pointer' }}>
                  Gain{arrow('gain')}
                </th>
                <th className="r" onClick={() => sortBy('share')} style={{ cursor: 'pointer' }}>
                  %{arrow('share')}
                </th>
                <th className="c">30D</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(h => (
                <tr
                  key={h.sym}
                  onClick={() => onSelect && onSelect(h.sym)}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <TickerLogo ticker={h.sym} size={24} />
                      <div style={{ minWidth: 0 }}>
                        <div className="sym">{h.sym}</div>
                        <div className="name">{h.name}</div>
                        {h.heldInAccounts && h.heldInAccounts >= 2 ? (
                          <div
                            className="muted"
                            style={{ fontSize: 11, fontFamily: 'var(--font-mono)', marginTop: 2 }}
                          >
                            Held in {h.heldInAccounts} accounts
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                    {h.sector || (
                      <span className="muted" style={{ fontFamily: 'var(--font-mono)' }}>
                        --
                      </span>
                    )}
                  </td>
                  <td className="r num">{h.qty.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="r num">{fmtMoney(h.price, { cents: true })}</td>
                  <td className="r num muted">{fmtMoney(h.cost)}</td>
                  <td className="r num" style={{ fontWeight: 500 }}>
                    {fmtMoney(h.value)}
                  </td>
                  <td className={`r num ${h.gain >= 0 ? 'up' : 'down'}`}>
                    {h.gain >= 0 ? '+' : ''}
                    {fmtMoney(h.gain)}
                    <div style={{ fontSize: 11, opacity: 0.8 }}>{fmtPct(h.gainPct)}</div>
                  </td>
                  <td className="r num muted">{(h.share * 100).toFixed(1)}%</td>
                  <td className="c">
                    {h.spark && h.spark.length > 0 ? (
                      <Sparkline
                        points={h.spark}
                        color={h.gain >= 0 ? 'var(--gain)' : 'var(--loss)'}
                        fill={false}
                        width={80}
                        height={24}
                      />
                    ) : (
                      <span className="muted" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                        --
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAddTx && filteredAccount ? (
        <AddTransactionModal
          accountId={filteredAccount.id}
          accountName={filteredAccount.name}
          onClose={() => setShowAddTx(false)}
          onSaved={async () => {
            setShowAddTx(false);
            if (onReloadPortfolio) await onReloadPortfolio();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline "Add transaction" modal used in account-detail mode. Single-row
 * manual entry: date, action (buy/sell/dividend), symbol, qty, price, notes.
 * On submit we materialize a ParsedTransaction-shape row and call
 * insertTransactions on the account we're filtering by, then ask the parent
 * to reload the portfolio.
 *
 * Why a custom modal here instead of routing to a full form view: a single
 * manual entry is a 1-page-of-React form and shipping it inline keeps the
 * blast radius small. If/when we add the full editing flow (edit existing
 * rows, recurring rules, lot-aware sells) it will probably want a dedicated
 * view; for now this fixes the "buttons don't work" bug Justin reported.
 */
function AddTransactionModal({
  accountId,
  accountName,
  onClose,
  onSaved,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [action, setAction] = useState<'buy' | 'sell' | 'dividend'>('buy');
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedSym = symbol.trim().toUpperCase();
    const qtyNum = Number(qty);
    const priceNum = Number(price);
    if (!trimmedSym && action !== 'dividend') {
      setError('Symbol is required for buys and sells.');
      return;
    }
    if (action !== 'dividend' && (!Number.isFinite(qtyNum) || qtyNum <= 0)) {
      setError('Quantity must be a positive number.');
      return;
    }
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      setError('Price must be zero or a positive number.');
      return;
    }
    // Compute amount: buys are negative (money out), sells / dividends positive.
    const grossAmount = qtyNum * priceNum;
    const amount =
      action === 'buy'
        ? -grossAmount
        : action === 'sell'
          ? grossAmount
          : priceNum; // dividend: total dividend received
    setSaving(true);
    try {
      await insertTransactions(accountId, [
        {
          date: new Date(`${date}T12:00:00Z`),
          symbol: trimmedSym || null,
          action,
          quantity: action === 'dividend' ? 0 : qtyNum,
          price: priceNum,
          fees: 0,
          amount,
          currency: 'USD',
          notes: notes || null,
          // rawHash needs to be unique so the dedupe doesn't drop the row.
          // We include enough fields to make a re-entry of the same numbers
          // collide intentionally (which is the right semantics: the user
          // probably hit submit twice).
          rawHash: `manual:${accountId}:${date}:${action}:${trimmedSym}:${qtyNum}:${priceNum}:${notes}`,
        },
      ]);
      await onSaved();
    } catch (err) {
      setError(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="add-transaction-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-tx-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: 24,
          width: 'min(440px, 90vw)',
          boxShadow: '0 14px 60px rgba(0,0,0,0.18)',
        }}
      >
        <div id="add-tx-title" style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 4 }}>
          Add transaction
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
          {accountName}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Date</span>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              required
              style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Action</span>
            <select
              value={action}
              onChange={e => setAction(e.target.value as 'buy' | 'sell' | 'dividend')}
              style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
              <option value="dividend">Dividend</option>
            </select>
          </label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Symbol</span>
          <input
            type="text"
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            placeholder="e.g. AAPL"
            autoFocus
            style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {action === 'dividend' ? 'Shares (optional)' : 'Quantity'}
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={qty}
              onChange={e => setQty(e.target.value)}
              required={action !== 'dividend'}
              style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {action === 'dividend' ? 'Amount received' : 'Price per share'}
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={price}
              onChange={e => setPrice(e.target.value)}
              required
              style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
            />
          </label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>Notes (optional)</span>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}
          />
        </label>
        {error ? (
          <div role="alert" style={{ color: 'var(--loss)', fontSize: 12, marginBottom: 10 }}>
            {error}
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save transaction'}
          </button>
        </div>
      </form>
    </div>
  );
}
