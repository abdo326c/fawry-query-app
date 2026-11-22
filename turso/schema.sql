-- ============================================================================
-- TURSO / LIBSQL (SQLite) SCHEMA FOR FAWRY PAYMENTS DATABASE
-- Converted from PostgreSQL consolidated schema (v2.11.6)
-- ============================================================================

-- 0. Application Users (replaces Supabase auth.users)
CREATE TABLE IF NOT EXISTS app_users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  last_sign_in_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_users_email_lower ON app_users (LOWER(TRIM(email)));

-- 1. Role-Based Access Control (4-tier RBAC: viewer < operator < accountant < admin)
CREATE TABLE IF NOT EXISTS user_roles (
  email       TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'operator', 'accountant', 'admin')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_roles_email_lower ON user_roles (LOWER(TRIM(email)));

INSERT INTO user_roles (email, role, is_active, updated_by)
VALUES ('ammahmoud@nu.edu.eg', 'admin', 1, 'system')
ON CONFLICT (email) DO UPDATE SET role = 'admin', is_active = 1, updated_at = datetime('now');

-- 2. Import Batches Table
CREATE TABLE IF NOT EXISTS import_batches (
  id                TEXT PRIMARY KEY,
  user_email        TEXT,
  file_name         TEXT,
  status            TEXT,
  records_processed INTEGER DEFAULT 0,
  records_inserted  INTEGER DEFAULT 0,
  details           TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

-- 3. Main Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number    TEXT NOT NULL,
  payment_date        TEXT,
  student_id          TEXT,
  original_student_id TEXT,
  raw_student_id      TEXT,
  customer_mobile     TEXT,
  total_amount        REAL,
  net_amount          REAL,
  fawry_fees          REAL,
  payment_status      TEXT DEFAULT 'PAID',
  item_name           TEXT,
  item_price          REAL,
  mapping             TEXT,
  second_mapping      TEXT,
  merchant_name       TEXT,
  bank                TEXT,
  check_column        TEXT,
  file_name           TEXT,
  id_status           TEXT,
  batch_id            TEXT REFERENCES import_batches(id) ON DELETE SET NULL,
  erp_batch_number    TEXT,
  erp_voucher         TEXT,
  is_settled          INTEGER DEFAULT 0,
  settlement_batch    TEXT,
  student_level       TEXT,
  import_date         TEXT DEFAULT (datetime('now')),
  UNIQUE(reference_number, item_price, check_column)
);

