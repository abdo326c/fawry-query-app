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
  id                  BIGSERIAL PRIMARY KEY,
  reference_number    VARCHAR(50) NOT NULL,
  payment_date        DATE,
  student_id          VARCHAR(100),
  original_student_id TEXT,
  raw_student_id      TEXT,
  customer_mobile     VARCHAR(50),
  total_amount        DECIMAL(12,2),
  net_amount          DECIMAL(12,2),
  fawry_fees          DECIMAL(10,2),
  payment_status      VARCHAR(50) DEFAULT 'PAID',
  item_name           VARCHAR(255),
  item_price          DECIMAL(12,2),
  mapping             VARCHAR(100),
  second_mapping      TEXT,
  merchant_name       VARCHAR(100),
  bank                VARCHAR(50),
  check_column        VARCHAR(255),
  file_name           VARCHAR(255),
  id_status           VARCHAR(100),
  batch_id            UUID REFERENCES import_batches(id) ON DELETE SET NULL,
  erp_batch_number    VARCHAR(100),
  erp_voucher         VARCHAR(100),
  is_settled          BOOLEAN DEFAULT FALSE,
  settlement_batch    VARCHAR(100),
  import_date         TIMESTAMPTZ DEFAULT NOW(),

  -- Deduplication composite key (Reference Number + Item Price + Original Item Check Column)
  UNIQUE(reference_number, item_price, check_column)
);

-- Ensure columns exist on existing installations
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_student_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_student_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS second_mapping TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS erp_batch_number VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS erp_voucher VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_settled BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_batch VARCHAR(100);

-- Ensure payment_date is strictly DATE (strips any time portion without shifting the calendar date)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transactions'
      AND column_name = 'payment_date'
      AND data_type <> 'date'
  ) THEN
    ALTER TABLE transactions
      ALTER COLUMN payment_date TYPE DATE
      USING (NULLIF(SPLIT_PART(SPLIT_PART(TRIM(payment_date::TEXT), ' ', 1), 'T', 1), ''))::DATE;
  END IF;
END $$;

