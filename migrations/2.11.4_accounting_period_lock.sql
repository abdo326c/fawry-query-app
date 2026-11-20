-- Migration 2.11.4: Accounting Period Lock (Month-End Close)
--
-- Safe to run multiple times (idempotent). Run in Supabase SQL editor after 2.11.3.
--
--  1. Table `public.closed_periods` tracking locked/reopened YYYY-MM periods (RLS: viewer read, admin write).
--  2. Helper `public.is_period_closed(p_date DATE)` + audited Admin RPC `public.set_accounting_period_lock(...)`.
--  3. PostgreSQL BEFORE INSERT/UPDATE/DELETE triggers on `transactions`, `foreign_transactions`, and `manual_fixes`
--     blocking backdated imports, manual fix edits, and ERP batch unlinking inside closed periods.
--  4. Compatibility updates to `secure_audit_log_insert`, `trg_propagate_student_master_level`, and
--     `archive_settled_transactions` (so Admin cold-storage archiving works across closed periods).

-- ---------------------------------------------------------------------------
-- 1. Closed Periods Table & RLS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.closed_periods (
  period_month TEXT PRIMARY KEY CHECK (period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  is_closed    BOOLEAN NOT NULL DEFAULT TRUE,
  closed_by    TEXT,
  closed_at    TIMESTAMPTZ,
  reopened_by  TEXT,
  reopened_at  TIMESTAMPTZ,
  notes        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_closed_periods_is_closed
  ON public.closed_periods (is_closed)
  WHERE is_closed = TRUE;

ALTER TABLE public.closed_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rbac_select ON public.closed_periods;
CREATE POLICY rbac_select ON public.closed_periods
  FOR SELECT TO authenticated
  USING ((SELECT public.has_min_role('viewer')));

DROP POLICY IF EXISTS rbac_admin_write ON public.closed_periods;
CREATE POLICY rbac_admin_write ON public.closed_periods
  FOR ALL TO authenticated
  USING ((SELECT public.has_min_role('admin')))
  WITH CHECK ((SELECT public.has_min_role('admin')));

-- ---------------------------------------------------------------------------
-- 2. Period Lock Lookup Helper & Audited Admin Toggle RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_period_closed(p_date DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_date IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1
      FROM public.closed_periods cp
      WHERE cp.period_month = to_char(p_date, 'YYYY-MM')
        AND cp.is_closed = TRUE
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_period_closed(DATE) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.is_period_closed(DATE) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_accounting_period_lock(
  p_period_month TEXT,
  p_is_closed BOOLEAN,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_month       TEXT := BTRIM(COALESCE(p_period_month, ''));
  v_closed      BOOLEAN := COALESCE(p_is_closed, TRUE);
  v_notes       TEXT := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
  v_caller      TEXT;
  v_prev_closed BOOLEAN := NULL;
  v_row         public.closed_periods%ROWTYPE;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Access denied: Admin role required to manage accounting period locks';
  END IF;

  IF v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Invalid period_month "%" — expected YYYY-MM format', v_month;
  END IF;

  IF NOT v_closed AND v_notes IS NULL THEN
    RAISE EXCEPTION 'An audit reason is required to unlock a closed accounting period (%)', v_month;
  END IF;

  BEGIN
    v_caller := COALESCE(NULLIF(LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', ''))), ''), 'admin@nu.edu.eg');
  EXCEPTION WHEN OTHERS THEN
    v_caller := 'admin@nu.edu.eg';
  END;

  SELECT cp.is_closed INTO v_prev_closed
  FROM public.closed_periods cp
  WHERE cp.period_month = v_month;

  INSERT INTO public.closed_periods (
    period_month, is_closed, closed_by, closed_at, reopened_by, reopened_at, notes, updated_at
  )
  VALUES (
    v_month,
    v_closed,
    CASE WHEN v_closed THEN v_caller ELSE NULL END,
    CASE WHEN v_closed THEN NOW() ELSE NULL END,
    CASE WHEN NOT v_closed THEN v_caller ELSE NULL END,
    CASE WHEN NOT v_closed THEN NOW() ELSE NULL END,
    v_notes,
    NOW()
  )
  ON CONFLICT (period_month) DO UPDATE SET
    is_closed   = v_closed,
    closed_by   = CASE WHEN v_closed THEN v_caller ELSE public.closed_periods.closed_by END,
    closed_at   = CASE WHEN v_closed THEN NOW() ELSE public.closed_periods.closed_at END,
    reopened_by = CASE WHEN NOT v_closed THEN v_caller ELSE public.closed_periods.reopened_by END,
    reopened_at = CASE WHEN NOT v_closed THEN NOW() ELSE public.closed_periods.reopened_at END,
    notes       = v_notes,
    updated_at  = NOW()
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_caller,
    CASE WHEN v_closed THEN 'Accounting Period Closed' ELSE 'Accounting Period Unlocked' END,
    v_month,
    jsonb_build_object(
      'period_month', v_month,
      'is_closed', v_closed,
      'previous_is_closed', v_prev_closed,
      'notes', v_notes
    )
  );

  RETURN to_jsonb(v_row);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_accounting_period_lock(TEXT, BOOLEAN, TEXT) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.set_accounting_period_lock(TEXT, BOOLEAN, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Harden secure_audit_log_insert() for Period Lock Actions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.secure_audit_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_jwt_email TEXT;
  v_role TEXT;
BEGIN
  BEGIN
    v_jwt_email := NULLIF(LOWER(TRIM(auth.jwt() ->> 'email')), '');
  EXCEPTION WHEN OTHERS THEN
    v_jwt_email := NULL;
  END;

  NEW.user_email := COALESCE(
    (SELECT email FROM auth.users WHERE id = auth.uid()),
    v_jwt_email,
    NEW.user_email,
    'system@nu.edu.eg'
  );

  IF auth.uid() IS NOT NULL THEN
    v_role := public.current_user_role();

    IF NEW.action IN (
      'Database Hygiene Audit',
      'Database Hygiene Rollback',
      'Accounting Period Closed',
      'Accounting Period Unlocked'
    ) AND v_role <> 'admin' THEN
      RAISE EXCEPTION 'Access denied: only admin or automation can log %', NEW.action;
    END IF;

    IF public.role_level(v_role) < public.role_level('accountant') AND NEW.details IS NOT NULL THEN
      NEW.details := NEW.details - 'revert_data' - 'revert_snapshot' - 'drive_folder_url';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.secure_audit_log_insert() FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Enforcement Triggers on transactions, foreign_transactions & manual_fixes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_enforce_tx_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_date DATE;
  v_new_date DATE;
  v_ref      TEXT;
BEGIN
  IF current_setting('app.bypass_period_lock', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_new_date := CASE
      WHEN TG_TABLE_NAME = 'foreign_transactions' THEN COALESCE(NEW.value_date, NEW.transaction_date)
      ELSE NEW.payment_date
    END;
    v_ref := COALESCE(NEW.reference_number, 'unknown');
    IF public.is_period_closed(v_new_date) THEN
      RAISE EXCEPTION 'Accounting period % is closed. Cannot insert transaction (ref: %) into a locked month without an audited Admin unlock.',
        to_char(v_new_date, 'YYYY-MM'), v_ref
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_date := CASE
      WHEN TG_TABLE_NAME = 'foreign_transactions' THEN COALESCE(OLD.value_date, OLD.transaction_date)
      ELSE OLD.payment_date
    END;
    v_ref := COALESCE(OLD.reference_number, 'unknown');
    IF public.is_period_closed(v_old_date) THEN
      RAISE EXCEPTION 'Accounting period % is closed. Cannot delete transaction (ref: %) from a locked month without an audited Admin unlock.',
        to_char(v_old_date, 'YYYY-MM'), v_ref
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'foreign_transactions' THEN
      v_old_date := COALESCE(OLD.value_date, OLD.transaction_date);
      v_new_date := COALESCE(NEW.value_date, NEW.transaction_date);
    ELSE
      v_old_date := OLD.payment_date;
      v_new_date := NEW.payment_date;
    END IF;
    v_ref := COALESCE(NEW.reference_number, OLD.reference_number, 'unknown');

    IF public.is_period_closed(v_old_date) THEN
      RAISE EXCEPTION 'Accounting period % is closed. Cannot modify transaction or ERP batch (ref: %) inside a locked month without an audited Admin unlock.',
        to_char(v_old_date, 'YYYY-MM'), v_ref
        USING ERRCODE = 'P0001';
    END IF;
    IF v_new_date IS DISTINCT FROM v_old_date AND public.is_period_closed(v_new_date) THEN
      RAISE EXCEPTION 'Accounting period % is closed. Cannot backdate transaction (ref: %) into a locked month without an audited Admin unlock.',
        to_char(v_new_date, 'YYYY-MM'), v_ref
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_transactions_period_lock ON public.transactions;
CREATE TRIGGER trg_transactions_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_tx_period_lock();

DROP TRIGGER IF EXISTS trg_foreign_transactions_period_lock ON public.foreign_transactions;
CREATE TRIGGER trg_foreign_transactions_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.foreign_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_tx_period_lock();

CREATE OR REPLACE FUNCTION public.trg_enforce_manual_fix_period_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ref_old      TEXT;
  v_ref_new      TEXT;
  v_refs         TEXT[];
  v_blocked_ref  TEXT;
  v_closed_month TEXT;
BEGIN
  IF current_setting('app.bypass_period_lock', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_ref_new := NULLIF(BTRIM(COALESCE(NEW.reference_number, '')), '');
  ELSIF TG_OP = 'DELETE' THEN
    v_ref_old := NULLIF(BTRIM(COALESCE(OLD.reference_number, '')), '');
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    v_ref_old := NULLIF(BTRIM(COALESCE(OLD.reference_number, '')), '');
    v_ref_new := NULLIF(BTRIM(COALESCE(NEW.reference_number, '')), '');
  END IF;

  v_refs := ARRAY(
    SELECT DISTINCT r
    FROM unnest(ARRAY[v_ref_old, v_ref_new]) AS r
    WHERE r IS NOT NULL AND r <> ''
  );

  IF COALESCE(array_length(v_refs, 1), 0) > 0 THEN
    SELECT t.reference_number, to_char(t.payment_date, 'YYYY-MM')
    INTO v_blocked_ref, v_closed_month
    FROM public.transactions t
    WHERE t.reference_number = ANY(v_refs)
      AND public.is_period_closed(t.payment_date)
    LIMIT 1;

    IF v_closed_month IS NULL THEN
      SELECT ft.reference_number, to_char(COALESCE(ft.value_date, ft.transaction_date), 'YYYY-MM')
      INTO v_blocked_ref, v_closed_month
      FROM public.foreign_transactions ft
      WHERE ft.reference_number = ANY(v_refs)
        AND public.is_period_closed(COALESCE(ft.value_date, ft.transaction_date))
      LIMIT 1;
    END IF;

    IF v_closed_month IS NOT NULL THEN
      RAISE EXCEPTION 'Accounting period % is closed. Cannot modify manual fix for reference % because it belongs to a locked month without an audited Admin unlock.',
        v_closed_month, v_blocked_ref
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_manual_fixes_period_lock ON public.manual_fixes;
CREATE TRIGGER trg_manual_fixes_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.manual_fixes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_manual_fix_period_lock();

-- ---------------------------------------------------------------------------
-- 5. Compatibility Updates: student_master trigger & archive_settled_transactions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_propagate_student_master_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sid        TEXT;
  v_norm       TEXT;
  v_padded     TEXT;
  v_level      VARCHAR(8);
  v_candidates TEXT[];
BEGIN
  v_sid := BTRIM(COALESCE(NEW.student_id, ''));
  IF v_sid = '' THEN
    RETURN NEW;
  END IF;

  v_norm := regexp_replace(v_sid, '^0+(\d{4,})$', '\1');
  v_padded := CASE WHEN v_norm ~ '^\d+$' AND length(v_norm) < 9 THEN lpad(v_norm, 9, '0') ELSE v_norm END;
  v_candidates := ARRAY(
    SELECT DISTINCT c
    FROM unnest(ARRAY[NEW.student_id, v_sid, v_norm, v_padded]) AS c
    WHERE c IS NOT NULL AND c <> ''
  );

  v_level := public.classify_program_student_level(NEW.program);

  UPDATE public.transactions t
  SET student_level = v_level
  WHERE t.student_id = ANY(v_candidates)
    AND t.student_level IS DISTINCT FROM v_level
    AND NOT public.is_period_closed(t.payment_date);

  UPDATE public.foreign_transactions ft
  SET student_level = v_level
  WHERE ft.student_id = ANY(v_candidates)
    AND ft.student_level IS DISTINCT FROM v_level
    AND NOT public.is_period_closed(COALESCE(ft.value_date, ft.transaction_date));

  RETURN NEW;
END;
$$;

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

  PERFORM set_config('app.bypass_period_lock', 'on', true);

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
