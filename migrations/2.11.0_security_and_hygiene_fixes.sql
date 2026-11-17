-- Migration 2.11.0: security & data-safety fixes from the 2026-11 code review
--
-- Run in the Supabase SQL editor AFTER 2.10.0. Safe to run more than once.
--
--  1. Default-deny: a signed-in account with no user_roles row gets NO access
--     (was: silently treated as 'viewer' and could read all transactions / student PII).
--     New sign-ups outside @nu.edu.eg are created inactive and must be activated by an admin.
--  2. sync_auth_users(): admin / automation only (2.6.0 removed the check), not callable by anon.
--  3. audit_logs: attach the secure_audit_log_insert() trigger, so user_email can no longer
--     be forged and non-accountants cannot attach revert_data (it was defined but never attached).
--  4. SELECT policies: every table requires an ACTIVE viewer (wrapped in SELECT so it is
--     evaluated once per query, restoring the 2.5.0 optimisation that 2.6.0 dropped).
--     foreign_transactions / exchange_rates / settlement_batches / user_roles were USING (true).
--  5. Nightly hygiene no longer deletes mapping rules that differ only in letter case but map
--     differently: only rows whose mapping columns are identical count as duplicates.
--
-- ALSO REQUIRED (dashboard, not SQL): Supabase -> Authentication -> Sign In / Providers ->
-- turn OFF "Allow new users to sign up". Create staff accounts from the dashboard instead.

-- ---------------------------------------------------------------------------
-- 1. Default-deny role resolution
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email     TEXT;
  v_role      TEXT;
  v_is_active BOOLEAN;
BEGIN
  v_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'none';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RETURN 'admin';
  END IF;

  SELECT role, COALESCE(is_active, TRUE)
  INTO v_role, v_is_active
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 'none';            -- no row => no access (role_level('none') = 0)
  END IF;
  IF v_is_active IS FALSE THEN
    RETURN 'deactivated';
  END IF;

  RETURN COALESCE(v_role, 'none');
END;
$$;

