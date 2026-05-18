// Demo transaction generator + shared types.
// Real imports land in the same shape via lib/importers/*.

import type { MatmonData } from '../data';

export type DemoTx = {
  id: number;
  date: Date;
  account: string;
  accountId: string;
  symbol: string;
  action: 'buy' | 'sell' | 'div';
  qty: number;
  price: number;
  fees: number;
  amount?: number;
  notes: string;
};

export function generateTransactions(data: MatmonData): DemoTx[] {
  const txs: DemoTx[] = [];
  const accountsByBucket = data.accounts.reduce<Record<string, (typeof data.accounts)[number]>>((acc, a) => {
    acc[a.id] = a;
    return acc;
  }, {});
  const rng = (n: number) => (Math.floor(((Math.sin(n * 12.9898) * 43758.5453) % 1) * 100) / 100);
  let txnId = 1;

  data.holdings.forEach((h, hi) => {
    const acct = accountsByBucket[h.account];
    const buys = Math.min(12, Math.max(2, Math.round(h.qty / 80) + 2));
    for (let i = 0; i < buys; i++) {
      const monthsAgo = (buys - i) * 5 + i * 2;
      const d = new Date(2026, 4 - monthsAgo, 12);
      const qty = Math.round((h.qty / buys) * (0.7 + Math.abs(rng(hi + i)) * 0.8) * 100) / 100;
      const price = +(h.basis * (0.85 + Math.abs(rng(hi + i + 11)) * 0.4)).toFixed(2);
      if (d > new Date(2018, 0, 1)) {
        txs.push({
          id: txnId++,
          date: d,
          account: acct.name,
          accountId: acct.id,
          symbol: h.sym,
          action: 'buy',
          qty,
          price,
          fees: 0,
          notes: '',
        });
      }
    }
    if (['VTI', 'VXUS', 'VOO', 'BND', 'AAPL', 'MSFT', 'VYM', 'JEPI'].includes(h.sym)) {
      for (let q = 0; q < 8; q++) {
        const monthsAgo = q * 3 + 1;
        const d = new Date(2026, 4 - monthsAgo, 15);
        if (d > new Date(2019, 0, 1)) {
          txs.push({
            id: txnId++,
            date: d,
            account: acct.name,
            accountId: acct.id,
            symbol: h.sym,
            action: 'div',
            qty: 0,
            price: 0,
            fees: 0,
            amount: +(h.qty * (h.sym === 'JEPI' ? 0.62 : 0.18) * (0.6 + Math.abs(rng(hi * q + 7)) * 0.6)).toFixed(2),
            notes: 'Quarterly dividend',
          });
        }
      }
    }
  });

  txs.push({
    id: txnId++,
    date: new Date(2026, 3, 29),
    account: 'Schwab HSA',
    accountId: 'sch-hsa',
    symbol: 'JEPI',
    action: 'sell',
    qty: 30,
    price: 61.84,
    fees: 0,
    notes: 'Rebalance',
  });

  const extraSells = [
    { d: new Date(2025, 9, 14),  sym: 'VXUS',  acct: 'fid-tax',  qty: 80,  price: 70.20,  notes: 'Tax-loss harvest' },
    { d: new Date(2025, 5, 22),  sym: 'BND',   acct: 'jpm-401k', qty: 120, price: 71.40,  notes: 'Trim bonds' },
    { d: new Date(2024, 11, 9),  sym: 'AAPL',  acct: 'fid-tax',  qty: 25,  price: 215.40, notes: 'Trim overweight' },
    { d: new Date(2024, 7, 2),   sym: 'GOOGL', acct: 'fid-ira',  qty: 18,  price: 178.20, notes: 'Rebalance' },
    { d: new Date(2023, 2, 14),  sym: 'JEPI',  acct: 'sch-hsa',  qty: 22,  price: 54.30,  notes: '' },
    { d: new Date(2022, 5, 21),  sym: 'BND',   acct: 'jpm-401k', qty: 60,  price: 73.80,  notes: '' },
  ];
  extraSells.forEach(s => {
    const acct = accountsByBucket[s.acct];
    if (!acct) return;
    txs.push({
      id: txnId++,
      date: s.d,
      account: acct.name,
      accountId: acct.id,
      symbol: s.sym,
      action: 'sell',
      qty: s.qty,
      price: s.price,
      fees: 0,
      notes: s.notes,
    });
  });

  return txs.sort((a, b) => +b.date - +a.date);
}
