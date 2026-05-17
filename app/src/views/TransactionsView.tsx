import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { fmtMoney } from '../lib/format';
import { generateTransactions } from '../lib/transactions';
import type { MatmonData } from '../data';

export function TransactionsView({ data }: { data: MatmonData }) {
  const allTxs = useMemo(() => generateTransactions(data), [data]);
  const [filterAccount, setFilterAccount] = useState('all');
  const [filterAction, setFilterAction] = useState('all');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState('1Y');

  const filtered = allTxs.filter(t => {
    if (filterAccount !== 'all' && t.accountId !== filterAccount) return false;
    if (filterAction !== 'all' && t.action !== filterAction) return false;
    if (search.trim() && !t.symbol.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    buy: allTxs.filter(t => t.action === 'buy').length,
    sell: allTxs.filter(t => t.action === 'sell').length,
    div: allTxs.filter(t => t.action === 'div').length,
  };

  return (
    <div>
      <PageHead
        title="Transactions"
        meta={
          <div>
            <div>{allTxs.length.toLocaleString()} actions, all-time</div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
              {counts.buy} buys · {counts.sell} sells · {counts.div} dividends
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
          />
        </div>
        <div className="filter-divider" />
        <select
          className="settings-select compact"
          value={filterAccount}
          onChange={e => setFilterAccount(e.target.value)}
        >
          <option value="all">All accounts</option>
          {data.accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="seg">
          {[
            { id: 'all', label: 'All' },
            { id: 'buy', label: 'Buys' },
            { id: 'sell', label: 'Sells' },
            { id: 'div', label: 'Dividends' },
          ].map(o => (
            <button
              key={o.id}
              className={filterAction === o.id ? 'active' : ''}
              onClick={() => setFilterAction(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {['1M', '3M', 'YTD', '1Y', 'ALL'].map(o => (
            <button key={o} className={range === o ? 'active' : ''} onClick={() => setRange(o)}>
              {o}
            </button>
          ))}
        </div>
      </div>

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
            {filtered.slice(0, 50).map(t => {
              const amount =
                t.amount != null ? t.amount : t.action === 'sell' ? +(t.qty * t.price) : -(t.qty * t.price);
              return (
                <tr key={t.id}>
                  <td className="num">
                    {t.date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}
                  </td>
                  <td>
                    <span className={`activity-act ${t.action}`}>
                      {t.action === 'div' ? 'Div' : t.action === 'buy' ? 'Buy' : 'Sell'}
                    </span>
                  </td>
                  <td>
                    <span className="sym">{t.symbol}</span>
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{t.account}</td>
                  <td className="r num">
                    {t.qty > 0 ? t.qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
                  </td>
                  <td className="r num">{t.price > 0 ? fmtMoney(t.price, { cents: true }) : '—'}</td>
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
        className="muted"
        style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5, textAlign: 'right' }}
      >
        Showing {Math.min(50, filtered.length)} of {filtered.length} · sorted newest first
      </div>
    </div>
  );
}
