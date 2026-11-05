-- ============================================================================
-- Migration 2.4.0: Critical Security Hardening, Index Optimization & New Features
-- ============================================================================

-- 1. DROP LEGACY & PUBLIC PERMISSIVE RLS POLICIES
-- (Eliminates unauthenticated public access and ensures 4-tier RBAC is enforced)

-- audit_logs
DROP POLICY IF EXISTS "Allow authenticated insert audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Allow authenticated read audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Auth Insert Audit Logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Auth Select Audit Logs" ON public.audit_logs;
DROP POLICY IF EXISTS "rbac_update" ON public.audit_logs;
CREATE POLICY "rbac_update" ON public.audit_logs
  FOR UPDATE TO authenticated
  USING (public.has_min_role('admin'))
  WITH CHECK (public.has_min_role('admin'));

-- import_batches
DROP POLICY IF EXISTS "Auth Full Access Batches" ON public.import_batches;
DROP POLICY IF EXISTS "Enable insert for all users" ON public.import_batches;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.import_batches;
DROP POLICY IF EXISTS "Enable update for all users" ON public.import_batches;

-- item_mappings
DROP POLICY IF EXISTS "Allow authenticated delete item_mappings" ON public.item_mappings;
DROP POLICY IF EXISTS "Allow authenticated insert item_mappings" ON public.item_mappings;
DROP POLICY IF EXISTS "Allow authenticated read item_mappings" ON public.item_mappings;
DROP POLICY IF EXISTS "Allow authenticated update item_mappings" ON public.item_mappings;
DROP POLICY IF EXISTS "Auth Full Access Mappings" ON public.item_mappings;

-- links
DROP POLICY IF EXISTS "Allow authenticated delete links" ON public.links;
DROP POLICY IF EXISTS "Allow authenticated insert links" ON public.links;
DROP POLICY IF EXISTS "Allow authenticated read links" ON public.links;
DROP POLICY IF EXISTS "Allow authenticated update links" ON public.links;
DROP POLICY IF EXISTS "Auth Full Access Links" ON public.links;

-- manual_fixes
DROP POLICY IF EXISTS "Allow authenticated delete manual_fixes" ON public.manual_fixes;
DROP POLICY IF EXISTS "Allow authenticated insert manual_fixes" ON public.manual_fixes;
DROP POLICY IF EXISTS "Allow authenticated read manual_fixes" ON public.manual_fixes;
DROP POLICY IF EXISTS "Allow authenticated update manual_fixes" ON public.manual_fixes;
DROP POLICY IF EXISTS "Auth Full Access Fixes" ON public.manual_fixes;

-- payment_links
DROP POLICY IF EXISTS "Allow public delete access on payment_links" ON public.payment_links;
DROP POLICY IF EXISTS "Allow public insert access on payment_links" ON public.payment_links;
DROP POLICY IF EXISTS "Allow public read access on payment_links" ON public.payment_links;
DROP POLICY IF EXISTS "Allow public update access on payment_links" ON public.payment_links;
DROP POLICY IF EXISTS "Auth Full Access PaymentLinks" ON public.payment_links;

-- student_master
DROP POLICY IF EXISTS "Allow authenticated delete student_master" ON public.student_master;
DROP POLICY IF EXISTS "Allow authenticated insert student_master" ON public.student_master;
DROP POLICY IF EXISTS "Allow authenticated read student_master" ON public.student_master;
DROP POLICY IF EXISTS "Allow authenticated update student_master" ON public.student_master;
DROP POLICY IF EXISTS "Auth Full Access Students" ON public.student_master;

-- transactions
DROP POLICY IF EXISTS "Allow authenticated delete transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow authenticated insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow authenticated read transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow authenticated update transactions" ON public.transactions;
DROP POLICY IF EXISTS "Auth Full Access Transactions" ON public.transactions;

-- user_roles (split ALL policy into INSERT/UPDATE/DELETE so SELECT has only 1 policy)
DROP POLICY IF EXISTS "user_roles_admin_write" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_insert" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_update" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_delete" ON public.user_roles;

CREATE POLICY "user_roles_insert" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role('admin'));

CREATE POLICY "user_roles_update" ON public.user_roles
  FOR UPDATE TO authenticated
  USING (public.has_min_role('admin'))
  WITH CHECK (public.has_min_role('admin'));

