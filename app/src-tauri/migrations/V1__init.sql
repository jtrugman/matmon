-- Matmon initial schema. Kept in sync with src/lib/db/schema.ts so both the
-- in-Tauri SQLite plugin (which applies migrations on app start) and the
-- in-browser dev fallback (which applies the TS schema) provision the same shape.

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  brokerage     TEXT NOT NULL,
  account_type  TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  symbol        TEXT,
  action        TEXT NOT NULL,
  quantity      REAL NOT NULL DEFAULT 0,
  price         REAL NOT NULL DEFAULT 0,
  fees          REAL NOT NULL DEFAULT 0,
  amount        REAL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  notes         TEXT,
  imported_from TEXT,
  UNIQUE(account_id, date, symbol, action, quantity, price, imported_from)
);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_symbol_date  ON transactions(symbol, date);

CREATE TABLE IF NOT EXISTS prices (
  symbol     TEXT NOT NULL,
  date       TEXT NOT NULL,
  close      REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS symbol_metadata (
  symbol           TEXT PRIMARY KEY,
  name             TEXT,
  asset_class      TEXT,
  currency         TEXT,
  last_split_date  TEXT
);

CREATE TABLE IF NOT EXISTS achievements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_key  TEXT NOT NULL UNIQUE,
  unlocked_at    TEXT NOT NULL,
  context_json   TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profile (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  name                        TEXT,
  birth_year                  INTEGER,
  target_retirement_age       INTEGER,
  expected_retirement_income  REAL,
  household_size              INTEGER
);

CREATE TABLE IF NOT EXISTS tax_constants (
  year   INTEGER NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  notes  TEXT,
  PRIMARY KEY (year, key)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
