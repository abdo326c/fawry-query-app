-- Migration 2.11.3: Executive Dashboard Analytics, Table-Driven Primary Admin, & Cold-Storage Archiving
--
-- Safe to run multiple times (idempotent). Run in Supabase SQL editor after 2.11.2.
--
--  1. Table-driven Primary Admin flag (user_roles.is_primary_admin) so admin protection
--     no longer relies solely on hardcoded email literals inside SQL functions.
--  2. Extended get_dashboard_summary() returning UG/PG level revenue mix and
--     immediately preceding period total (MoM / prior-window comparison) in 1 query.
--  3. Cold-storage archiving table (transactions_archive) + Admin-only RPC
--     archive_settled_transactions(p_before_date, p_dry_run DEFAULT true).

-- ---------------------------------------------------------------------------
-- 1. Table-driven Primary Admin flag on public.user_roles
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS is_primary_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.user_roles
SET is_primary_admin = TRUE, role = 'admin', is_active = TRUE
WHERE LOWER(TRIM(email)) = 'ammahmoud@nu.edu.eg';

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email       TEXT;
  v_role        TEXT;
  v_is_active   BOOLEAN;
  v_is_primary  BOOLEAN;
BEGIN
  v_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'none';
  END IF;

  SELECT role, COALESCE(is_active, TRUE), COALESCE(is_primary_admin, FALSE)
  INTO v_role, v_is_active, v_is_primary
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  IF v_is_primary IS TRUE THEN
    RETURN 'admin';
  END IF;
  IF v_is_active IS FALSE THEN
    RETURN 'deactivated';
  END IF;

  RETURN COALESCE(v_role, 'none');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_user_active(target_email TEXT, active BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller      TEXT;
  v_email       TEXT;
  v_user_id     UUID;
  v_ban_until   TIMESTAMPTZ;
  v_is_primary  BOOLEAN := FALSE;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Permission denied: Admin role required';
  END IF;

  v_caller := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', 'Admin')));
  v_email  := LOWER(TRIM(COALESCE(target_email, '')));

  IF v_email = '' OR POSITION('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'Valid target email is required';
  END IF;

  SELECT COALESCE(is_primary_admin, FALSE) INTO v_is_primary
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF v_is_primary IS TRUE AND active = FALSE THEN
    RAISE EXCEPTION 'Primary Admin account cannot be deactivated';
  END IF;
  IF v_email = v_caller AND active = FALSE THEN
    RAISE EXCEPTION 'You cannot deactivate your own active Admin account';
  END IF;

  v_ban_until := CASE WHEN active THEN NULL ELSE '2099-12-31T23:59:59Z'::timestamptz END;

  INSERT INTO public.user_roles (email, role, is_active, updated_by, updated_at)
  VALUES (v_email, 'viewer', active, v_caller, NOW())
  ON CONFLICT (email) DO UPDATE SET
    is_active  = active,
    updated_by = v_caller,
    updated_at = NOW();

  SELECT id INTO v_user_id FROM auth.users WHERE LOWER(TRIM(email)) = v_email LIMIT 1;
  IF v_user_id IS NOT NULL THEN
    UPDATE auth.users SET banned_until = v_ban_until, updated_at = NOW() WHERE id = v_user_id;
    IF active = FALSE THEN
      DELETE FROM auth.sessions WHERE user_id = v_user_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('email', v_email, 'is_active', active, 'auth_user_found', v_user_id IS NOT NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller       TEXT;
  v_email        TEXT;
  v_deleted_auth INTEGER := 0;
  v_is_primary   BOOLEAN := FALSE;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Permission denied: Admin role required';
  END IF;

  v_caller := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', 'Admin')));
  v_email  := LOWER(TRIM(COALESCE(target_email, '')));

  IF v_email = '' OR POSITION('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'Valid target email is required';
  END IF;

  SELECT COALESCE(is_primary_admin, FALSE) INTO v_is_primary
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF v_is_primary IS TRUE THEN
    RAISE EXCEPTION 'Primary Admin account cannot be deleted';
  END IF;
  IF v_email = v_caller THEN
    RAISE EXCEPTION 'You cannot delete your own active Admin account';
  END IF;

  DELETE FROM public.user_roles WHERE LOWER(TRIM(email)) = v_email;
  WITH del AS (
    DELETE FROM auth.users WHERE LOWER(TRIM(email)) = v_email RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted_auth FROM del;

  RETURN jsonb_build_object('email', v_email, 'deleted_auth_users', v_deleted_auth);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_user_active(TEXT, BOOLEAN) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.admin_set_user_active(TEXT, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(TEXT) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.admin_delete_user(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Executive Dashboard Summary RPC (adds UG/PG level split + prior-period delta)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_dashboard_summary(DATE, DATE, TEXT, TEXT[], TEXT);
CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  start_date DATE,
  end_date DATE,
  group_col TEXT DEFAULT 'date',
  banks TEXT[] DEFAULT NULL,
  status_filter TEXT DEFAULT 'all'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_group_col TEXT := LOWER(BTRIM(COALESCE(group_col, 'date')));
  v_status    TEXT := LOWER(BTRIM(COALESCE(status_filter, 'all')));
  v_span_days INTEGER := GREATEST(0, (end_date - start_date));
  v_prev_end  DATE := start_date - 1;
  v_prev_start DATE := (start_date - 1) - GREATEST(0, (end_date - start_date));
  v_kpis JSONB;
  v_pivot JSONB;
  v_categories JSONB;
  v_levels JSONB;
  v_prev_total NUMERIC := 0;
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
      t.erp_batch_number,
      UPPER(BTRIM(COALESCE(t.student_level, ''))) AS student_level
    FROM public.transactions t
    WHERE t.payment_date >= start_date
      AND t.payment_date <= end_date
      AND (banks IS NULL OR CARDINALITY(banks) = 0 OR t.bank = ANY(banks))
      AND (
        v_status = 'all'
        OR (v_status = 'valid' AND (
              t.id_status IN ('Valid', 'Exempt')
              OR COALESCE(t.mapping, '') ~* '\m(dip|diploma|workshops?)\M'
              OR COALESCE(t.second_mapping, '') ~* '\m(dip|diploma|workshops?)\M'
            ))
        OR (v_status = 'invalid' AND (
              COALESCE(t.id_status, '') NOT IN ('Valid', 'Exempt')
              AND COALESCE(t.mapping, '') !~* '\m(dip|diploma|workshops?)\M'
              AND COALESCE(t.second_mapping, '') !~* '\m(dip|diploma|workshops?)\M'
            ))
        OR (v_status = 'settled' AND COALESCE(t.is_settled, false) = true)
        OR (v_status = 'unsettled' AND COALESCE(t.is_settled, false) = false)
        OR (v_status = 'erp_recorded' AND NULLIF(BTRIM(COALESCE(t.erp_batch_number, '')), '') IS NOT NULL)
        OR (v_status = 'erp_unposted' AND NULLIF(BTRIM(COALESCE(t.erp_batch_number, '')), '') IS NULL)
      )
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
  levels_agg AS (
    SELECT
      COALESCE(SUM(item_price) FILTER (WHERE student_level = 'UG'), 0) AS ug_total,
      COUNT(*) FILTER (WHERE student_level = 'UG')::BIGINT AS ug_count,
      COALESCE(SUM(item_price) FILTER (WHERE student_level = 'PG'), 0) AS pg_total,
      COUNT(*) FILTER (WHERE student_level = 'PG')::BIGINT AS pg_count,
      COALESCE(SUM(item_price) FILTER (WHERE student_level NOT IN ('UG', 'PG')), 0) AS other_total,
      COUNT(*) FILTER (WHERE student_level NOT IN ('UG', 'PG'))::BIGINT AS other_count
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
    COALESCE((SELECT jsonb_agg(to_jsonb(cat_agg)) FROM cat_agg), '[]'::jsonb),
    (SELECT to_jsonb(levels_agg) FROM levels_agg)
  INTO v_kpis, v_pivot, v_categories, v_levels
  FROM kpis_agg;

  SELECT COALESCE(SUM(COALESCE(t.item_price, 0)), 0)
  INTO v_prev_total
  FROM public.transactions t
  WHERE t.payment_date >= v_prev_start
    AND t.payment_date <= v_prev_end
    AND (banks IS NULL OR CARDINALITY(banks) = 0 OR t.bank = ANY(banks));

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'pivot', v_pivot,
    'categories', v_categories,
    'levels', v_levels,
    'prev_period', jsonb_build_object(
      'start_date', v_prev_start,
      'end_date', v_prev_end,
      'total_egp', v_prev_total
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(DATE, DATE, TEXT, TEXT[], TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Cold-Storage Archiving Table & Admin RPC (settled + ERP-posted rows only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transactions_archive (
  LIKE public.transactions INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_archive_payment_date ON public.transactions_archive (payment_date);
CREATE INDEX IF NOT EXISTS idx_tx_archive_student_id ON public.transactions_archive (student_id);
CREATE INDEX IF NOT EXISTS idx_tx_archive_reference ON public.transactions_archive (reference_number);

ALTER TABLE public.transactions_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rbac_select ON public.transactions_archive;
CREATE POLICY rbac_select ON public.transactions_archive
  FOR SELECT TO authenticated
  USING ((SELECT public.has_min_role('viewer')));

DROP POLICY IF EXISTS rbac_admin_write ON public.transactions_archive;
CREATE POLICY rbac_admin_write ON public.transactions_archive
  FOR ALL TO authenticated
  USING ((SELECT public.has_min_role('admin')))
  WITH CHECK ((SELECT public.has_min_role('admin')));

CREATE OR REPLACE FUNCTION public.archive_settled_transactions(
  p_before_date DATE,
  p_dry_run BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_email TEXT;
  v_eligible_count BIGINT := 0;
  v_eligible_amount NUMERIC := 0;
  v_archived_count BIGINT := 0;
BEGIN
  IF NOT public.is_admin_or_automation() THEN
    RAISE EXCEPTION 'Access denied: Admin role required to archive transactions';
  END IF;

  IF p_before_date IS NULL OR p_before_date > (CURRENT_DATE - INTERVAL '90 days') THEN
    RAISE EXCEPTION 'Safety guard: cutoff date must be at least 90 days in the past';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(item_price), 0)
  INTO v_eligible_count, v_eligible_amount
  FROM public.transactions
  WHERE payment_date < p_before_date
    AND COALESCE(is_settled, FALSE) = TRUE
    AND NULLIF(BTRIM(COALESCE(erp_batch_number, '')), '') IS NOT NULL;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', TRUE,
      'before_date', p_before_date,
      'eligible_count', v_eligible_count,
      'eligible_amount_egp', v_eligible_amount
    );
  END IF;

  BEGIN
    v_email := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), 'system@nu.edu.eg');
  EXCEPTION WHEN OTHERS THEN
    v_email := 'system@nu.edu.eg';
  END;

  WITH moved AS (
    DELETE FROM public.transactions
    WHERE payment_date < p_before_date
      AND COALESCE(is_settled, FALSE) = TRUE
      AND NULLIF(BTRIM(COALESCE(erp_batch_number, '')), '') IS NOT NULL
    RETURNING *
  ),
  ins AS (
    INSERT INTO public.transactions_archive
    SELECT m.*, NOW(), v_email
    FROM moved m
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_archived_count FROM ins;

  INSERT INTO public.audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_email,
    'Cold-Storage Archive Completed',
    'Before ' || p_before_date::TEXT || ' (' || v_archived_count || ' rows)',
    jsonb_build_object(
      'before_date', p_before_date,
      'archived_count', v_archived_count,
      'archived_amount_egp', v_eligible_amount
    )
  );

  RETURN jsonb_build_object(
    'dry_run', FALSE,
    'before_date', p_before_date,
    'archived_count', v_archived_count,
    'archived_amount_egp', v_eligible_amount
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.archive_settled_transactions(DATE, BOOLEAN) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.archive_settled_transactions(DATE, BOOLEAN) TO authenticated, service_role;
