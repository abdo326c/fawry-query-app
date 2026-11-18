-- Migration 2.11.2: Server-Side Filtered Dashboard Summary RPC & Composite Indexes
-- Extends get_dashboard_summary with an optional status_filter parameter so filtered
-- dashboard pivots ('valid', 'invalid', 'settled', 'unsettled', 'erp_recorded', 'erp_unposted')
-- execute in a single server-side PostgreSQL scan instead of downloading rows to the browser.

DROP FUNCTION IF EXISTS public.get_dashboard_summary(DATE, DATE, TEXT, TEXT[]);

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

GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(DATE, DATE, TEXT, TEXT[], TEXT) TO authenticated;
