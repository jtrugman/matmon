#!/usr/bin/env python3
"""
Ground-truth math computation from raw brokerage CSVs.

For each file in example_csv/, compute the expected portfolio numbers from
the raw rows (volume, cost basis, market value, gain/loss) using the same
accounting rules the matmon importer + buildPortfolio pipeline is supposed
to apply. The output JSON is then diffed against the actual app output to
expose any importer/pipeline bug.

Conventions:
  - Buy: qty += quantity; cost += quantity * price + fees.
  - Sell: avg = cost/qty; qty -= quantity; cost -= avg * quantity.
  - DRIP / Reinvest Shares: treated as a buy (qty up, cost up by qty*price).
  - Plain dividend / interest: qty unchanged, cost unchanged.
  - Fidelity DISTRIBUTION with Type=Shares: a share-distribution; qty up,
    cost up by the Amount column (cash equivalent of the distribution).
    Per-share implied price = Amount / Quantity.
  - JPM holdings (positions export): each tax-lot row is a transfer_in with
    price=Unit Cost. Current market value uses the file's Price column, NOT
    Unit Cost. value = qty * Price; cost = qty * Unit Cost.
  - Symbol with empty/whitespace value (e.g. literal " " in Fidelity cash
    rows) becomes null and does NOT appear in the distinct-symbol set.
  - parseNumber: accepts "$1,234.56", "(120.00)" (accounting negative), "",
    "-", and em-dash placeholders; returns 0 for unparseable.
"""

import csv
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime
from pathlib import Path


HERE = Path(__file__).resolve().parent
EX = HERE.parent / "example_csv"


def parse_number(s):
    if s is None:
        return 0.0
    s = str(s).strip()
    if s == "" or s == "-" or s == "--":
        return 0.0
    neg = "(" in s and ")" in s
    cleaned = re.sub(r"[\$,\s\(\)]", "", s)
    if cleaned == "" or cleaned == "-":
        return 0.0
    try:
        n = float(cleaned)
    except ValueError:
        return 0.0
    return -abs(n) if neg else n


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    # Try ISO first.
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # US: MM/DD/YYYY or MM-DD-YYYY.
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", s)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000 if y < 50 else 1900
        return datetime(y, mo, d)
    return None


def map_action(raw):
    """Mirror src/lib/importers/util.ts ACTION_MAP order."""
    if not raw:
        return None
    r = raw.lower()
    if re.search(r"electronic funds transfer received", r):
        return "cash_in"
    if re.search(r"electronic funds transfer paid", r):
        return "cash_out"
    if re.search(r"reinvest|div.*reinvested|drip", r):
        return "div_reinvest"
    if re.search(r"distribution", r):
        return "dividend"
    if re.search(r"dividend|income.*reinvested.*dividend|dividend received", r):
        return "dividend"
    if re.search(r"interest", r):
        return "interest"
    if re.search(r"you bought|buy|purchase|bought|sweep in", r):
        return "buy"
    if re.search(r"you sold|sell|sold|redemption", r):
        return "sell"
    if re.search(r"split", r):
        return "split"
    if re.search(r"spin.?off", r):
        return "spinoff"
    if re.search(r"transfer in|received transfer", r):
        return "transfer_in"
    if re.search(r"transfer out|delivered", r):
        return "transfer_out"
    if re.search(r"deposit|cash in|contribution", r):
        return "cash_in"
    if re.search(r"withdrawal|cash out", r):
        return "cash_out"
    if re.search(r"fee|commission", r):
        return "fee"
    return None


def normalize_symbol(raw):
    if not raw:
        return None
    s = raw.strip()
    if s == "" or s == "-":
        return None
    return s


def round_money(v):
    return round(v, 4)