CREATE INDEX IF NOT EXISTS idx_transactions_date_id ON transactions(payment_date ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_student_id ON transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_transactions_item_name ON transactions(item_name);
CREATE INDEX IF NOT EXISTS idx_transactions_mapping ON transactions(mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_second_mapping ON transactions(second_mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_erp_batch ON transactions(erp_batch_number);
CREATE INDEX IF NOT EXISTS idx_transactions_settlement_batch ON transactions(settlement_batch);
CREATE INDEX IF NOT EXISTS idx_transactions_is_settled ON transactions(is_settled);
CREATE INDEX IF NOT EXISTS idx_transactions_date_bank ON transactions(payment_date, bank);
CREATE INDEX IF NOT EXISTS idx_transactions_id_status ON transactions(id_status);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_nonvalid_id_status ON transactions(id_status, mapping, second_mapping) WHERE COALESCE(id_status, '') NOT IN ('Valid', 'Exempt');
CREATE INDEX IF NOT EXISTS idx_transactions_dashboard_cover ON transactions(payment_date, bank, item_price, mapping, second_mapping, id_status, is_settled, erp_batch_number);
CREATE INDEX IF NOT EXISTS idx_transactions_tuition_dups ON transactions(student_id, item_name, item_price, payment_date) WHERE id_status = 'Valid' AND LOWER(TRIM(COALESCE(mapping, ''))) = 'tuition';

-- 4. Transactions Archive Table
CREATE TABLE IF NOT EXISTS transactions_archive (
  id                  INTEGER PRIMARY KEY,
  reference_number    TEXT NOT NULL,
  payment_date        TEXT,
  student_id          TEXT,
  original_student_id TEXT,
  raw_student_id      TEXT,
  customer_mobile     TEXT,
  total_amount        REAL,
  net_amount          REAL,
  fawry_fees          REAL,
  payment_status      TEXT DEFAULT 'PAID',
  item_name           TEXT,
  item_price          REAL,
  mapping             TEXT,
  second_mapping      TEXT,
  merchant_name       TEXT,
  bank                TEXT,
  check_column        TEXT,
  file_name           TEXT,
  id_status           TEXT,
  batch_id            TEXT,
  erp_batch_number    TEXT,
  erp_voucher         TEXT,
  is_settled          INTEGER DEFAULT 0,
  settlement_batch    TEXT,
  student_level       TEXT,
  import_date         TEXT,
  archived_at         TEXT NOT NULL DEFAULT (datetime('now')),
  archived_by         TEXT,
  UNIQUE(reference_number, item_price, check_column)
);

CREATE INDEX IF NOT EXISTS idx_tx_archive_payment_date ON transactions_archive(payment_date);
CREATE INDEX IF NOT EXISTS idx_tx_archive_student_id ON transactions_archive(student_id);
CREATE INDEX IF NOT EXISTS idx_tx_archive_reference ON transactions_archive(reference_number);

-- 5. Links Table
CREATE TABLE IF NOT EXISTS links (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number           TEXT,
  customer_name            TEXT,
  customer_mobile          TEXT,
  customer_email           TEXT,
  payment_status           TEXT,
  paid_amount              REAL,
  payment_reference_number TEXT UNIQUE,
  customer_national_id     TEXT,
  custom_input_value       TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_reference ON links(payment_reference_number);

-- 6. Item Mappings Table
CREATE TABLE IF NOT EXISTS item_mappings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name          TEXT UNIQUE NOT NULL,
  adjusted_item_name TEXT,
  mapping            TEXT,
  second_mapping     TEXT,
  created_at         TEXT DEFAULT (datetime('now'))
);

-- 7. Manual Fixes Table
CREATE TABLE IF NOT EXISTS manual_fixes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number TEXT UNIQUE NOT NULL,
  correct_id       TEXT,
  item_name        TEXT,
  mapping          TEXT,
  second_mapping   TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
);

-- 8. Student Master Table
CREATE TABLE IF NOT EXISTS student_master (
  student_id      TEXT PRIMARY KEY,
  full_name       TEXT,
  arabic_name     TEXT,
  national_id     TEXT,
  email           TEXT,
  personal_email  TEXT,
  mobile          TEXT,
  guardian_name   TEXT,
  guardian_mobile TEXT,
  college         TEXT,
  program         TEXT,
  source          TEXT,
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_student_master_national ON student_master(national_id);

-- 9. Payment Links Catalog Table
CREATE TABLE IF NOT EXISTS payment_links (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  amount         REAL,
  invoice_number TEXT,
  creation_date  TEXT,
  expiry_date    TEXT,
  invoice_link   TEXT NOT NULL,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_links_invoice ON payment_links(invoice_number);

-- 10. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email          TEXT,
  action              TEXT,
  affected_references TEXT,
  details             TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- 11. Foreign / Bank Statement Student Deposits Table
CREATE TABLE IF NOT EXISTS foreign_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number     TEXT UNIQUE NOT NULL,
  transaction_ref      TEXT,
  transaction_code     TEXT DEFAULT 'CHF',
  event                TEXT DEFAULT 'INIT',
  value_date           TEXT,
  transaction_date     TEXT,
  transaction_datetime TEXT,
  amount               REAL NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL DEFAULT 'USD',
  account_number       TEXT,
  student_id           TEXT,
  student_level        TEXT,
  extracted_name       TEXT,
  matched_student_name TEXT,
  handler_name         TEXT,
  deposit_method       TEXT DEFAULT 'Cash Deposit',
  description          TEXT,
  id_status            TEXT,
  match_source         TEXT DEFAULT 'unmatched',
  erp_batch_number     TEXT,
  erp_voucher          TEXT,
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_foreign_tx_value_date ON foreign_transactions(value_date DESC);
CREATE INDEX IF NOT EXISTS idx_foreign_tx_student_id ON foreign_transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_foreign_tx_id_status ON foreign_transactions(id_status);

-- 12. Daily USD/EGP Exchange Rates Table
CREATE TABLE IF NOT EXISTS exchange_rates (
  rate_date     TEXT NOT NULL,
  currency_pair TEXT NOT NULL DEFAULT 'USD_EGP',
  rate          REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'auto',
  updated_by    TEXT,
  updated_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (rate_date, currency_pair)
);

-- 13. Persistent Settlement Reconciliation History Table
CREATE TABLE IF NOT EXISTS settlement_batches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  user_email        TEXT,
  batch_label       TEXT NOT NULL,
  files_count       INTEGER NOT NULL DEFAULT 1,
  total_stl_amount  REAL NOT NULL DEFAULT 0,
  total_sys_amount  REAL NOT NULL DEFAULT 0,
  net_variance      REAL NOT NULL DEFAULT 0,
  matched_count     INTEGER NOT NULL DEFAULT 0,
  mismatch_count    INTEGER NOT NULL DEFAULT 0,
  missing_sys_count INTEGER NOT NULL DEFAULT 0,
  missing_stl_count INTEGER NOT NULL DEFAULT 0,
  summary_data      TEXT NOT NULL DEFAULT '{}'
);

-- 14. Accounting Period Lock (Month-End Close)
CREATE TABLE IF NOT EXISTS closed_periods (
  period_month TEXT PRIMARY KEY,
  is_closed    INTEGER NOT NULL DEFAULT 1,
  closed_by    TEXT,
  closed_at    TEXT,
  reopened_by  TEXT,
  reopened_at  TEXT,
  notes        TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_closed_periods_is_closed ON closed_periods(is_closed);

-- 15. Database-level guards (restored from the Postgres triggers in 2.11.4 / 2.11.3)
--
-- The API checks closed periods before writing, but these triggers are the backstop that
-- covers EVERY write path (RPCs, scripts, races between the check and the write).
-- Safe to re-run: `node scripts/turso_setup.mjs` applies this file to an existing database.

-- One-row switch used only inside a single write batch (archive RPC) and cleared in the same
-- batch, so no other connection ever sees it set. Equivalent of Postgres app.bypass_period_lock.
CREATE TABLE IF NOT EXISTS period_lock_bypass (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

-- 15a. transactions: no insert / update / delete inside a closed month, no moving rows into one.
CREATE TRIGGER IF NOT EXISTS trg_transactions_period_lock_ins
BEFORE INSERT ON transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1 AND period_month = substr(NEW.payment_date, 1, 7))
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_period_lock_upd
BEFORE UPDATE ON transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND (
   EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1 AND period_month = substr(OLD.payment_date, 1, 7))
   OR (NEW.payment_date IS NOT OLD.payment_date
       AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1 AND period_month = substr(NEW.payment_date, 1, 7)))
 )
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_period_lock_del
BEFORE DELETE ON transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1 AND period_month = substr(OLD.payment_date, 1, 7))
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

-- 15b. foreign_transactions (BM USD deposits): period = value_date, else transaction_date.
CREATE TRIGGER IF NOT EXISTS trg_foreign_tx_period_lock_ins
BEFORE INSERT ON foreign_transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1
             AND period_month = substr(COALESCE(NEW.value_date, NEW.transaction_date), 1, 7))
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_foreign_tx_period_lock_upd
BEFORE UPDATE ON foreign_transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND (
   EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1
           AND period_month = substr(COALESCE(OLD.value_date, OLD.transaction_date), 1, 7))
   OR (COALESCE(NEW.value_date, NEW.transaction_date) IS NOT COALESCE(OLD.value_date, OLD.transaction_date)
       AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1
                   AND period_month = substr(COALESCE(NEW.value_date, NEW.transaction_date), 1, 7)))
 )
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_foreign_tx_period_lock_del
BEFORE DELETE ON foreign_transactions
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND EXISTS (SELECT 1 FROM closed_periods WHERE is_closed = 1
             AND period_month = substr(COALESCE(OLD.value_date, OLD.transaction_date), 1, 7))
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

