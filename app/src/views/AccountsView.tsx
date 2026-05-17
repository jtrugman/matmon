import { PageHead } from '../components/PageHead';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { fmtMoney } from '../lib/format';
import { getTaxConstants } from '../lib/taxConstants';
import type { MatmonData, Account } from '../data';

type Props = {
  data: MatmonData;
  onAddAccount?: (brokerage?: string) => void;
};

export function AccountsView({ data, onAddAccount }: Props) {
  const tax = getTaxConstants();
  const contributionPanels = [
    {
      name: '401(k)',
      label: 'JP Morgan 401(k)',
      used: 18400,
      limit: tax.contributionLimits.traditional_401k,
      year: tax.year,
    },
    {
      name: 'Roth IRA',
      label: 'Vanguard Roth IRA',
      used: 5200,
      limit: tax.contributionLimits.roth_ira,
      year: tax.year,
    },
    {
      name: 'HSA',
      label: 'Schwab HSA (family)',
      used: 3200,
      limit: tax.contributionLimits.hsa_family,
      year: tax.year,
    },
  ];
  const groups = data.accounts.reduce<
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
              {sorted.length} brokerages · {data.accounts.length} accounts
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
                return (
                  <div className="brokerage-account-row" key={a.id}>
                    <div className="bar-type-pip" style={{ background: t.color }} />
                    <div>
                      <div className="bar-name">{a.name}</div>
                      <div className="bar-meta">
                        {t.label} · {a.id}
                      </div>
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
                    <button className="bar-open">Open →</button>
                  </div>
                );
              })}
              <button className="brokerage-account-add" onClick={() => onAddAccount?.(g.name)}>
                <span
                  style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--ink-3)', lineHeight: 1 }}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 28 }}>
        {contributionPanels.map(c => (
          <div className="card" key={c.name} style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}>
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
                  width: `${(c.used / c.limit) * 100}%`,
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

      <p className="disclaimer">
        Contribution limits reflect IRS values for tax year {tax.year}. Surfaced for awareness, not as a nag.
      </p>
    </div>
  );
}