def replay_transactions(txs):
    """
    Replay a stream of normalized transactions chronologically (oldest first)
    and produce per-(account, symbol) holdings with qty + cost basis.

    Each input row is a dict:
      account_id, date(datetime), symbol(str|None), action(str),
      quantity, price, fees, amount, type(optional, for Fidelity DISTRIBUTION)
    """
    txs_sorted = sorted(txs, key=lambda t: t["date"])
    holdings = {}
    last_price = {}  # symbol -> last non-zero seen price (chronological)
    for t in txs_sorted:
        sym = t["symbol"]
        if not sym:
            continue
        key = (t["account_id"], sym)
        h = holdings.get(key) or {"account_id": t["account_id"], "sym": sym, "qty": 0.0, "cost": 0.0}
        act = t["action"]
        qty = t["quantity"]
        price = t["price"]
        fees = t["fees"]
        if act in ("buy", "transfer_in", "div_reinvest"):
            h["qty"] += qty
            h["cost"] += qty * price + fees
        elif act in ("sell", "transfer_out"):
            avg = (h["cost"] / h["qty"]) if h["qty"] > 0 else 0.0
            h["qty"] -= qty
            h["cost"] -= avg * qty
            if h["qty"] <= 0:
                h["qty"] = 0.0
                h["cost"] = 0.0
        # dividends/interest/cash_in/etc. do NOT touch qty/cost
        holdings[key] = h
        if price and price > 0:
            last_price[sym] = price
    return holdings, last_price


# ──────────────────────────────────────────────────────────────────────
# Per-file parsers
# ──────────────────────────────────────────────────────────────────────


def read_csv_rows(path, strip_lead_blank=2):
    """
    Read a Fidelity-style CSV that has leading blank lines + trailing
    disclaimer prose. Returns (headers, rows) using DictReader.
    """
    with open(path, newline="", encoding="utf-8-sig") as f:
        lines = f.readlines()
    # Drop leading whitespace-only lines.
    start = 0
    while start < len(lines) and lines[start].strip() == "":
        start += 1
    # Drop trailing whitespace-only and disclaimer lines.
    disclaimer = re.compile(
        r'^"?(the data and information|brokerage services are provided|fidelity insurance agency|financial services llc|informational purposes only|recommendation for any security|exported and is subject to change|purposes\. for more information|date downloaded\b)',
        re.IGNORECASE,
    )
    end = len(lines)
    while end > start and (lines[end - 1].strip() == "" or disclaimer.match(lines[end - 1].strip())):
        end -= 1
    cleaned = "".join(lines[start:end])
    rdr = csv.DictReader(cleaned.splitlines())
    return rdr.fieldnames or [], list(rdr)


def parse_fidelity(path, account_col=None):
    headers, rows = read_csv_rows(path)
    out_txs = []
    unmapped = set()
    rows_total = len(rows)
    actions_unknown = 0
    for row in rows:
        action_str = (row.get("Action") or row.get("Type") or "").strip()
        action = map_action(action_str)
        if not action:
            if action_str:
                unmapped.add(action_str)
                actions_unknown += 1
            continue
        date_str = row.get("Run Date") or row.get("Trade Date") or row.get("Settlement Date") or row.get("Date")
        date = parse_date(date_str)
        if not date:
            continue
        symbol = normalize_symbol(row.get("Symbol"))
        type_col = (row.get("Type") or "").strip().lower()
        qty = abs(parse_number(row.get("Quantity")))
        price = parse_number(row.get("Price ($)") or row.get("Price"))
        fees = abs(parse_number(row.get("Commission ($)") or row.get("Fees ($)") or row.get("Fees")))
        amount = parse_number(row.get("Amount ($)") or row.get("Amount") or "0")
        # account
        account_name = (row.get("Account") or row.get("Account Name") or "").strip()
        account_number = (row.get("Account Number") or "").strip()
        if account_name or account_number:
            account_id = f"{account_name}::{account_number}"
        else:
            account_id = "single"
        # Fidelity DISTRIBUTION with Type=Shares: share distribution, treat as div_reinvest
        if action == "dividend" and "distribution" in action_str.lower() and type_col == "shares" and qty > 0 and amount != 0:
            action = "div_reinvest"
            price = abs(amount) / qty if qty > 0 else 0.0
        out_txs.append(
            {
                "account_id": account_id,
                "date": date,
                "symbol": symbol,
                "action": action,
                "quantity": qty,
                "price": price,
                "fees": fees,
                "amount": amount,
                "type": type_col,
                "action_str": action_str,
            }
        )
    return out_txs, sorted(unmapped), rows_total, actions_unknown