-- 15c. manual_fixes: locked when its reference has a payment or deposit in a closed month.
CREATE TRIGGER IF NOT EXISTS trg_manual_fixes_period_lock_ins
BEFORE INSERT ON manual_fixes
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND (
   EXISTS (SELECT 1 FROM transactions t JOIN closed_periods c
             ON c.is_closed = 1 AND c.period_month = substr(t.payment_date, 1, 7)
           WHERE t.reference_number = NEW.reference_number)
   OR EXISTS (SELECT 1 FROM foreign_transactions f JOIN closed_periods c
                ON c.is_closed = 1 AND c.period_month = substr(COALESCE(f.value_date, f.transaction_date), 1, 7)
              WHERE f.reference_number = NEW.reference_number)
 )
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_manual_fixes_period_lock_upd
BEFORE UPDATE ON manual_fixes
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND (
   EXISTS (SELECT 1 FROM transactions t JOIN closed_periods c
             ON c.is_closed = 1 AND c.period_month = substr(t.payment_date, 1, 7)
           WHERE t.reference_number IN (OLD.reference_number, NEW.reference_number))
   OR EXISTS (SELECT 1 FROM foreign_transactions f JOIN closed_periods c
                ON c.is_closed = 1 AND c.period_month = substr(COALESCE(f.value_date, f.transaction_date), 1, 7)
              WHERE f.reference_number IN (OLD.reference_number, NEW.reference_number))
 )
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