-- Indexes for fast querying
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_transactions_payment_date ON transactions(payment_date);
CREATE INDEX IF NOT EXISTS idx_transactions_date_id ON transactions(payment_date ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_student ON transactions(student_id);
CREATE INDEX IF NOT EXISTS idx_transactions_item_name ON transactions(item_name);
CREATE INDEX IF NOT EXISTS idx_transactions_mapping ON transactions(mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_second_mapping ON transactions(second_mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_erp_batch ON transactions(erp_batch_number);
CREATE INDEX IF NOT EXISTS idx_transactions_settlement_batch ON transactions(settlement_batch);
CREATE INDEX IF NOT EXISTS idx_transactions_is_settled ON transactions(is_settled);
CREATE INDEX IF NOT EXISTS idx_transactions_date_bank ON transactions(payment_date, bank);
DROP INDEX IF EXISTS public.idx_transactions_bank_date;
CREATE INDEX IF NOT EXISTS idx_transactions_id_status ON transactions(id_status);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ref_trgm ON transactions USING gin (reference_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_student_trgm ON transactions USING gin (student_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_mobile_trgm ON transactions USING gin (customer_mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_item_trgm ON transactions USING gin (item_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_check_col_trgm ON transactions USING gin (check_column gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_mapping_trgm ON transactions USING gin (mapping gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_second_mapping_trgm ON transactions USING gin (second_mapping gin_trgm_ops);

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
  personal_email  VARCHAR(255),
  mobile          VARCHAR(50),
  guardian_name   VARCHAR(255),
  guardian_mobile VARCHAR(50),
  college         VARCHAR(255),
  program         VARCHAR(255),
  source          VARCHAR(100),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE student_master ADD COLUMN IF NOT EXISTS personal_email TEXT;
CREATE INDEX IF NOT EXISTS idx_student_master_national_id ON student_master(national_id);
CREATE INDEX IF NOT EXISTS idx_student_master_email ON student_master(email);
CREATE INDEX IF NOT EXISTS idx_student_master_email_lower ON public.student_master (LOWER(BTRIM(email)));
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email ON public.student_master(personal_email);
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email_lower ON public.student_master (LOWER(BTRIM(personal_email)));
CREATE INDEX IF NOT EXISTS idx_student_master_mobile ON student_master(mobile);
CREATE INDEX IF NOT EXISTS idx_student_master_college ON public.student_master(college);
CREATE INDEX IF NOT EXISTS idx_student_master_name_trgm ON public.student_master USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_mobile_trgm ON public.student_master USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_gmobile_trgm ON public.student_master USING gin (guardian_mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_email_trgm ON public.student_master USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email_trgm ON public.student_master USING gin (personal_email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_natid_trgm ON public.student_master USING gin (national_id gin_trgm_ops);

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
DROP FUNCTION IF EXISTS public.get_dashboard_pivot(DATE, DATE);
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

DROP FUNCTION IF EXISTS public.get_distinct_transaction_values(TEXT);
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

DROP FUNCTION IF EXISTS public.get_dashboard_pivot_by(DATE, DATE, TEXT);
CREATE OR REPLACE FUNCTION get_dashboard_pivot_by(start_date DATE, end_date DATE, group_col TEXT)
RETURNS TABLE (
  group_key TEXT,
  bank VARCHAR,
  total_amount NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF group_col = 'date' THEN
    RETURN QUERY
      SELECT t.payment_date::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY t.payment_date, t.bank
      ORDER BY t.payment_date, t.bank;
  ELSIF group_col = 'mapping' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.mapping, ''), 'Unmapped')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSIF group_col = 'second_mapping' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.second_mapping, ''), 'Unmapped')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSIF group_col = 'item_name' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.item_name, ''), 'Unknown Item')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSE
    RAISE EXCEPTION 'Invalid group_col for dashboard pivot: %', group_col;
  END IF;
END;
$$;


-- 11. Role-Based Access Control (4-tier RBAC: viewer < operator < accountant < admin)
CREATE TABLE IF NOT EXISTS user_roles (
  email       VARCHAR(255) PRIMARY KEY,
  role        VARCHAR(50) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'operator', 'accountant', 'admin')),
  updated_by  VARCHAR(255),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO user_roles (email, role, updated_by)
VALUES ('ammahmoud@nu.edu.eg', 'admin', 'system')
ON CONFLICT (email) DO UPDATE SET role = 'admin', updated_at = NOW();

CREATE INDEX IF NOT EXISTS idx_user_roles_email_lower ON public.user_roles (LOWER(BTRIM(email)));

CREATE OR REPLACE FUNCTION public.role_level(r TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT CASE LOWER(COALESCE(r, 'viewer'))
    WHEN 'admin' THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'operator' THEN 2
    ELSE 1
  END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_role  TEXT;
BEGIN
  v_email := LOWER(BTRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN RETURN 'viewer'; END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN RETURN 'admin'; END IF;
  SELECT role INTO v_role FROM public.user_roles WHERE LOWER(BTRIM(email)) = v_email LIMIT 1;
  RETURN COALESCE(v_role, 'viewer');
END;
$$;

CREATE OR REPLACE FUNCTION public.has_min_role(required_role TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER SET search_path = public AS $$
  SELECT public.role_level(public.current_user_role()) >= public.role_level(required_role);
$$;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_select ON user_roles;
CREATE POLICY user_roles_select ON user_roles FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS user_roles_admin_write ON user_roles;
CREATE POLICY user_roles_admin_write ON user_roles FOR ALL TO authenticated USING ((SELECT public.has_min_role('admin'))) WITH CHECK ((SELECT public.has_min_role('admin')));

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
    EXECUTE format('DROP POLICY IF EXISTS rbac_select ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_insert ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_update ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_delete ON %I', tbl);
    EXECUTE format('CREATE POLICY rbac_select ON %I FOR SELECT TO authenticated USING (true)', tbl);
  END LOOP;
END $$;

CREATE POLICY rbac_insert ON transactions FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON transactions FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_delete ON transactions FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON links FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON links FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_delete ON links FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON student_master FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON student_master FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_delete ON student_master FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON payment_links FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON payment_links FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_delete ON payment_links FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON import_batches FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON import_batches FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_delete ON import_batches FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));

CREATE POLICY rbac_insert ON item_mappings FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('accountant')));
CREATE POLICY rbac_update ON item_mappings FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('accountant'))) WITH CHECK ((SELECT public.has_min_role('accountant')));
CREATE POLICY rbac_delete ON item_mappings FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

CREATE POLICY rbac_insert ON manual_fixes FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('accountant')));
CREATE POLICY rbac_update ON manual_fixes FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('accountant'))) WITH CHECK ((SELECT public.has_min_role('accountant')));
CREATE POLICY rbac_delete ON manual_fixes FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

-- 12. Auth.Users Sync Function & Trigger
CREATE OR REPLACE FUNCTION public.sync_auth_users()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_inserted INTEGER := 0;
  v_total    INTEGER := 0;
