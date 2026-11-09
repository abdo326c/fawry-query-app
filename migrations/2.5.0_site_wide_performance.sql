-- ============================================================================
-- Migration 2.5.0: Site-Wide Performance Optimization (Indexes, Trigram Search & RLS InitPlan)
-- ============================================================================

-- 1. Enable pg_trgm extension for fast ILIKE '%...%' substring searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Restore & Add B-Tree Indexes for Exact Lookups, Joins, Sorting & Filtering
CREATE INDEX IF NOT EXISTS idx_transactions_student ON public.transactions (student_id);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON public.transactions (reference_number);
CREATE INDEX IF NOT EXISTS idx_transactions_item_name ON public.transactions (item_name);
CREATE INDEX IF NOT EXISTS idx_transactions_mapping ON public.transactions (mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_second_mapping ON public.transactions (second_mapping);
CREATE INDEX IF NOT EXISTS idx_transactions_erp_batch ON public.transactions (erp_batch_number);
CREATE INDEX IF NOT EXISTS idx_transactions_settlement_batch ON public.transactions (settlement_batch);
CREATE INDEX IF NOT EXISTS idx_transactions_date_id ON public.transactions (payment_date ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_transactions_date_bank ON public.transactions (payment_date, bank);
CREATE INDEX IF NOT EXISTS idx_transactions_batch_id ON public.transactions (batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_id_status ON public.transactions (id_status);
CREATE INDEX IF NOT EXISTS idx_transactions_is_settled ON public.transactions (is_settled);

CREATE INDEX IF NOT EXISTS idx_student_master_nat_id ON public.student_master (national_id);
CREATE INDEX IF NOT EXISTS idx_student_master_email_lower ON public.student_master (LOWER(BTRIM(email)));
CREATE INDEX IF NOT EXISTS idx_student_master_college ON public.student_master (college);

CREATE INDEX IF NOT EXISTS idx_user_roles_email_lower ON public.user_roles (LOWER(BTRIM(email)));

-- 3. Add GIN Trigram Indexes for Substring (ILIKE '%...%') Searches
CREATE INDEX IF NOT EXISTS idx_transactions_ref_trgm ON public.transactions USING gin (reference_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_student_trgm ON public.transactions USING gin (student_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_mobile_trgm ON public.transactions USING gin (customer_mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_item_trgm ON public.transactions USING gin (item_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_transactions_check_col_trgm ON public.transactions USING gin (check_column gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_student_master_name_trgm ON public.student_master USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_mobile_trgm ON public.student_master USING gin (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_gmobile_trgm ON public.student_master USING gin (guardian_mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_email_trgm ON public.student_master USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_student_master_natid_trgm ON public.student_master USING gin (national_id gin_trgm_ops);

-- 4. Optimize RLS Helper Functions & Policies with (SELECT public.has_min_role(...)) InitPlan Caching
-- Wrapping has_min_role() in a scalar subquery causes PostgreSQL to evaluate the user's role
-- ONCE per SQL statement (InitPlan) instead of evaluating it per row during bulk upserts/updates.

CREATE OR REPLACE FUNCTION public.role_level(r text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
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
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_email TEXT;
  v_role  TEXT;
BEGIN
  v_email := LOWER(BTRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'viewer';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RETURN 'admin';
  END IF;

  SELECT role INTO v_role
  FROM public.user_roles
  WHERE LOWER(BTRIM(email)) = v_email
  LIMIT 1;

  RETURN COALESCE(v_role, 'viewer');
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_min_role(required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT public.role_level(public.current_user_role()) >= public.role_level(required_role);
$function$;

-- Recreate write policies using (SELECT public.has_min_role(...)) for single-evaluation InitPlan
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transactions', 'links', 'student_master', 'payment_links', 'import_batches'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS rbac_insert ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_update ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_delete ON public.%I', tbl);

    EXECUTE format('CREATE POLICY rbac_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role(''operator'')))', tbl);
    EXECUTE format('CREATE POLICY rbac_update ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.has_min_role(''operator''))) WITH CHECK ((SELECT public.has_min_role(''operator'')))', tbl);
    EXECUTE format('CREATE POLICY rbac_delete ON public.%I FOR DELETE TO authenticated USING ((SELECT public.has_min_role(''admin'')))', tbl);
  END LOOP;

  FOREACH tbl IN ARRAY ARRAY['item_mappings', 'manual_fixes']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS rbac_insert ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_update ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_delete ON public.%I', tbl);

    EXECUTE format('CREATE POLICY rbac_insert ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role(''accountant'')))', tbl);
    EXECUTE format('CREATE POLICY rbac_update ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.has_min_role(''accountant''))) WITH CHECK ((SELECT public.has_min_role(''accountant'')))', tbl);
    EXECUTE format('CREATE POLICY rbac_delete ON public.%I FOR DELETE TO authenticated USING ((SELECT public.has_min_role(''admin'')))', tbl);
  END LOOP;
END $$;

DROP POLICY IF EXISTS rbac_insert ON public.audit_logs;
DROP POLICY IF EXISTS rbac_update ON public.audit_logs;
DROP POLICY IF EXISTS rbac_delete ON public.audit_logs;
CREATE POLICY rbac_insert ON public.audit_logs FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON public.audit_logs FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('admin'))) WITH CHECK ((SELECT public.has_min_role('admin')));
CREATE POLICY rbac_delete ON public.audit_logs FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

DROP POLICY IF EXISTS rbac_insert ON public.settlement_batches;
DROP POLICY IF EXISTS rbac_update ON public.settlement_batches;
DROP POLICY IF EXISTS rbac_delete ON public.settlement_batches;
CREATE POLICY rbac_insert ON public.settlement_batches FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('operator')));
CREATE POLICY rbac_update ON public.settlement_batches FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('accountant'))) WITH CHECK ((SELECT public.has_min_role('accountant')));
CREATE POLICY rbac_delete ON public.settlement_batches FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));

DROP POLICY IF EXISTS user_roles_insert ON public.user_roles;
DROP POLICY IF EXISTS user_roles_update ON public.user_roles;
DROP POLICY IF EXISTS user_roles_delete ON public.user_roles;
CREATE POLICY user_roles_insert ON public.user_roles FOR INSERT TO authenticated WITH CHECK ((SELECT public.has_min_role('admin')));
CREATE POLICY user_roles_update ON public.user_roles FOR UPDATE TO authenticated USING ((SELECT public.has_min_role('admin'))) WITH CHECK ((SELECT public.has_min_role('admin')));
CREATE POLICY user_roles_delete ON public.user_roles FOR DELETE TO authenticated USING ((SELECT public.has_min_role('admin')));
