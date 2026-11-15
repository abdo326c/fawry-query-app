-- 2.9.0: Parallel Keyset Pagination Bounds RPC
-- Enables O(N) parallel bulk fetches without OFFSET scans or statement timeouts.

CREATE OR REPLACE FUNCTION public.get_keyset_bounds(
  p_table TEXT,
  p_col TEXT,
  p_chunk_size INTEGER DEFAULT 1000,
  p_after TEXT DEFAULT NULL
)
RETURNS TABLE(chunk_idx INTEGER, min_val TEXT, max_val TEXT)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_size INTEGER := GREATEST(100, LEAST(COALESCE(p_chunk_size, 1000), 5000));
BEGIN
  IF p_table = 'transactions' AND p_col = 'id' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT t.id AS k, row_number() OVER (ORDER BY t.id ASC) AS rn
        FROM public.transactions t
        WHERE p_after IS NULL OR t.id > p_after::BIGINT
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'student_master' AND p_col = 'student_id' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT sm.student_id AS k, row_number() OVER (ORDER BY sm.student_id ASC) AS rn
        FROM public.student_master sm
        WHERE p_after IS NULL OR sm.student_id > p_after
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'links' AND p_col = 'payment_reference_number' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT l.payment_reference_number AS k, row_number() OVER (ORDER BY l.payment_reference_number ASC) AS rn
        FROM public.links l
        WHERE p_after IS NULL OR l.payment_reference_number > p_after
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'manual_fixes' AND p_col = 'reference_number' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT mf.reference_number AS k, row_number() OVER (ORDER BY mf.reference_number ASC) AS rn
        FROM public.manual_fixes mf
        WHERE p_after IS NULL OR mf.reference_number > p_after
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'item_mappings' AND p_col = 'item_name' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT im.item_name AS k, row_number() OVER (ORDER BY im.item_name ASC) AS rn
        FROM public.item_mappings im
        WHERE p_after IS NULL OR im.item_name > p_after
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'payment_links' AND p_col = 'id' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT pl.id AS k, row_number() OVER (ORDER BY pl.id ASC) AS rn
        FROM public.payment_links pl
        WHERE p_after IS NULL OR pl.id > p_after::BIGINT
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSIF p_table = 'foreign_transactions' AND p_col = 'id' THEN
    RETURN QUERY
      SELECT floor((rn - 1)::NUMERIC / v_size)::INTEGER, min(k)::TEXT, max(k)::TEXT
      FROM (
        SELECT ft.id AS k, row_number() OVER (ORDER BY ft.id ASC) AS rn
        FROM public.foreign_transactions ft
        WHERE p_after IS NULL OR ft.id > p_after::BIGINT
      ) s
      GROUP BY 1
      ORDER BY 1;
  ELSE
    RAISE EXCEPTION 'Unsupported table/column for keyset bounds: %.%', p_table, p_col;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_keyset_bounds(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_keyset_bounds(TEXT, TEXT, INTEGER, TEXT) TO authenticated;