BEGIN
  WITH ins AS (
    INSERT INTO public.user_roles (email, role, updated_by, updated_at)
    SELECT
      LOWER(TRIM(u.email)),
      CASE WHEN LOWER(TRIM(u.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      'auth.users sync',
      NOW()
    FROM auth.users u
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ON CONFLICT (email) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  INSERT INTO public.user_roles (email, role, updated_by, updated_at)
  SELECT DISTINCT LOWER(TRIM(user_email)), 'viewer', 'history sync', NOW()
  FROM (
    SELECT user_email FROM public.import_batches WHERE user_email IS NOT NULL AND user_email <> 'System' AND user_email LIKE '%@%'
    UNION
    SELECT user_email FROM public.audit_logs WHERE user_email IS NOT NULL AND user_email <> 'System' AND user_email LIKE '%@%'
  ) h
  WHERE LOWER(TRIM(user_email)) <> 'ammahmoud@nu.edu.eg'
  ON CONFLICT (email) DO NOTHING;

  SELECT COUNT(*) INTO v_total FROM public.user_roles;
  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_auth_users() TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND TRIM(NEW.email) <> '' THEN
    INSERT INTO public.user_roles (email, role, updated_by, updated_at)
    VALUES (
      LOWER(TRIM(NEW.email)),
      CASE WHEN LOWER(TRIM(NEW.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      'auth.signup',
      NOW()
    )
    ON CONFLICT (email) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- 13. Bulk Rule Fields Update RPC (accelerates Bulk Manual Fixes, Auto-Matcher & Re-apply Rules)
CREATE OR REPLACE FUNCTION public.bulk_update_rule_fields(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' OR jsonb_array_length(p_updates) = 0 THEN
    RETURN 0;
  END IF;

  WITH payload AS (
    SELECT
      (elem ->> 'id')::bigint AS id,
      elem ->> 'student_id' AS student_id,
      elem ->> 'item_name' AS item_name,
      elem ->> 'mapping' AS mapping,
      elem ->> 'second_mapping' AS second_mapping,
      elem ->> 'id_status' AS id_status
    FROM jsonb_array_elements(p_updates) AS elem
    WHERE (elem ->> 'id') IS NOT NULL
  ),
  upd AS (
    UPDATE public.transactions t
    SET
      student_id = p.student_id,
      item_name = p.item_name,
      mapping = p.mapping,
      second_mapping = p.second_mapping,
      id_status = p.id_status
    FROM payload p
    WHERE t.id = p.id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RETURN v_updated;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bulk_update_rule_fields(jsonb) TO authenticated;

-- 14. Foreign / Bank Statement Student Deposits Table
CREATE TABLE IF NOT EXISTS public.foreign_transactions (
  id                     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  reference_number       VARCHAR(120) UNIQUE NOT NULL,
  transaction_ref        VARCHAR(120),
  transaction_code       VARCHAR(30) DEFAULT 'CHF',
  event                  VARCHAR(30) DEFAULT 'INIT',
  value_date             DATE,
  transaction_date       DATE,
  transaction_datetime   VARCHAR(64),
  amount                 NUMERIC(15, 2) NOT NULL DEFAULT 0,
  currency               VARCHAR(16) NOT NULL DEFAULT 'USD',
  account_number         VARCHAR(64),
  student_id             VARCHAR(64),
  extracted_name         TEXT,
  matched_student_name   TEXT,
  handler_name           TEXT,
  deposit_method         VARCHAR(64) DEFAULT 'Cash Deposit',
  description            TEXT,
  id_status              VARCHAR(64),
  match_source           VARCHAR(32) DEFAULT 'unmatched',
  erp_batch_number       VARCHAR(100),
  erp_voucher            VARCHAR(100),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_foreign_tx_value_date ON public.foreign_transactions (value_date DESC);
CREATE INDEX IF NOT EXISTS idx_foreign_tx_student_id ON public.foreign_transactions (student_id);
CREATE INDEX IF NOT EXISTS idx_foreign_tx_id_status  ON public.foreign_transactions (id_status);

ALTER TABLE public.foreign_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS foreign_tx_select ON public.foreign_transactions;
CREATE POLICY foreign_tx_select ON public.foreign_transactions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS foreign_tx_insert ON public.foreign_transactions;
CREATE POLICY foreign_tx_insert ON public.foreign_transactions FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));

DROP POLICY IF EXISTS foreign_tx_update ON public.foreign_transactions;
CREATE POLICY foreign_tx_update ON public.foreign_transactions FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));

DROP POLICY IF EXISTS foreign_tx_delete ON public.foreign_transactions;
CREATE POLICY foreign_tx_delete ON public.foreign_transactions FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

-- 15. Daily USD/EGP Exchange Rates Table (for Multi-Currency Reporting)
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  rate_date      DATE NOT NULL,
  currency_pair  VARCHAR(16) NOT NULL DEFAULT 'USD_EGP',
  rate           NUMERIC(12, 4) NOT NULL,
  source         VARCHAR(24) NOT NULL DEFAULT 'auto',
  updated_by     VARCHAR(255),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (rate_date, currency_pair)
);

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
CREATE POLICY exchange_rates_select ON public.exchange_rates FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS exchange_rates_insert ON public.exchange_rates;
CREATE POLICY exchange_rates_insert ON public.exchange_rates FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));

DROP POLICY IF EXISTS exchange_rates_update ON public.exchange_rates;
CREATE POLICY exchange_rates_update ON public.exchange_rates FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('operator'))) WITH CHECK ((SELECT public.has_min_role('operator')));

