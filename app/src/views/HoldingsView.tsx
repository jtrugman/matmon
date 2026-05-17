import { useMemo, useState } from 'react';
import { PageHead } from '../components/PageHead';
import { Sparkline } from '../components/charts/Sparkline';
import { fmtMoney, fmtPct } from '../lib/format';
import type { Holding, MatmonData } from '../data';

type Props = {
  data: MatmonData;
  onSelect?: (sym: string) => void;
};

export function HoldingsView({ data, onSelect }: Props) {
  const [sortKey, setSortKey] = useState<keyof Holding>('value');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    const out = [...data.holdings].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const r = typeof av === 'string' ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? r : -r;
    });
    return out;
  }, [data, sortKey, sortDir]);

  function sortBy(k: keyof Holding) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  }
  const arrow = (k: keyof Holding) => (sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : '');

  return (
    <div>
      <PageHead
        title="Holdings"
        meta={
          <div>
            <div>
              {data.holdings.length} positions · {fmtMoney(data.totalValue)}
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
                Symbol {arrow('sym')}
              </th>
              <th onClick={() => sortBy('sector')} style={{ cursor: 'pointer' }}>
                Sector
              </th>
              <th className="r" onClick={() => sortBy('qty')} style={{ cursor: 'pointer' }}>
                Qty {arrow('qty')}
              </th>
              <th className="r" onClick={() => sortBy('price')} style={{ cursor: 'pointer' }}>
                Price {arrow('price')}
              </th>
              <th className="r" onClick={() => sortBy('cost')} style={{ cursor: 'pointer' }}>
                Cost basis {arrow('cost')}
              </th>
              <th className="r" onClick={() => sortBy('value')} style={{ cursor: 'pointer' }}>
                Value {arrow('value')}
              </th>
              <th className="r" onClick={() => sortBy('gain')} style={{ cursor: 'pointer' }}>
                Gain {arrow('gain')}
              </th>
              <th className="r" onClick={() => sortBy('share')} style={{ cursor: 'pointer' }}>
                %
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
