-- Migration 2.11.6: Multi-User Performance & Live DB Storage Meter
--
-- Safe to run multiple times (idempotent). Run in Supabase SQL editor after 2.11.5.
--
--  1. Partial index `idx_transactions_nonvalid_id_status` + 1-ms RPC `public.get_unresolved_tx_count()`
--     replacing dual full-table ILIKE count scans for sidebar badge updates.
--  2. `student_master.updated_at` trigger + 1-query version fingerprint `public.get_student_master_version()`
--     enabling instant browser IndexedDB caching of the 22k+ Student Master directory.
--  3. Admin-only `public.get_database_storage_stats()` RPC reporting total DB size vs 500 MB Free limit
--     and per-table data/index breakdown.

-- ---------------------------------------------------------------------------
-- 1. Partial Index & Fast Unresolved Transaction Count RPC
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_nonvalid_id_status
  ON public.transactions (id)
  WHERE COALESCE(id_status, '') <> 'Valid';

CREATE OR REPLACE FUNCTION public.get_unresolved_tx_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.transactions t
  WHERE COALESCE(t.id_status, '') <> 'Valid'
    AND COALESCE(t.id_status, '') <> 'Exempt'
    AND COALESCE(t.mapping, '') !~* '\m(dip|diploma|workshops?)\M'
    AND COALESCE(t.second_mapping, '') !~* '\m(dip|diploma|workshops?)\M';
$$;

REVOKE EXECUTE ON FUNCTION public.get_unresolved_tx_count() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_unresolved_tx_count() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Student Master Freshness Trigger & Version Fingerprint RPC
-- ---------------------------------------------------------------------------
ALTER TABLE public.student_master
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.trg_touch_student_master_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_student_master_touch_updated_at ON public.student_master;
CREATE TRIGGER trg_student_master_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.student_master
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_touch_student_master_updated_at();

CREATE OR REPLACE FUNCTION public.get_student_master_version()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'row_count', COUNT(*)::BIGINT,
    'max_student_id', COALESCE(MAX(student_id), ''),
    'max_updated_at', MAX(updated_at)
  )
  FROM public.student_master;
$$;

REVOKE EXECUTE ON FUNCTION public.get_student_master_version() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_student_master_version() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Admin-Only Live Database Storage & Table Breakdown RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_database_storage_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_total_bytes BIGINT;
  v_tables      JSONB;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Access denied: Admin role required to view database storage stats';
  END IF;

  v_total_bytes := pg_database_size(current_database());

  WITH top_tables AS (
    SELECT
      relname AS table_name,
      COALESCE(n_live_tup, 0)::BIGINT AS est_rows,
      ROUND(pg_relation_size(relid) / (1024.0 * 1024.0), 1) AS table_mb,
      ROUND(pg_indexes_size(relid) / (1024.0 * 1024.0), 1) AS indexes_mb,
      ROUND(pg_total_relation_size(relid) / (1024.0 * 1024.0), 1) AS total_mb
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 8
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(top_tables)), '[]'::jsonb)
  INTO v_tables
  FROM top_tables;

  RETURN jsonb_build_object(
    'total_bytes', v_total_bytes,
    'used_mb', ROUND(v_total_bytes / (1024.0 * 1024.0), 1),
    'limit_mb', 500,
    'pct_used', ROUND((v_total_bytes / (500.0 * 1024.0 * 1024.0)) * 100.0, 1),
    'tables', v_tables
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_database_storage_stats() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_database_storage_stats() TO authenticated;
