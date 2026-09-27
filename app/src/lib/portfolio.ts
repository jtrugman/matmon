// Builds the MatmonData shape that views consume by aggregating real DB rows.
// On first run the seed.ts module fills the DB with demo data so the views look
// alive immediately; once the user imports their own CSV the demo seed is left
// alongside (deduped by hash) and they see their real numbers.

import { listAccounts, listTransactions } from './db/repos';
import { getProvider, isOffline } from './quotes';
import type { Quote } from './quotes';
import {
  MATMON_DATA,
  type Account,
  type AccountType,
  type Holding,
  type MatmonData,
  type ActivityItem,
  type Achievement,
} from '../data';

const ACCOUNT_TYPES: AccountType[] = MATMON_DATA.accountTypes;

// In-memory quote cache so repeated rebuilds don't re-hit Yahoo every second.
const quoteCache = new Map<string, Quote>();

async function priceFor(symbol: string): Promise<number | null> {
  if (isOffline()) return quoteCache.get(symbol)?.price ?? null;
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - +cached.fetchedAt < 15 * 60 * 1000) {
    return cached.price;
  }
  return null;
}

export async function refreshQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0 || isOffline()) return [];
  const quotes = await getProvider().fetchQuotes(symbols);
  for (const q of quotes) quoteCache.set(q.symbol, q);
  return quotes;
}

export async function buildPortfolio(): Promise<MatmonData> {
  const accountRows = await listAccounts();
  const txRows = await listTransactions();

  if (accountRows.length === 0) {
    // No data yet — return the static demo so the UI never renders empty.
    return MATMON_DATA;
  }

  // Build holdings from transactions per (account, symbol).
  type HoldKey = string;
  const holdings = new Map<HoldKey, { account: string; sym: string; qty: number; cost: number }>();

  for (const t of txRows) {
    if (!t.symbol) continue;
    const k = `${t.account_id}::${t.symbol}`;
    const h = holdings.get(k) || { account: t.account_id, sym: t.symbol, qty: 0, cost: 0 };
    if (t.action === 'buy' || t.action === 'transfer_in' || t.action === 'div_reinvest') {
      h.qty += t.quantity;
      h.cost += t.quantity * t.price + t.fees;
    } else if (t.action === 'sell' || t.action === 'transfer_out') {
      // Average-cost reduction
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      h.qty -= t.quantity;
      h.cost -= avg * t.quantity;
      if (h.qty <= 0) {
        h.qty = 0;
        h.cost = 0;
      }
    }
    holdings.set(k, h);
  }

  // Fetch quotes for distinct symbols, fall back to most recent price seen in txs.
  const distinct = Array.from(new Set(Array.from(holdings.values()).map(h => h.sym)));
  let totalValue = 0;
  let totalDayChange = 0;
  const holdingObjs: Holding[] = [];

  for (const h of holdings.values()) {
    let price = await priceFor(h.sym);
    if (price == null) {
      // Last seen price in transactions
      const lastTx = txRows
        .filter(t => t.symbol === h.sym && t.price > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      price = lastTx?.price ?? 0;
    }
    const value = h.qty * price;
    const basis = h.qty > 0 ? h.cost / h.qty : 0;
    const gain = value - h.cost;
    holdingObjs.push({
      sym: h.sym,
      name: h.sym,
      qty: h.qty,
      price,
      basis,
      sector: 'Holding',
      account: h.account,
      value,
      cost: h.cost,
      gain,
      gainPct: h.cost > 0 ? gain / h.cost : 0,
      share: 0, // backfilled after totalValue computed
      spark: Array.from({ length: 24 }, (_, i) => 50 + Math.sin(i * 0.7) * 12),
    });
    totalValue += value;
  }

  for (const h of holdingObjs) h.share = totalValue > 0 ? h.value / totalValue : 0;

  // Roll up account values from holdings.
  const accountValueMap = new Map<string, number>();
  for (const h of holdingObjs) {
    accountValueMap.set(h.account, (accountValueMap.get(h.account) || 0) + h.value);
  }

  const accounts: Account[] = accountRows.map(a => ({
    id: a.id,
    name: a.name,
    brokerage: a.brokerage,
    type: a.account_type,
    value: accountValueMap.get(a.id) || 0,
    dayChange: 0,
  }));

  // Recent activity: last 6 transactions
  const recent = txRows.slice(0, 6);
  const accountNameById = new Map(accountRows.map(a => [a.id, a.name]));
  const activity: ActivityItem[] = recent.map(t => {
    const amount = t.amount ?? (t.action === 'sell' ? t.quantity * t.price : -(t.quantity * t.price));
    const action: 'buy' | 'sell' | 'div' =
      t.action === 'dividend' || t.action === 'div_reinvest' ? 'div' : t.action === 'sell' ? 'sell' : 'buy';
    return {
      date: new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }),
      action,
      desc: `${t.symbol ?? '—'} · ${t.notes || (action === 'div' ? 'Dividend received' : `${t.quantity.toFixed(2)} shares @ $${t.price.toFixed(2)}`)}`,
      account: accountNameById.get(t.account_id) || 'Unknown',
      amount: action === 'div' ? Math.abs(amount) : amount,
    };
  });

  const achievements: Achievement[] = MATMON_DATA.achievements;

  return {
    accounts,
    accountTypes: ACCOUNT_TYPES,
    holdings: holdingObjs,
    activity: activity.length ? activity : MATMON_DATA.activity,
    achievements,
    series: MATMON_DATA.series,
    spy: MATMON_DATA.spy,
    totalValue,
    totalDayChange,
  };
}