def parse_schwab_transactions(path):
    headers, rows = read_csv_rows(path)
    out_txs = []
    unmapped = set()
    rows_total = len(rows)
    actions_unknown = 0
    for row in rows:
        action_str = (row.get("Action") or "").strip()
        action = map_action(action_str)
        if not action:
            if action_str:
                unmapped.add(action_str)
                actions_unknown += 1
            continue
        date_field = (row.get("Date") or "").split(" as of ")[0]
        date = parse_date(date_field)
        if not date:
            continue
        symbol = normalize_symbol(row.get("Symbol"))
        qty = abs(parse_number(row.get("Quantity")))
        price = parse_number(row.get("Price"))
        fees = abs(parse_number(row.get("Fees & Comm") or row.get("Fees & Commissions") or row.get("Commission") or row.get("Fees and Comm")))
        amount = parse_number(row.get("Amount"))
        out_txs.append(
            {
                "account_id": "single",
                "date": date,
                "symbol": symbol,
                "action": action,
                "quantity": qty,
                "price": price,
                "fees": fees,
                "amount": amount,
                "type": "",
                "action_str": action_str,
            }
        )
    return out_txs, sorted(unmapped), rows_total, actions_unknown


def parse_jpm_holdings(path):
    headers, rows = read_csv_rows(path)
    out_lots = []
    # Track market price per symbol (newest pricing date wins).
    market_prices = {}
    for row in rows:
        account_name = (row.get("Account name") or "").strip()
        if not account_name or account_name.upper() == "FOOTNOTES":
            continue
        account_number = (row.get("Account number") or "").strip()
        ticker = (row.get("Ticker") or "").strip().upper()
        if not ticker:
            continue
        qty = abs(parse_number(row.get("Quantity")))
        unit_cost = parse_number(row.get("Unit Cost"))
        if qty <= 0:
            continue
        acq_str = (row.get("Acquisition Date") or "").strip()
        date = parse_date(acq_str) if acq_str else datetime.utcnow()
        market_price = parse_number(row.get("Price"))
        pricing_date_str = (row.get("Pricing Date") or "").strip()
        pricing_date = parse_date(pricing_date_str) if pricing_date_str else datetime.utcnow()
        if market_price > 0:
            cur = market_prices.get(ticker)
            if not cur or pricing_date >= cur["asOf"]:
                market_prices[ticker] = {"price": market_price, "asOf": pricing_date}
        out_lots.append(
            {
                "account_id": f"{account_name}::{account_number}",
                "date": date,
                "symbol": ticker,
                "action": "transfer_in",
                "quantity": qty,
                "price": unit_cost,
                "fees": 0.0,
                "amount": -(qty * unit_cost),
                "type": "",
                "action_str": "lot import",
            }
        )
    return out_lots, market_prices


# ──────────────────────────────────────────────────────────────────────
# Per-file ground truth assembly
# ──────────────────────────────────────────────────────────────────────