CREATE POLICY "user_roles_delete" ON public.user_roles
  FOR DELETE TO authenticated
  USING (public.has_min_role('admin'));


-- ============================================================================
-- 2. FIX FUNCTION SEARCH_PATH & HARDEN SECURITY DEFINER FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.role_level(r text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT CASE LOWER(COALESCE(r, 'viewer'))
    WHEN 'admin' THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'operator' THEN 2
    ELSE 1
  END;
$function$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_email TEXT;
  v_role  TEXT;
BEGIN
  v_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'viewer';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RETURN 'admin';
  END IF;

  SELECT role INTO v_role
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  RETURN COALESCE(v_role, 'viewer');
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_min_role(required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT public.role_level(public.current_user_role()) >= public.role_level(required_role);
$function$;

CREATE OR REPLACE FUNCTION public.pivot_summary(date_from date, date_to date)
RETURNS TABLE(payment_date date, bank text, total numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT payment_date, bank, SUM(item_price)
  FROM public.transactions
  WHERE payment_date BETWEEN date_from AND date_to
  GROUP BY payment_date, bank
  ORDER BY payment_date;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard_pivot(start_date date, end_date date)
RETURNS TABLE(payment_date date, bank text, daily_total numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT
    payment_date,
    bank,
    SUM(item_price) as daily_total
  FROM public.transactions
  WHERE payment_date >= start_date AND payment_date <= end_date
  GROUP BY payment_date, bank;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard_pivot_by(start_date date, end_date date, group_col text)
RETURNS TABLE(group_key text, bank character varying, total_amount numeric)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
BEGIN
  IF group_col = 'date' THEN
    RETURN QUERY
      SELECT t.payment_date::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM public.transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY t.payment_date, t.bank
      ORDER BY t.payment_date, t.bank;
  ELSIF group_col = 'mapping' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.mapping, ''), 'Unmapped')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM public.transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSIF group_col = 'second_mapping' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.second_mapping, ''), 'Unmapped')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM public.transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSIF group_col = 'item_name' THEN
    RETURN QUERY
      SELECT COALESCE(NULLIF(t.item_name, ''), 'Unknown Item')::TEXT AS group_key, t.bank, COALESCE(SUM(t.item_price), 0) AS total_amount
      FROM public.transactions t
      WHERE t.payment_date >= start_date AND t.payment_date <= end_date
      GROUP BY 1, t.bank
      ORDER BY 1, t.bank;
  ELSE
    RAISE EXCEPTION 'Invalid group_col for dashboard pivot: %', group_col;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.secure_audit_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  NEW.user_email := COALESCE(
    (SELECT email FROM auth.users WHERE id = auth.uid()),
    NEW.user_email,
    'system@nu.edu.eg'
  );
  RETURN NEW;
END;
$function$;

-- Helper to authorize either an authenticated Admin or an authorized Automation Job
CREATE OR REPLACE FUNCTION public.is_admin_or_automation()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_token TEXT;
BEGIN
  IF public.has_min_role('admin') THEN
    RETURN true;
  END IF;
  BEGIN
    v_token := COALESCE(current_setting('request.headers', true)::jsonb ->> 'x-fawry-automation-token', '');
  EXCEPTION WHEN OTHERS THEN
    v_token := '';
  END;
  RETURN v_token = 'fawry-cron-sec-2026-nu';
END;
$function$;

-- Harden sync_auth_users (Admin only)
CREATE OR REPLACE FUNCTION public.sync_auth_users()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_inserted INTEGER := 0;
  v_total    INTEGER := 0;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

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

  SELECT COUNT(*) INTO v_total FROM public.user_roles;
  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$function$;

-- Harden backup RPCs with admin / automation check
CREATE OR REPLACE FUNCTION public.export_database_backup_payload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_mappings JSONB;
  v_fixes JSONB;
  v_roles JSONB;
  v_audit JSONB;
  v_tx_summary JSONB;
