import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { Sparkline } from '../components/charts/Sparkline';
import { fmtMoney, fmtPct } from '../lib/format';
import type { Holding, MatmonData } from '../data';

type Props = {
  data: MatmonData;
  onSelect?: (sym: string) => void;
  /** If set, only show holdings belonging to this account id. */
  filterAccountId?: string;
  /** Click handler for the "← Accounts" back link. Only rendered when set. */
  onBack?: () => void;
};

export function HoldingsView({ data, onSelect, filterAccountId, onBack }: Props) {
  const [sortKey, setSortKey] = useState<keyof Holding>('value');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const filteredAccount = filterAccountId
    ? data.accounts.find(a => a.id === filterAccountId) || null
    : null;

  const scopedHoldings = useMemo(
    () => (filterAccountId ? data.holdings.filter(h => h.account === filterAccountId) : data.holdings),
    [data.holdings, filterAccountId],
  );

  const scopedValue = useMemo(
    () => scopedHoldings.reduce((s, h) => s + h.value, 0),
    [scopedHoldings],
  );

  const sorted = useMemo(() => {
    const out = [...scopedHoldings].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const r = typeof av === 'string' ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
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
            {eyebrow && (
              <div style={{ color: 'var(--ink-4)', marginBottom: 2 }}>{eyebrow}</div>
            )}
            <div>
              {scopedHoldings.length} positions ·{' '}
              {fmtMoney(isFiltered ? scopedValue : data.totalValue)}
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Average-cost basis</div>
          </div>
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn">Add transaction</button>
            <button className="btn btn-primary">Import CSV</button>
          </div>
        }
      />

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
                  <div className="sym">{h.sym}</div>
                  <div className="name">{h.name}</div>
                </td>
                <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{h.sector}</td>
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
                  <Sparkline
                    points={h.spark}
                    color={h.gain >= 0 ? 'var(--gain)' : 'var(--loss)'}
                    fill={false}
                    width={80}
                    height={24}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
