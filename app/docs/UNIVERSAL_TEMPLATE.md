# Matmon Universal CSV Template

The universal template is Matmon's fallback for brokerages that don't have a
native importer yet. You download a CSV with the right header row, fill in
your transactions by hand (or pasted from spreadsheets you maintain), and
re-upload. Matmon detects the universal header signature and imports as a
generic brokerage.

If your brokerage IS supported natively (Fidelity, Charles Schwab, JP Morgan,
Human Interest), use that flow instead. The universal template exists for the
"my 401(k) plan doesn't export anything" case.

### Fidelity: multi-account export only

Matmon's Fidelity importer ONLY accepts the multi-account transaction-history
export. Single-account exports omit the Account Number column entirely, which
breaks the dedup fingerprint we use to keep accounts organized across
re-imports. If you upload a single-account export, Matmon rejects it at the
import gate and shows a message telling you how to get the right file:

1. Click your name in the top-right
2. Select Accounts & Trade, then Activity & Orders
3. Choose "All Accounts" from the account dropdown
4. Click Download

The resulting file has `Account` and `Account Number` columns and works on
the first upload, even if you only have one Fidelity account.

## When to use the universal template

- Your 401(k) provider doesn't expose a CSV export (Human Interest, Empower,
  Voya, Principal, etc.).
- You want to track an account from a brokerage Matmon doesn't recognize.
- You have a paper trail of transactions you typed into a spreadsheet and
  want to import them as-is.

## Where to get it

In the onboarding "Bring in your accounts" step, click the muted link
"Don't see your brokerage? Use our universal template instead →" below the
main dropzone. A panel expands with a "Download template" button and a
secondary dropzone for the filled file.

After onboarding, the same link appears on Add Account under the dropzone.

The file Matmon serves is also available at
[`/matmon-template.csv`](../public/matmon-template.csv) inside the running
app's static assets.

## Columns (in order)

| Column         | Required | Notes                                                                                                    |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `Date`         | yes      | ISO `YYYY-MM-DD` (e.g. `2024-01-15`) is the safest. `M/D/YYYY` (US) is also accepted.                    |
| `Action`       | yes      | One of the allowed values below. Unknown actions are skipped with a warning.                             |
| `Symbol`       | no       | Ticker symbol. Blank for cash actions like `contribution`, `withdrawal`, `interest`.                     |
| `Description`  | no       | Free-form. Shown in the activity feed.                                                                   |
| `Quantity`     | no       | Shares for buy / sell / transfer. Leave blank for cash actions and dividend rows.                        |
| `Price`        | no       | Per-share price. Leave blank for cash actions and dividend rows.                                         |
| `Amount`       | yes      | Total cash impact. Positive for inflows (`buy` uses positive for cost, `dividend` positive for received), negative for outflows. See "Signed amounts" below. |
| `Fees`         | no       | Commission or other fees. Always positive.                                                               |
| `Account`      | yes      | Your account name. Matmon groups rows by `(Brokerage, Account)`.                                         |
| `Brokerage`    | yes      | Brokerage name. Use a consistent string per account (e.g. `Human Interest`, `Empower`).                  |
| `Account Type` | no       | One of the allowed values below. Defaults to `unknown` if missing.                                       |
| `Currency`     | no       | Three-letter code. Defaults to `USD`.                                                                    |
| `Notes`        | no       | Free-form. Use this for context the schema doesn't capture (e.g. "Roth contribution").                   |

### Allowed `Action` values

Case-insensitive. Any value not on this list is skipped with a warning so you
can fix the row and re-upload.

| Action          | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `buy`           | Purchased shares. Use positive `Quantity` and `Price`.                             |
| `sell`          | Sold shares.                                                                       |
| `dividend`      | Cash dividend received. Leave `Quantity` and `Price` blank, fill `Amount`.         |
| `interest`      | Interest income. Same shape as dividend.                                           |
| `div_reinvest`  | Dividend reinvested as additional shares. Fill `Quantity`, `Price`, and `Amount`.  |
| `cash_in`       | Generic cash inflow (deposit, ACH from external account).                          |
| `cash_out`      | Generic cash outflow (withdrawal to external account).                             |
| `contribution`  | Friendly alias for `cash_in`. Use for 401(k) and IRA contributions.                |
| `withdrawal`    | Friendly alias for `cash_out`. Use for retirement-account withdrawals.             |
| `transfer_in`   | Securities transferred IN from another account.                                    |
| `transfer_out`  | Securities transferred OUT to another account.                                     |
| `fee`           | Account or trading fee deducted from cash balance.                                 |

### Allowed `Account Type` values

Case-insensitive. Defaults to `unknown` (you can correct it during the
review step).

| Value       | Maps to    | Notes                                                          |
| ----------- | ---------- | -------------------------------------------------------------- |
| `taxable`   | Taxable    | Standard individual brokerage account.                         |
| `brokerage` | Taxable    | Friendly alias for `taxable`.                                  |
| `trad_ira`  | Trad IRA   | Traditional IRA.                                               |
| `roth_ira`  | Roth IRA   | Roth IRA.                                                      |
| `trad_401k` | 401(k)     | Traditional 401(k). Matmon's storage doesn't split trad/roth.  |
| `roth_401k` | 401(k)     | Roth 401(k). Same storage as trad_401k for now.                |
| `401k`      | 401(k)     | Generic 401(k).                                                |
| `hsa`       | HSA        | Health Savings Account.                                        |
| `529`       | Other      | Education savings. Folded into "Other" until 529s ship.        |
| `other`     | Other      | Anything else.                                                 |