CREATE TRIGGER IF NOT EXISTS trg_manual_fixes_period_lock_del
BEFORE DELETE ON manual_fixes
WHEN NOT EXISTS (SELECT 1 FROM period_lock_bypass)
 AND (
   EXISTS (SELECT 1 FROM transactions t JOIN closed_periods c
             ON c.is_closed = 1 AND c.period_month = substr(t.payment_date, 1, 7)
           WHERE t.reference_number = OLD.reference_number)
   OR EXISTS (SELECT 1 FROM foreign_transactions f JOIN closed_periods c
                ON c.is_closed = 1 AND c.period_month = substr(COALESCE(f.value_date, f.transaction_date), 1, 7)
              WHERE f.reference_number = OLD.reference_number)
 )
BEGIN
  SELECT RAISE(ABORT, 'Accounting period is closed. Reopen the period in Admin before modifying these records.');
END;

-- 15d. Archived payments cannot come back through a re-import: a row whose dedupe key is
-- already in the archive (settled + ERP-posted) is silently skipped.
CREATE INDEX IF NOT EXISTS idx_tx_archive_dedupe_key
  ON transactions_archive (reference_number, item_price, check_column);

CREATE TRIGGER IF NOT EXISTS trg_skip_archived_transaction_insert
BEFORE INSERT ON transactions
WHEN EXISTS (SELECT 1 FROM transactions_archive a
             WHERE a.reference_number = NEW.reference_number
               AND a.item_price IS NEW.item_price
               AND a.check_column IS NEW.check_column)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- 15e. Audit log is append-only at the database level too (the revert RPC may only flip
-- details, e.g. is_reverted; it never deletes).
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'Audit log entries cannot be deleted.');
END;

-- 15f. Archive is append-only: archived rows cannot be changed or removed.
CREATE TRIGGER IF NOT EXISTS trg_tx_archive_no_update
BEFORE UPDATE ON transactions_archive
BEGIN
  SELECT RAISE(ABORT, 'Archived transactions cannot be changed.');
END;

CREATE TRIGGER IF NOT EXISTS trg_tx_archive_no_delete
BEFORE DELETE ON transactions_archive
BEGIN
  SELECT RAISE(ABORT, 'Archived transactions cannot be deleted.');
END;