def summarize(txs, last_price, market_price_override=None):
    holdings, lp = replay_transactions(txs)
    if market_price_override:
        # Use the per-symbol override (e.g. JPM holdings' Price column).
        price_lookup = dict(market_price_override)
    else:
        price_lookup = lp

    accounts = OrderedDict()
    distinct_symbols = sorted({h["sym"] for h in holdings.values() if h["qty"] > 0})
    per_symbol = OrderedDict()
    total_value = 0.0
    total_cost = 0.0

    # Aggregate per-symbol across all accounts for ease of reporting.
    by_sym = defaultdict(lambda: {"qty": 0.0, "cost": 0.0, "value": 0.0, "accounts": []})

    for (acct, sym), h in sorted(holdings.items()):
        if h["qty"] <= 0:
            continue
        # Price resolution: market price override (JPM) > last non-zero tx price.
        # If the override exists but doesn't have THIS symbol, fall back to last_price.
        if market_price_override and sym in market_price_override:
            price = market_price_override[sym]["price"] if isinstance(market_price_override[sym], dict) else market_price_override[sym]
        else:
            price = last_price.get(sym, 0.0)
        value = h["qty"] * price
        accounts.setdefault(acct, {"value": 0.0, "cost": 0.0, "qty_symbols": 0})
        accounts[acct]["value"] += value
        accounts[acct]["cost"] += h["cost"]
        accounts[acct]["qty_symbols"] += 1
        total_value += value
        total_cost += h["cost"]
        by_sym[sym]["qty"] += h["qty"]
        by_sym[sym]["cost"] += h["cost"]
        by_sym[sym]["value"] += value
        by_sym[sym]["accounts"].append(
            {"account_id": acct, "qty": round_money(h["qty"]), "cost": round_money(h["cost"]), "price": round_money(price), "value": round_money(value)}
        )

    for sym in sorted(by_sym.keys()):
        agg = by_sym[sym]
        per_symbol[sym] = {
            "qty": round_money(agg["qty"]),
            "cost": round_money(agg["cost"]),
            "value": round_money(agg["value"]),
            "gain": round_money(agg["value"] - agg["cost"]),
            "accounts": agg["accounts"],
        }
    return {
        "accounts": {a: {"value": round_money(v["value"]), "cost": round_money(v["cost"]), "qty_symbols": v["qty_symbols"]} for a, v in accounts.items()},
        "distinct_symbols": distinct_symbols,
        "per_symbol": per_symbol,
        "total_value": round_money(total_value),
        "total_cost": round_money(total_cost),
        "total_gain": round_money(total_value - total_cost),
        "n_accounts": len(accounts),
    }


def file_ground_truth(path, kind):
    if kind == "fidelity":
        txs, unmapped, rows_total, actions_unknown = parse_fidelity(path)
        _, last_price = replay_transactions(txs)
        summ = summarize(txs, last_price)
    elif kind == "schwab-tx":
        txs, unmapped, rows_total, actions_unknown = parse_schwab_transactions(path)
        _, last_price = replay_transactions(txs)
        summ = summarize(txs, last_price)
    elif kind == "jpm-holdings":
        txs, market_prices = parse_jpm_holdings(path)
        unmapped = []
        rows_total = len(txs)
        actions_unknown = 0
        _, last_price = replay_transactions(txs)
        summ = summarize(txs, last_price, market_price_override=market_prices)
    elif kind == "schwab-balance":
        return {"reject": True, "path": str(path), "reason": "balance/positions export (not transaction history)"}
    else:
        raise ValueError(f"unknown kind {kind}")

    dates = [t["date"] for t in txs]
    actions = sorted({t["action_str"] for t in txs})
    return {
        "file": str(path),
        "kind": kind,
        "n_accounts": summ["n_accounts"],
        "transactions_total_in_file": rows_total,
        "transactions_parsed": len(txs),
        "actions_unknown": actions_unknown,
        "unmapped_action_strings": unmapped,
        "date_range": {
            "start": min(dates).date().isoformat() if dates else None,
            "end": max(dates).date().isoformat() if dates else None,
        },
        "action_strings_present": actions,
        "distinct_symbols": summ["distinct_symbols"],
        "per_symbol": summ["per_symbol"],
        "per_account": summ["accounts"],
        "total_value": summ["total_value"],
        "total_cost": summ["total_cost"],
        "total_gain": summ["total_gain"],
    }


def main():
    files = [
        ("single_account_fidelity.csv", "fidelity"),
        ("multiple_accounts_fidelity.csv", "fidelity"),
        ("single_scwab_transactions.csv", "schwab-tx"),
        ("schwab_single_account.CSV", "schwab-balance"),
        ("jpm_multiple_accounts.csv", "jpm-holdings"),
    ]
    out = OrderedDict()
    for name, kind in files:
        path = EX / name
        if not path.exists():
            print(f"[warn] missing {path}", file=sys.stderr)
            continue
        out[name] = file_ground_truth(path, kind)
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
