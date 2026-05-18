# Brokerage Importer Fixtures

This directory holds CSV fixtures that exercise the brokerage importers in
`src/lib/importers/`. Each subdirectory corresponds to one importer and
contains at minimum:

- `basic.csv`: small (10 to 20 rows), exercises every action type the
  importer maps (buy, sell, dividend, reinvest). Used by tests as the
  "no unmapped action strings" baseline.
- `realistic.csv`: 100+ row plausible export spanning several years with
  multiple symbols, dividends, reinvestments, sells, and a few rows the
  importer is expected to leave unmapped (deposits, transfers, journal
  entries). Used by tests to validate broad parser coverage and dedupe.

All ticker symbols, share counts, prices, and dates are synthetic.
Anything that looks real is coincidence.

## Supported brokerages

The four importers ship with Matmon today:

| Directory        | Importer ID     | Capability        | Export location (best-effort)                                                                                  |
| ---------------- | --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `fidelity/`      | `fidelity`      | transaction-level | Accounts and Trade, then Activity and Orders, then History tab, then Download (CSV).                           |
| `schwab/`        | `schwab`        | transaction-level | Accounts, then History, set date range, then Export. Covers legacy TD Ameritrade exports too.                  |
| `jpmorgan/`      | `jpmorgan`      | transaction-level | Investments, then Activity, then Download (CSV). Also fires for Chase Brokerage exports.                       |
| `humanInterest/` | `humanInterest` | holdings-only     | TODO: confirm. Believed to live under Investments, then Statements and Documents on the participant dashboard. |

## Adding your own real export

The importers are easier to trust when they have been smoke-tested against
a real-world CSV. To contribute one:

1. Download the CSV from the brokerage.
2. Open it in a spreadsheet and sanitize anything personal:
   - Strip the account number column entirely, or replace with a synthetic
     value like `XXXX1234`.
   - Replace your name on header lines with a placeholder.
   - Leave ticker symbols, dates, prices, and share counts as-is. Those
     are what we want the importer to chew on.
3. Drop the sanitized file next to `realistic.csv` in the matching broker
   subdirectory. Any filename ending in `.csv` works. The test harness in
   `tests/fixtures.test.ts` only auto-loads `basic.csv` and
   `realistic.csv` by name, so additional files will not break tests, but
   you can extend the test if you want them covered.
4. Run `npm test` and make sure nothing regresses.

If you are sanity-checking the importer against your own statements
without committing them, keep the file local and add it to
`.gitignore` first.

## Adding a new brokerage

When you add a new importer:

1. Write the parser in `src/lib/importers/<name>.ts` and register it in
   `src/lib/importers/index.ts`.
2. Create `src/lib/importers/__fixtures__/<name>/` with a `basic.csv` and
   a `realistic.csv`.
3. Extend `tests/fixtures.test.ts` with a case for the new importer ID.
4. Document the export path in the table above.

## Header notes

Each importer's `matches()` function pins down which header rows it
claims. Read the source if you are crafting a new fixture by hand:

- `src/lib/importers/fidelity.ts`: expects `Run Date`, `Action`, `Symbol`,
  plus `Settlement Date` or `Amount ($)`.
- `src/lib/importers/schwab.ts`: expects `Date`, `Action`, `Symbol`, and a
  fees column (`Fees & Comm`, `Commission`, or `Fees and Comm`).
- `src/lib/importers/jpmorgan.ts`: expects `Trade Date` or `Posting Date`,
  a transaction type column, `Symbol` or `Security Symbol`, and `Net
Amount` or `Amount`.
- `src/lib/importers/humanInterest.ts`: expects a fund or investment
  column, a `Shares` or `Units` column, and one of the contribution
  columns (`Employee Contributions`, `Employer Contributions`).