## Common gotchas

### Date formats

- Use `YYYY-MM-DD` (e.g. `2024-01-15`). It's unambiguous and the safest
  choice if you're pasting from a spreadsheet.
- `M/D/YYYY` US-style (`1/15/2024`) is also accepted.
- Avoid `DD/MM/YYYY` UK-style. Matmon defaults to US interpretation for
  ambiguous dates and will get the month/day backwards.

### Signed amounts vs unsigned amounts

The `Action` column tells Matmon whether the row is an inflow or outflow.
You don't need to negate `Amount` yourself for most actions:

- `buy`, `cash_in`, `contribution`, `dividend`, `transfer_in`: positive
  `Amount` (or leave blank to derive from `Quantity * Price + Fees`).
- `sell`, `cash_out`, `withdrawal`, `fee`: you CAN write a negative `Amount`
  (e.g. `-500.00`) and Matmon will preserve the sign. It will not
  double-negate. If you prefer to write positive numbers and let the action
  tell the story, that also works.

### Dividend rows

- Leave `Quantity` and `Price` blank.
- Fill `Amount` with the cash you received.
- If the dividend was reinvested, use `div_reinvest` instead and fill
  `Quantity`, `Price`, and `Amount`.

### Account naming

- The combination of `(Brokerage, Account)` is the bucket key. If you have
  two accounts with the same `Account` string but different `Brokerage`
  values, Matmon will keep them separate. If you have the same `Brokerage`
  with two different `Account` strings, they're two separate accounts in
  Matmon.
- The trailing 4 digits of the `Account` string, if any, are treated as a
  fingerprint for dedupe on re-import. Putting `2180` at the end of your
  account name (e.g. `My 401k 2180`) lets Matmon recognize the same account
  when you re-upload the file.

### Empty rows

Wholly blank rows are skipped silently. Rows with an `Action` value that
isn't on the allow-list are skipped with a warning. Rows with an
unparseable `Date` are skipped with a warning.

## Worked example: Human Interest 401(k)

Human Interest doesn't expose a CSV export of your transaction history.
Here's how a typical month looks when you transcribe it by hand:

```csv
Date,Action,Symbol,Description,Quantity,Price,Amount,Fees,Account,Brokerage,Account Type,Currency,Notes
2026-01-05,contribution,,,,,375.00,,Human Interest 401k,Human Interest,trad_401k,USD,Pay period 1 employee
2026-01-05,contribution,,,,,150.00,,Human Interest 401k,Human Interest,trad_401k,USD,Pay period 1 employer match
2026-01-06,buy,VOO,Vanguard S&P 500 ETF,1.0517,498.71,524.50,,Human Interest 401k,Human Interest,trad_401k,USD,Auto-invested
2026-01-19,contribution,,,,,375.00,,Human Interest 401k,Human Interest,trad_401k,USD,Pay period 2 employee
2026-01-19,contribution,,,,,150.00,,Human Interest 401k,Human Interest,trad_401k,USD,Pay period 2 employer match
2026-01-20,buy,VOO,Vanguard S&P 500 ETF,1.0488,500.05,524.45,,Human Interest 401k,Human Interest,trad_401k,USD,Auto-invested
2026-01-31,dividend,VOO,Vanguard S&P 500 ETF,,,3.20,,Human Interest 401k,Human Interest,trad_401k,USD,Monthly distribution
```

Notes:

- Each contribution row is a `cash_in` (via the friendly `contribution`
  alias). The employee and employer portions are separate rows so the
  Notes column can disambiguate them.
- Each auto-invest is a `buy` with `Quantity`, `Price`, and the calculated
  `Amount`. `Amount` is positive (the cost of the purchase, not the cash
  outflow from the contribution row).
- The monthly distribution is a `dividend` with `Quantity` and `Price`
  blank. If it had been reinvested it would be a `div_reinvest` row.
- Every row carries the same `(Brokerage, Account)`, so Matmon imports
  them as one account.

After upload, the review step lets you rename the account, switch the
account type if Matmon got it wrong, and confirm the import.

## Troubleshooting

| Symptom                                                                   | Cause                                                          | Fix                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| "We couldn't figure this CSV out automatically."                          | Header row doesn't include all 6 required columns.             | Re-download the template, copy your data into it, and re-upload.     |
| Row count after import is lower than the file's row count.                | Some rows had unknown `Action` values or unparseable `Date`s.  | Check the import status; warnings list which rows were skipped.       |
| Holdings show 0 quantity for a symbol you bought.                         | `buy` row had blank `Quantity`.                                 | Fill in `Quantity` (and `Price`) on buy rows, not just `Amount`.     |
| Two accounts show up where you expected one.                              | The `Account` string varied between rows (typo, trailing whitespace, etc.). | Re-export the template, make the `Account` string identical on every row, and re-upload. |
| Re-importing the file creates duplicate transactions.                     | The `Date`, `Action`, `Symbol`, `Quantity`, `Price`, or `Account` fields changed between imports. | Keep the source file canonical; Matmon dedupes on the combined fingerprint. |