DROP POLICY IF EXISTS exchange_rates_delete ON public.exchange_rates;
CREATE POLICY exchange_rates_delete ON public.exchange_rates FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

-- 16. Persistent Settlement Reconciliation History Table
CREATE TABLE IF NOT EXISTS public.settlement_batches (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_email TEXT,
  batch_label TEXT NOT NULL,
  files_count INTEGER NOT NULL DEFAULT 1,
  total_stl_amount NUMERIC NOT NULL DEFAULT 0,
  total_sys_amount NUMERIC NOT NULL DEFAULT 0,
  net_variance NUMERIC NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  missing_sys_count INTEGER NOT NULL DEFAULT 0,
  missing_stl_count INTEGER NOT NULL DEFAULT 0,
  summary_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.settlement_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rbac_select" ON public.settlement_batches;
DROP POLICY IF EXISTS "rbac_insert" ON public.settlement_batches;
DROP POLICY IF EXISTS "rbac_update" ON public.settlement_batches;
DROP POLICY IF EXISTS "rbac_delete" ON public.settlement_batches;

CREATE POLICY "rbac_select" ON public.settlement_batches
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "rbac_insert" ON public.settlement_batches
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.has_min_role('operator')));

CREATE POLICY "rbac_update" ON public.settlement_batches
  FOR UPDATE TO authenticated
  USING ((SELECT public.has_min_role('accountant')))
  WITH CHECK ((SELECT public.has_min_role('accountant')));

CREATE POLICY "rbac_delete" ON public.settlement_batches
  FOR DELETE TO authenticated
  USING ((SELECT public.has_min_role('admin')));

-- Helper: checks admin role or trusted Supabase service/automation context
CREATE OR REPLACE FUNCTION public.is_admin_or_automation()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_jwt_role TEXT;
BEGIN
  IF public.has_min_role('admin') THEN
    RETURN true;
  END IF;
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN true;
  END IF;
  BEGIN
    v_jwt_role := COALESCE(auth.jwt() ->> 'role', '');
  EXCEPTION WHEN OTHERS THEN
    v_jwt_role := '';
  END;
  RETURN v_jwt_role = 'service_role';
END;
$function$;