CREATE OR REPLACE FUNCTION public.role_level(r TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE LOWER(COALESCE(r, 'none'))
    WHEN 'admin' THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'operator' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
  END;
$$;

-- New auth users: NU staff become active viewers; anyone else is created INACTIVE.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT := LOWER(TRIM(COALESCE(NEW.email, '')));
BEGIN
  IF v_email <> '' THEN
    INSERT INTO public.user_roles (email, role, is_active, updated_by, updated_at)
    VALUES (
      v_email,
      CASE WHEN v_email = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      (v_email LIKE '%@nu.edu.eg'),
      'auth.signup',
      NOW()
    )
    ON CONFLICT (email) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. sync_auth_users(): admin / automation only
-- ---------------------------------------------------------------------------
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
  -- NOTE: not is_admin_or_automation(): inside a SECURITY DEFINER function current_user is the
  -- function owner (postgres), so that helper's current_user check would let everyone through.
  IF NOT (
       public.has_min_role('admin')
       OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
       OR session_user IN ('postgres', 'supabase_admin')
     ) THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  WITH ins AS (
    INSERT INTO public.user_roles (email, role, is_active, updated_by, updated_at)
    SELECT
      LOWER(TRIM(u.email)),
      CASE WHEN LOWER(TRIM(u.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      -- non-NU accounts are added inactive (admin must activate them)
      (u.banned_until IS NULL OR u.banned_until <= NOW()) AND LOWER(TRIM(u.email)) LIKE '%@nu.edu.eg',
      'auth.users sync',
      NOW()
    FROM auth.users u
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ON CONFLICT (email) DO UPDATE SET
      -- Only mirror an auth ban onto an existing row; never re-activate a user an admin
      -- deactivated in the app.
      is_active = CASE
        WHEN LOWER(TRIM(public.user_roles.email)) = 'ammahmoud@nu.edu.eg' THEN TRUE
        WHEN EXCLUDED.is_active IS FALSE AND public.user_roles.is_active IS TRUE
             AND EXISTS (SELECT 1 FROM auth.users b
                         WHERE LOWER(TRIM(b.email)) = LOWER(TRIM(public.user_roles.email))
                           AND b.banned_until > NOW()) THEN FALSE
        ELSE public.user_roles.is_active
      END
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  SELECT COUNT(*) INTO v_total FROM public.user_roles;
  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_auth_users() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.sync_auth_users() TO authenticated, service_role;

-- Admin RPCs check the role internally, but should not be callable anonymously either.
DO $$
BEGIN
  IF to_regprocedure('public.admin_set_user_active(text, boolean)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.admin_set_user_active(TEXT, BOOLEAN) FROM public, anon;
  END IF;
  IF to_regprocedure('public.admin_delete_user(text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.admin_delete_user(TEXT) FROM public, anon;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Attach the audit-log guard trigger (function defined in 2.4.0)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_secure_audit_log_insert ON public.audit_logs;
CREATE TRIGGER trg_secure_audit_log_insert
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.secure_audit_log_insert();

-- ---------------------------------------------------------------------------
-- 4. SELECT policies: active viewer or higher, evaluated once per statement
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transactions', 'links', 'item_mappings', 'manual_fixes',
    'student_master', 'payment_links', 'import_batches', 'audit_logs',
    'settlement_batches'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS rbac_select ON public.%I', tbl);
      EXECUTE format('CREATE POLICY rbac_select ON public.%I FOR SELECT TO authenticated USING ((SELECT public.has_min_role(''viewer'')))', tbl);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS foreign_tx_select ON public.foreign_transactions;
CREATE POLICY foreign_tx_select ON public.foreign_transactions
  FOR SELECT TO authenticated USING ((SELECT public.has_min_role('viewer')));

DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
CREATE POLICY exchange_rates_select ON public.exchange_rates
  FOR SELECT TO authenticated USING ((SELECT public.has_min_role('viewer')));

-- Users can always read their OWN role row (so the app can show "deactivated"/"no access"),
-- viewers and above can read the list.
DROP POLICY IF EXISTS user_roles_select ON public.user_roles;
CREATE POLICY user_roles_select ON public.user_roles
  FOR SELECT TO authenticated USING (
    (SELECT public.has_min_role('viewer'))
    OR LOWER(TRIM(email)) = (SELECT LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', ''))))
  );

-- ---------------------------------------------------------------------------
-- 5. Hygiene: only delete mapping rows that are true duplicates
-- ---------------------------------------------------------------------------
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
  v_conflicting_mappings INTEGER;
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

  -- True duplicates: same name ignoring case/spaces AND the same mapping values.
  SELECT COALESCE(sum(c - 1), 0) INTO v_dup_mappings
  FROM (
    SELECT count(*) as c
    FROM item_mappings
    GROUP BY LOWER(TRIM(item_name)),
             COALESCE(adjusted_item_name, ''), COALESCE(mapping, ''), COALESCE(second_mapping, '')
    HAVING count(*) > 1
  ) s;

  -- Case variants that map DIFFERENTLY: reported for a human to resolve, never auto-deleted.
  SELECT COALESCE(count(*), 0) INTO v_conflicting_mappings
  FROM (
    SELECT 1
    FROM item_mappings
    GROUP BY LOWER(TRIM(item_name))
    HAVING count(DISTINCT (COALESCE(adjusted_item_name, ''), COALESCE(mapping, ''), COALESCE(second_mapping, ''))) > 1
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
      SELECT id, ROW_NUMBER() OVER (
               PARTITION BY LOWER(TRIM(item_name)),
                            COALESCE(adjusted_item_name, ''), COALESCE(mapping, ''), COALESCE(second_mapping, '')
               ORDER BY id ASC) as rn
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
      'conflicting_case_mappings', v_conflicting_mappings,
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
    'conflicting_case_mappings', v_conflicting_mappings,
    'duplicate_fixes', v_dup_fixes,
    'cleaned_mappings', v_cleaned_mappings,
    'cleaned_fixes', v_cleaned_fixes,
    'auto_cleaned', p_clean
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.run_database_hygiene_audit(boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.run_database_hygiene_audit(boolean) TO authenticated, service_role;
