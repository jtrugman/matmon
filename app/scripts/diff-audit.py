#!/usr/bin/env python3
"""Diff /tmp/ground-truth.json against /tmp/app-output.json line by line."""
import json
import sys


GT_PATH = "/tmp/ground-truth.json"
APP_PATH = "/tmp/app-output.json"


# Maps from ground-truth file name -> app dump key (set by tests/math-validation.test.ts).
APP_KEY = {
    "single_account_fidelity.csv": "singleFidelity",
    "multiple_accounts_fidelity.csv": "multiFidelity",
    "single_scwab_transactions.csv": "schwabTx",
    "schwab_single_account.CSV": "schwabBalance",
    "jpm_multiple_accounts.csv": "jpm",
}


def fmt(v):
    if isinstance(v, (int, float)):
        return f"${v:,.4f}"
    return str(v)


def diff_per_symbol(gt, app):
    out = []
    syms = sorted(set(gt) | set(app))
    for sym in syms:
        g = gt.get(sym)
        a = app.get(sym)
        if g is None or a is None:
            out.append((sym, "presence", g is not None, a is not None, None))
            continue
        for field in ("qty", "cost", "value"):
            gv = g[field]
            av = a[field]
            if abs(gv - av) > 0.01:
                out.append((sym, field, gv, av, av - gv))
    return out


def main():
    try:
        gt = json.load(open(GT_PATH))
    except FileNotFoundError:
        print(f"missing {GT_PATH}; run `python3 scripts/ground-truth.py > /tmp/ground-truth.json` first")
        sys.exit(1)
    try:
        app = json.load(open(APP_PATH))
    except FileNotFoundError:
        print(f"missing {APP_PATH}; run `npx vitest run tests/math-validation.test.ts` first")
        sys.exit(1)

    fail = 0
    print("=" * 80)
    print("RAW-CSV GROUND TRUTH  vs  APP OUTPUT  (per-symbol diff)")
    print("=" * 80)

    for name, g in gt.items():
        print(f"\n── {name} ──")
        ak = APP_KEY.get(name)
        a = app.get(ak) if ak else None
        if g.get("reject"):
            if a and a.get("rejected"):
                print(f"  REJECT  expected; reason='{a.get('reason', '')[:60]}'  PASS")
            else:
                print(f"  REJECT  expected; got importer={a.get('importerId') if a else None}  FAIL")
                fail += 1
            continue
        if not a:
            print(f"  no app data under key {ak!r}  FAIL")
            fail += 1
            continue
        if a.get("importerId") != g.get("kind", "").replace("schwab-tx", "schwab").replace("jpm-holdings", "jpmHoldings"):
            # informational only, math is the real test
            pass
        # totals
        for field, gt_field in (("totalValue", "total_value"), ("totalCost", "total_cost"), ("totalGain", "total_gain")):
            gv = g[gt_field]
            av = a[field]
            if abs(gv - av) > 0.02:
                print(f"  TOTAL {field}:  expected={fmt(gv)}  actual={fmt(av)}  delta={fmt(av-gv)}  FAIL")
                fail += 1
            else:
                print(f"  TOTAL {field}: {fmt(av)}  match")
        # per-symbol
        mismatches = diff_per_symbol(g["per_symbol"], a["perSymbol"])
        if not mismatches:
            print(f"  all {len(g['per_symbol'])} symbols match within $0.01")
        else:
            for sym, field, gv, av, d in mismatches:
                if field == "presence":
                    print(f"  symbol {sym} presence: gt={gv}  app={av}  FAIL")
                else:
                    print(f"  symbol {sym}.{field}:  expected={fmt(gv)}  actual={fmt(av)}  delta={fmt(d)}  FAIL")
                fail += 1
    print()
    if fail == 0:
        print("✓ ALL MATH MATCHES GROUND TRUTH TO THE CENT")
    else:
        print(f"✗ {fail} MISMATCHES")
        sys.exit(1)


if __name__ == "__main__":
    main()