-- 17. Database Hygiene Audit RPC
CREATE OR REPLACE FUNCTION public.run_database_hygiene_audit(p_clean boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_email TEXT;
  v_total_tx INTEGER;
  v_settled_tx INTEGER;
  v_unmapped_tx INTEGER;
  v_invalid_id_tx INTEGER;
  v_identical_dups INTEGER;
  v_dup_mappings INTEGER;
  v_dup_fixes INTEGER;
  v_cleaned_mappings INTEGER := 0;
  v_cleaned_fixes INTEGER := 0;
  v_health_score NUMERIC;
  v_deleted_mappings_json JSONB := '[]'::jsonb;
  v_deleted_fixes_json JSONB := '[]'::jsonb;
  v_audit_id BIGINT;
BEGIN
  IF NOT public.is_admin_or_automation() THEN
    RAISE EXCEPTION 'Unauthorized hygiene audit request';
  END IF;

  BEGIN
    v_email := NULLIF(auth.jwt() ->> 'email', '');
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  v_email := COALESCE(v_email, 'system@nu.edu.eg');

  SELECT count(*) INTO v_total_tx FROM transactions;
  SELECT count(*) INTO v_settled_tx FROM transactions WHERE is_settled = true;
  SELECT count(*) INTO v_unmapped_tx FROM transactions WHERE mapping IS NULL OR mapping = '' OR mapping = 'Unmapped';
  SELECT count(*) INTO v_invalid_id_tx FROM transactions WHERE id_status IS NOT NULL AND id_status <> 'Valid';

  SELECT COALESCE(sum(c - 1), 0) INTO v_identical_dups
  FROM (
    SELECT count(*) as c
    FROM transactions
    GROUP BY reference_number, item_name, item_price, payment_date
    HAVING count(*) > 1
  ) s;

  SELECT COALESCE(sum(c - 1), 0) INTO v_dup_mappings
  FROM (
    SELECT count(*) as c
    FROM item_mappings
    GROUP BY LOWER(TRIM(item_name))
    HAVING count(*) > 1
  ) s;

  SELECT COALESCE(sum(c - 1), 0) INTO v_dup_fixes
  FROM (
    SELECT count(*) as c
    FROM manual_fixes
    GROUP BY reference_number
    HAVING count(*) > 1
  ) s;

  IF p_clean THEN
    WITH dups AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(item_name)) ORDER BY id ASC) as rn
      FROM item_mappings
    ),
    del_m AS (
      DELETE FROM item_mappings
      WHERE id IN (SELECT id FROM dups WHERE rn > 1)
      RETURNING item_name, adjusted_item_name, mapping, second_mapping
    )
    SELECT count(*), COALESCE(jsonb_agg(to_jsonb(del_m)), '[]'::jsonb)
    INTO v_cleaned_mappings, v_deleted_mappings_json
    FROM del_m;

    WITH dup_f AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY reference_number ORDER BY id ASC) as rn
      FROM manual_fixes
    ),
    del_f AS (
      DELETE FROM manual_fixes
      WHERE id IN (SELECT id FROM dup_f WHERE rn > 1)
      RETURNING reference_number, correct_id, item_name, mapping, second_mapping
    )
    SELECT count(*), COALESCE(jsonb_agg(to_jsonb(del_f)), '[]'::jsonb)
    INTO v_cleaned_fixes, v_deleted_fixes_json
    FROM del_f;
  END IF;

  IF v_total_tx = 0 THEN
    v_health_score := 100.0;
  ELSE
    v_health_score := ROUND(GREATEST(0, (1.0 - (v_invalid_id_tx + v_unmapped_tx + v_identical_dups + v_dup_mappings + v_dup_fixes)::NUMERIC / (v_total_tx * 2.0))) * 100, 1);
  END IF;

  INSERT INTO audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_email,
    'Database Hygiene Audit',
    'TX:' || v_total_tx || '|INVALID:' || v_invalid_id_tx,
    jsonb_build_object(
      'health_score', v_health_score || '%',
      'total_transactions', v_total_tx,
      'settled_transactions', v_settled_tx,
      'invalid_ids', v_invalid_id_tx,
      'unmapped_items', v_unmapped_tx,
      'identical_tx_duplicates', v_identical_dups,
      'duplicate_mappings', v_dup_mappings,
      'duplicate_fixes', v_dup_fixes,
      'cleaned_mappings', v_cleaned_mappings,
      'cleaned_fixes', v_cleaned_fixes,
      'auto_cleaned', p_clean,
      'is_reverted', false,
      'revert_snapshot', jsonb_build_object(
        'deleted_mappings', v_deleted_mappings_json,
        'deleted_fixes', v_deleted_fixes_json
      )
    )
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'audit_id', v_audit_id,
    'health_score', v_health_score,
    'total_transactions', v_total_tx,
    'settled_transactions', v_settled_tx,
    'invalid_ids', v_invalid_id_tx,
    'unmapped_items', v_unmapped_tx,
    'identical_tx_duplicates', v_identical_dups,
    'duplicate_mappings', v_dup_mappings,
    'duplicate_fixes', v_dup_fixes,
    'cleaned_mappings', v_cleaned_mappings,
    'cleaned_fixes', v_cleaned_fixes,
    'auto_cleaned', p_clean
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_database_hygiene_audit(boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.run_database_hygiene_audit(boolean) TO authenticated, service_role;

-- 18. Rollback Database Hygiene Audit RPC
CREATE OR REPLACE FUNCTION public.rollback_database_hygiene_audit(p_audit_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_audit RECORD;
  v_snapshot JSONB;
  v_m JSONB;
  v_f JSONB;
  v_restored_m INTEGER := 0;
  v_restored_f INTEGER := 0;
  v_email TEXT;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  SELECT * INTO v_audit FROM audit_logs WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log record % not found', p_audit_id;
  END IF;

  IF (v_audit.details ->> 'is_reverted')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION 'Audit run % has already been reverted', p_audit_id;
  END IF;

  v_snapshot := v_audit.details -> 'revert_snapshot';
  IF v_snapshot IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No snapshot found for this audit run.');
  END IF;

  FOR v_m IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot -> 'deleted_mappings', '[]'::jsonb))
  LOOP
    INSERT INTO item_mappings (item_name, adjusted_item_name, mapping, second_mapping)
    VALUES (
      v_m ->> 'item_name',
      v_m ->> 'adjusted_item_name',
      v_m ->> 'mapping',
      v_m ->> 'second_mapping'
    )
    ON CONFLICT DO NOTHING;
    v_restored_m := v_restored_m + 1;
  END LOOP;

  FOR v_f IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot -> 'deleted_fixes', '[]'::jsonb))
  LOOP
    INSERT INTO manual_fixes (reference_number, correct_id, item_name, mapping, second_mapping)
    VALUES (
      v_f ->> 'reference_number',
      v_f ->> 'correct_id',
      v_f ->> 'item_name',
      v_f ->> 'mapping',
      v_f ->> 'second_mapping'
    )
    ON CONFLICT DO NOTHING;
    v_restored_f := v_restored_f + 1;
  END LOOP;

  UPDATE audit_logs
  SET details = jsonb_set(details, '{is_reverted}', 'true'::jsonb, true)
  WHERE id = p_audit_id;

  BEGIN
    v_email := NULLIF(auth.jwt() ->> 'email', '');
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  v_email := COALESCE(v_email, 'admin@nu.edu.eg');

  INSERT INTO audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_email,
    'Database Hygiene Rollback',
    'Audit #' || p_audit_id,
    jsonb_build_object(
      'target_audit_id', p_audit_id,
      'restored_mappings', v_restored_m,
      'restored_fixes', v_restored_f,
      'reverted_at', now()
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'audit_id', p_audit_id,
    'restored_mappings', v_restored_m,
    'restored_fixes', v_restored_f,
    'message', 'Successfully restored ' || v_restored_m || ' mapping rules and ' || v_restored_f || ' manual fixes.'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rollback_database_hygiene_audit(bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rollback_database_hygiene_audit(bigint) TO authenticated, service_role;

-- 19. Double-Payment & Anomaly Detector RPC
DROP FUNCTION IF EXISTS public.detect_double_payments(integer);
CREATE OR REPLACE FUNCTION public.detect_double_payments(p_days_window integer DEFAULT 3)
RETURNS TABLE(
  student_id text,
  student_name text,
  faculty text,
  item_name text,
  mapping text,
  item_price numeric,
  occurrences bigint,
  total_amount numeric,
  first_date date,
  last_date date,
  reference_numbers text[],
  banks text[],
  settled_flags boolean[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH valid_tx AS (
    SELECT
      t.id,
      t.student_id,
      t.item_name,
      t.mapping,
      t.item_price,
      t.payment_date,
      t.reference_number,
      t.bank,
      COALESCE(t.is_settled, false) AS is_settled
    FROM public.transactions t
    WHERE t.id_status = 'Valid'
      AND t.student_id IS NOT NULL
      AND t.student_id <> ''
      AND COALESCE(t.item_price, 0) > 0
      AND t.payment_date IS NOT NULL
      AND LOWER(BTRIM(COALESCE(t.mapping, ''))) = 'tuition'
  ),
  grouped AS (
    SELECT
      v.student_id,
      COALESCE(NULLIF(v.item_name, ''), 'Unknown') AS item_name,
      COALESCE(NULLIF(v.mapping, ''), 'Tuition') AS mapping,
      v.item_price,
      COUNT(DISTINCT v.reference_number) AS ref_count,
      SUM(v.item_price) AS total_amount,
      MIN(v.payment_date) AS first_date,
      MAX(v.payment_date) AS last_date,
      ARRAY_AGG(v.reference_number::text ORDER BY v.payment_date DESC, v.id DESC) AS reference_numbers,
      ARRAY_AGG(v.bank::text ORDER BY v.payment_date DESC, v.id DESC) AS banks,
      ARRAY_AGG(v.is_settled ORDER BY v.payment_date DESC, v.id DESC) AS settled_flags
    FROM valid_tx v
    GROUP BY v.student_id, COALESCE(NULLIF(v.item_name, ''), 'Unknown'), COALESCE(NULLIF(v.mapping, ''), 'Tuition'), v.item_price
    HAVING COUNT(DISTINCT v.reference_number) > 1
       AND (MAX(v.payment_date) - MIN(v.payment_date)) <= GREATEST(0, p_days_window)
  )
  SELECT
    g.student_id,
    COALESCE(sm.full_name, sm.arabic_name, '-') AS student_name,
    COALESCE(sm.college, '-') AS faculty,
    g.item_name,
    g.mapping,
    g.item_price,
    g.ref_count AS occurrences,
    g.total_amount,
    g.first_date,
    g.last_date,
    g.reference_numbers,
    g.banks,
    g.settled_flags
  FROM grouped g
  LEFT JOIN public.student_master sm ON sm.student_id = g.student_id
  ORDER BY g.last_date DESC, g.total_amount DESC
  LIMIT 500;
$function$;

GRANT EXECUTE ON FUNCTION public.detect_double_payments(integer) TO authenticated;

-- 20. Point-in-Time Audit Log Action Reversion RPC
CREATE OR REPLACE FUNCTION public.revert_audit_log_entry(p_audit_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_audit RECORD;
  v_author_role TEXT;
  v_revert JSONB;
  v_table TEXT;
  v_op TEXT;
  v_row JSONB;
  v_batch TEXT;
  v_restored INTEGER := 0;
  v_updated_batch INTEGER := 0;
  v_updated_foreign_batch INTEGER := 0;
  v_email TEXT;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Access denied: admin role required to revert audit log entries';
  END IF;

  SELECT * INTO v_audit FROM public.audit_logs WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log entry #% not found', p_audit_id;
  END IF;

  IF (v_audit.details ->> 'is_reverted')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION 'Audit log entry #% has already been reverted', p_audit_id;
  END IF;

  -- Delegate Database Hygiene Audit to its dedicated rollback RPC
  IF v_audit.action = 'Database Hygiene Audit' THEN
    RETURN public.rollback_database_hygiene_audit(p_audit_id);
  END IF;

  -- Verify the author of the audit log had at least accountant privileges (or was system/admin)
  IF LOWER(TRIM(COALESCE(v_audit.user_email, ''))) NOT IN ('system@nu.edu.eg', 'ammahmoud@nu.edu.eg') THEN
    SELECT role INTO v_author_role
    FROM public.user_roles
    WHERE LOWER(TRIM(email)) = LOWER(TRIM(v_audit.user_email))
    LIMIT 1;

    IF public.role_level(COALESCE(v_author_role, 'viewer')) < public.role_level('accountant') THEN
      RAISE EXCEPTION 'Security block: cannot execute revert_data authored by non-accountant user (%)', v_audit.user_email;
    END IF;
  END IF;

  v_revert := v_audit.details -> 'revert_data';
  IF v_revert IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'No point-in-time revert snapshot is attached to this audit log entry.'
    );
  END IF;

  v_table := COALESCE(v_revert ->> 'table_name', '');
  v_op := COALESCE(v_revert ->> 'operation', '');

  IF v_table = 'item_mappings' THEN
    IF v_op IN ('delete', 'update') THEN
      FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'previous_rows', '[]'::jsonb))
      LOOP
        DELETE FROM public.item_mappings WHERE item_name = (v_row ->> 'item_name');
        INSERT INTO public.item_mappings (item_name, adjusted_item_name, mapping, second_mapping)
        VALUES (
          v_row ->> 'item_name',
          v_row ->> 'adjusted_item_name',
          v_row ->> 'mapping',
          v_row ->> 'second_mapping'
        );
        v_restored := v_restored + 1;
      END LOOP;
    ELSIF v_op = 'insert' THEN
      FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'inserted_keys', '[]'::jsonb))
      LOOP
        DELETE FROM public.item_mappings WHERE item_name = (v_row #>> '{}');
        v_restored := v_restored + 1;
      END LOOP;
    END IF;

  ELSIF v_table = 'manual_fixes' THEN
    IF v_op IN ('delete', 'update') THEN
      FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'previous_rows', '[]'::jsonb))
      LOOP
        DELETE FROM public.manual_fixes WHERE reference_number = (v_row ->> 'reference_number');
        INSERT INTO public.manual_fixes (reference_number, correct_id, item_name, mapping, second_mapping)
        VALUES (
          v_row ->> 'reference_number',
          v_row ->> 'correct_id',
          v_row ->> 'item_name',
          v_row ->> 'mapping',
          v_row ->> 'second_mapping'
        );
        v_restored := v_restored + 1;
      END LOOP;
    ELSIF v_op = 'insert' THEN
      FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'inserted_keys', '[]'::jsonb))
      LOOP
        DELETE FROM public.manual_fixes WHERE reference_number = (v_row #>> '{}');
        v_restored := v_restored + 1;
      END LOOP;
    END IF;

  ELSIF v_table = 'transactions_erp' THEN
    FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'previous_rows', '[]'::jsonb))
    LOOP
      UPDATE public.transactions
      SET
        erp_batch_number = NULLIF(v_row ->> 'erp_batch_number', ''),
        erp_voucher = NULLIF(v_row ->> 'erp_voucher', '')
      WHERE id = (v_row ->> 'id')::BIGINT;
      v_restored := v_restored + 1;
    END LOOP;

    v_batch := NULLIF(BTRIM(COALESCE(v_revert ->> 'batch_number', '')), '');
    IF v_batch IS NOT NULL THEN
      WITH cleared AS (
        UPDATE public.transactions
        SET erp_batch_number = NULL, erp_voucher = NULL
        WHERE erp_batch_number = v_batch
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_updated_batch FROM cleared;

      WITH cleared_fx AS (
        UPDATE public.foreign_transactions
        SET erp_batch_number = NULL, erp_voucher = NULL
        WHERE erp_batch_number = v_batch
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_updated_foreign_batch FROM cleared_fx;

      v_restored := GREATEST(v_restored, v_restored + v_updated_batch + v_updated_foreign_batch);
    END IF;

  ELSIF v_table = 'foreign_transactions_erp' THEN
    FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_revert -> 'previous_rows', '[]'::jsonb))
    LOOP
      UPDATE public.foreign_transactions
      SET
        erp_batch_number = NULLIF(v_row ->> 'erp_batch_number', ''),
        erp_voucher = NULLIF(v_row ->> 'erp_voucher', '')
      WHERE reference_number = (v_row ->> 'reference_number');
      v_restored := v_restored + 1;
    END LOOP;

    v_batch := NULLIF(BTRIM(COALESCE(v_revert ->> 'batch_number', '')), '');
    IF v_batch IS NOT NULL THEN
      WITH cleared_fx AS (
        UPDATE public.foreign_transactions
        SET erp_batch_number = NULL, erp_voucher = NULL
        WHERE erp_batch_number = v_batch
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_updated_foreign_batch FROM cleared_fx;
      v_restored := GREATEST(v_restored, v_restored + v_updated_foreign_batch);
    END IF;

  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Unsupported revert table: ' || v_table
    );
  END IF;

  UPDATE public.audit_logs
  SET details = jsonb_set(COALESCE(details, '{}'::jsonb), '{is_reverted}', 'true'::jsonb, true)
  WHERE id = p_audit_id;

  BEGIN
    v_email := NULLIF(auth.jwt() ->> 'email', '');
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  v_email := COALESCE(v_email, 'admin@nu.edu.eg');

  INSERT INTO public.audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_email,
    'Audit Action Reverted',
    'Audit #' || p_audit_id,
    jsonb_build_object(
      'reverted_audit_id', p_audit_id,
      'reverted_action', v_audit.action,
      'table_name', v_table,
      'operation', v_op,
      'restored_count', v_restored,
      'reverted_at', NOW()
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'audit_id', p_audit_id,
    'restored_count', v_restored,
    'message', 'Successfully reverted Audit #' || p_audit_id || ' (' || v_restored || ' record(s) restored).'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.revert_audit_log_entry(bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.revert_audit_log_entry(bigint) TO authenticated;

-- 21. Single-Scan Dashboard Summary RPC (combines Pivot + KPI counts + Category breakdown)
CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  start_date DATE,
  end_date DATE,
  group_col TEXT DEFAULT 'date',
  banks TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_group_col TEXT := LOWER(BTRIM(COALESCE(group_col, 'date')));
  v_kpis JSONB;
  v_pivot JSONB;
  v_categories JSONB;
BEGIN
  IF v_group_col NOT IN ('date', 'mapping', 'second_mapping', 'item_name') THEN
    RAISE EXCEPTION 'Invalid group_col for dashboard summary: %', group_col;
  END IF;

  WITH filtered AS (
    SELECT
      t.payment_date,
      t.bank,
      COALESCE(t.item_price, 0) AS item_price,
      t.mapping,
      t.second_mapping,
      t.item_name,
      t.id_status,
      COALESCE(t.is_settled, false) AS is_settled,
      t.erp_batch_number
    FROM public.transactions t
    WHERE t.payment_date >= start_date
      AND t.payment_date <= end_date
      AND (banks IS NULL OR CARDINALITY(banks) = 0 OR t.bank = ANY(banks))
  ),
  kpis_agg AS (
    SELECT
      COUNT(*)::BIGINT AS total_count,
      COUNT(*) FILTER (WHERE id_status = 'Valid')::BIGINT AS valid_count,
      COUNT(*) FILTER (WHERE is_settled = true)::BIGINT AS settled_count,
      COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(erp_batch_number, '')), '') IS NOT NULL)::BIGINT AS erp_count,
      COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(mapping, '')), '') IS NULL)::BIGINT AS unmapped_count
    FROM filtered
  ),
  pivot_agg AS (
    SELECT
      CASE v_group_col
        WHEN 'date' THEN payment_date::TEXT
        WHEN 'mapping' THEN COALESCE(NULLIF(mapping, ''), 'Unmapped')::TEXT
        WHEN 'second_mapping' THEN COALESCE(NULLIF(second_mapping, ''), 'Unmapped')::TEXT
        WHEN 'item_name' THEN COALESCE(NULLIF(item_name, ''), 'Unknown Item')::TEXT
      END AS group_key,
      bank::TEXT AS bank,
      COALESCE(SUM(item_price), 0) AS total_amount
    FROM filtered
    GROUP BY 1, 2
    ORDER BY 1, 2
  ),
  cat_agg AS (
    SELECT
      COALESCE(NULLIF(mapping, ''), 'Unmapped')::TEXT AS group_key,
      COALESCE(SUM(item_price), 0) AS total_amount
    FROM filtered
    GROUP BY 1
    ORDER BY 2 DESC
  )
  SELECT
    to_jsonb(kpis_agg),
    COALESCE((SELECT jsonb_agg(to_jsonb(pivot_agg)) FROM pivot_agg), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(cat_agg)) FROM cat_agg), '[]'::jsonb)
  INTO v_kpis, v_pivot, v_categories
  FROM kpis_agg;

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'pivot', v_pivot,
    'categories', v_categories
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(DATE, DATE, TEXT, TEXT[]) TO authenticated;