BEGIN
  IF NOT public.is_admin_or_automation() THEN
    RAISE EXCEPTION 'Unauthorized backup request';
  END IF;

  SELECT jsonb_agg(to_jsonb(m)) INTO v_mappings FROM (SELECT * FROM item_mappings ORDER BY item_name) m;
  SELECT jsonb_agg(to_jsonb(f)) INTO v_fixes FROM (SELECT * FROM manual_fixes ORDER BY reference_number) f;
  SELECT jsonb_agg(to_jsonb(r)) INTO v_roles FROM (SELECT * FROM user_roles ORDER BY email) r;
  SELECT jsonb_agg(to_jsonb(a)) INTO v_audit FROM (SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500) a;

  SELECT jsonb_agg(to_jsonb(s)) INTO v_tx_summary FROM (
    SELECT
      DATE_TRUNC('month', payment_date::date)::date as month,
      count(*) as total_transactions,
      count(*) FILTER (WHERE is_settled = true) as settled_transactions,
      sum(item_price) as total_amount,
      sum(net_amount) as total_net_amount
    FROM transactions
    WHERE payment_date IS NOT NULL
    GROUP BY DATE_TRUNC('month', payment_date::date)::date
    ORDER BY month DESC
  ) s;

  RETURN jsonb_build_object(
    'exported_at', NOW(),
    'version', '2.4.0',
    'mappings_count', jsonb_array_length(COALESCE(v_mappings, '[]'::jsonb)),
    'fixes_count', jsonb_array_length(COALESCE(v_fixes, '[]'::jsonb)),
    'roles_count', jsonb_array_length(COALESCE(v_roles, '[]'::jsonb)),
    'mappings', COALESCE(v_mappings, '[]'::jsonb),
    'manual_fixes', COALESCE(v_fixes, '[]'::jsonb),
    'user_roles', COALESCE(v_roles, '[]'::jsonb),
    'audit_logs', COALESCE(v_audit, '[]'::jsonb),
    'transactions_monthly_summary', COALESCE(v_tx_summary, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_students_backup_chunk(p_offset integer, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT public.is_admin_or_automation() THEN
    RAISE EXCEPTION 'Unauthorized backup request';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
    FROM (
      SELECT *
      FROM student_master
      ORDER BY student_id
      OFFSET p_offset
      LIMIT p_limit
    ) s
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_transactions_backup_chunk(p_offset integer, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT public.is_admin_or_automation() THEN
    RAISE EXCEPTION 'Unauthorized backup request';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    FROM (
      SELECT *
      FROM transactions
      ORDER BY id
      OFFSET p_offset
      LIMIT p_limit
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_database_hygiene_audit(p_clean boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.rollback_database_hygiene_audit(p_audit_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

-- Revoke public/anon execution on trigger functions and admin-only functions
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.secure_audit_log_insert() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_auth_users() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sync_auth_users() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.rollback_database_hygiene_audit(bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rollback_database_hygiene_audit(bigint) TO authenticated;


-- ============================================================================
-- 3. DROP DUPLICATE INDEXES & ADD COMPOSITE PERFORMANCE INDEXES
-- ============================================================================

DROP INDEX IF EXISTS public.idx_links_payment_ref;
DROP INDEX IF EXISTS public.idx_links_reference;
DROP INDEX IF EXISTS public.idx_transactions_student;
DROP INDEX IF EXISTS public.idx_student_master_id;

CREATE INDEX IF NOT EXISTS idx_transactions_date_bank ON public.transactions (payment_date, bank);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON public.transactions (batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_id_status ON public.transactions (id_status);
CREATE INDEX IF NOT EXISTS idx_transactions_is_settled ON public.transactions (is_settled);


-- ============================================================================
-- 4. FEATURE: PERSISTENT SETTLEMENT RECONCILIATION HISTORY TABLE
-- ============================================================================

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
  WITH CHECK (public.has_min_role('operator'));

CREATE POLICY "rbac_update" ON public.settlement_batches
  FOR UPDATE TO authenticated
  USING (public.has_min_role('accountant'))
  WITH CHECK (public.has_min_role('accountant'));

CREATE POLICY "rbac_delete" ON public.settlement_batches
  FOR DELETE TO authenticated
  USING (public.has_min_role('admin'));


-- ============================================================================
-- 5. FEATURE: DOUBLE-PAYMENT & ANOMALY DETECTOR RPC
-- ============================================================================

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


-- ============================================================================
-- 6. FEATURE: UNIVERSAL AUDIT LOG UNDO (POINT-IN-TIME ROLLBACK RPC)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revert_audit_log_entry(p_audit_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_audit RECORD;
  v_revert JSONB;
  v_table TEXT;
  v_op TEXT;
  v_row JSONB;
  v_restored INTEGER := 0;
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
