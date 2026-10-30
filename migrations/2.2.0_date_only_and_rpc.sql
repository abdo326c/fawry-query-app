-- Migration for v2.2.0 – Strips time from payment_date and adds fast pivot RPC.
-- Safe to run multiple times in Supabase SQL Editor.

-- 1. Ensure missing columns exist
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS original_student_id TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);

-- 2. Strip any time portion from transactions.payment_date and enforce DATE type
--    Using string splitting before casting guarantees no timezone shift ever changes the calendar date.
ALTER TABLE public.transactions
  ALTER COLUMN payment_date TYPE DATE
  USING (NULLIF(SPLIT_PART(SPLIT_PART(TRIM(payment_date::TEXT), ' ', 1), 'T', 1), ''))::DATE;

-- 3. Server-side Dashboard Pivot RPC supporting all Group By modes (date, mapping, second_mapping, item_name)
CREATE OR REPLACE FUNCTION public.get_dashboard_pivot_by(start_date DATE, end_date DATE, group_col TEXT)
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
$$;
