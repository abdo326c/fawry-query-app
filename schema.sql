-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Import Batches Table
CREATE TABLE IF NOT EXISTS import_batches (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_email        VARCHAR(255),
  file_name         VARCHAR(255),
  status            VARCHAR(50),
  records_processed INTEGER DEFAULT 0,
  records_inserted  INTEGER DEFAULT 0,
  details           JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Main Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
  id               BIGSERIAL PRIMARY KEY,
  reference_number VARCHAR(50) NOT NULL,
  payment_date     DATE,
  student_id       VARCHAR(100),
  raw_student_id   TEXT,
  customer_mobile  VARCHAR(50),
  total_amount     DECIMAL(12,2),
  net_amount       DECIMAL(12,2),
  fawry_fees       DECIMAL(10,2),
  payment_status   VARCHAR(50) DEFAULT 'PAID',
  item_name        VARCHAR(255),
  item_price       DECIMAL(12,2),
  mapping          VARCHAR(100),
  second_mapping   TEXT,
  merchant_name    VARCHAR(100),
  bank             VARCHAR(50),
  check_column     VARCHAR(255),
  id_status        VARCHAR(100),
  batch_id         UUID REFERENCES import_batches(id) ON DELETE SET NULL,
  erp_batch_number VARCHAR(100),
  erp_voucher      VARCHAR(100),
  is_settled       BOOLEAN DEFAULT FALSE,
  settlement_batch VARCHAR(100),
  import_date      TIMESTAMPTZ DEFAULT NOW(),

  -- Deduplication composite key (Reference Number + Item Price + Original Item Check Column)
  UNIQUE(reference_number, item_price, check_column)
);

-- Ensure columns exist on existing installations
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_student_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS second_mapping TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS erp_batch_number VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS erp_voucher VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_settled BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_batch VARCHAR(100);

-- Indexes for fast querying
CREATE INDEX IF NOT EXISTS idx_transactions_payment_date ON transactions(payment_date);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_student ON transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_transactions_bank_date ON transactions(bank, payment_date);
CREATE INDEX IF NOT EXISTS idx_transactions_id_status ON transactions(id_status);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON transactions(batch_id);

-- 3. Links Table
CREATE TABLE IF NOT EXISTS links (
  id                       SERIAL PRIMARY KEY,
  invoice_number           VARCHAR(100),
  customer_name            VARCHAR(255),
  customer_mobile          VARCHAR(50),
  customer_email           VARCHAR(255),
  payment_status           VARCHAR(50),
  paid_amount              DECIMAL(12,2),
  payment_reference_number VARCHAR(50) UNIQUE,
  customer_national_id     VARCHAR(100),
  custom_input_value       VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_links_reference ON links(payment_reference_number);

-- 4. Item Mappings Table
CREATE TABLE IF NOT EXISTS item_mappings (
  id                 SERIAL PRIMARY KEY,
  item_name          VARCHAR(255) UNIQUE NOT NULL,
  adjusted_item_name VARCHAR(255),
  mapping            VARCHAR(100),
  second_mapping     TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE item_mappings ADD COLUMN IF NOT EXISTS second_mapping TEXT;

-- 5. Manual Fixes Table
CREATE TABLE IF NOT EXISTS manual_fixes (
  id               SERIAL PRIMARY KEY,
  reference_number VARCHAR(50) UNIQUE NOT NULL,
  correct_id       VARCHAR(50),
  item_name        VARCHAR(255),
  mapping          VARCHAR(100),
  second_mapping   TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE manual_fixes ADD COLUMN IF NOT EXISTS second_mapping TEXT;

-- 6. Student Master Table
CREATE TABLE IF NOT EXISTS student_master (
  student_id      VARCHAR(50) PRIMARY KEY,
  full_name       VARCHAR(255),
  arabic_name     VARCHAR(255),
  national_id     VARCHAR(50),
  email           VARCHAR(255),
  mobile          VARCHAR(50),
  guardian_name   VARCHAR(255),
  guardian_mobile VARCHAR(50),
  college         VARCHAR(255),
  program         VARCHAR(255),
  source          VARCHAR(100),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_master_national_id ON student_master(national_id);
CREATE INDEX IF NOT EXISTS idx_student_master_email ON student_master(email);
CREATE INDEX IF NOT EXISTS idx_student_master_mobile ON student_master(mobile);

-- 7. Payment Links Catalog Table
CREATE TABLE IF NOT EXISTS payment_links (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  amount         DECIMAL(12,2),
  invoice_number VARCHAR(100),
  creation_date  DATE,
  expiry_date    TIMESTAMPTZ,
  invoice_link   TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id                  BIGSERIAL PRIMARY KEY,
  user_email          VARCHAR(255),
  action              VARCHAR(255),
  affected_references TEXT,
  details             JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Row Level Security (RLS) - Restrict access to authenticated users only
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE links ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_fixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transactions', 'links', 'item_mappings', 'manual_fixes',
    'student_master', 'payment_links', 'import_batches', 'audit_logs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_full_access ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY authenticated_full_access ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- 10. Server-Side RPC Functions for Performance
CREATE OR REPLACE FUNCTION get_dashboard_pivot(start_date DATE, end_date DATE)
RETURNS TABLE (
  payment_date DATE,
  bank VARCHAR,
  daily_total NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.payment_date,
    t.bank,
    COALESCE(SUM(t.item_price), 0) AS daily_total
  FROM transactions t
  WHERE t.payment_date >= start_date
    AND t.payment_date <= end_date
  GROUP BY t.payment_date, t.bank
  ORDER BY t.payment_date, t.bank;
$$;

CREATE OR REPLACE FUNCTION get_distinct_transaction_values(col_name TEXT)
RETURNS TABLE (val TEXT)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF col_name NOT IN ('mapping', 'item_name', 'second_mapping', 'bank', 'id_status') THEN
    RAISE EXCEPTION 'Invalid column name for distinct lookup: %', col_name;
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT DISTINCT %I::TEXT AS val FROM transactions WHERE %I IS NOT NULL AND %I::TEXT <> '''' ORDER BY 1',
    col_name, col_name, col_name
  );
END;
$$;
