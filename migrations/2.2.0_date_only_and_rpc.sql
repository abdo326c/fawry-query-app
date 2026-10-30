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


-- 4. Deduplicate item_mappings (whitespace/case duplicates & chained adjusted_item_name duplicates) and enforce normalized uniqueness
DO $$
BEGIN
  -- Fold chained duplicates (where Rule B.item_name = Rule A.adjusted_item_name) back into Rule A
  UPDATE public.item_mappings a
  SET
    adjusted_item_name = CASE
      WHEN COALESCE(NULLIF(BTRIM(b.adjusted_item_name), ''), a.adjusted_item_name) = a.item_name THEN NULL
      ELSE COALESCE(NULLIF(BTRIM(b.adjusted_item_name), ''), a.adjusted_item_name)
    END,
    mapping = COALESCE(NULLIF(BTRIM(b.mapping), ''), a.mapping),
    second_mapping = COALESCE(NULLIF(BTRIM(b.second_mapping), ''), a.second_mapping)
  FROM public.item_mappings b
  WHERE a.adjusted_item_name IS NOT NULL
    AND LOWER(REGEXP_REPLACE(BTRIM(a.adjusted_item_name), '\s+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(b.item_name), '\s+', ' ', 'g'))
    AND LOWER(REGEXP_REPLACE(BTRIM(a.item_name), '\s+', ' ', 'g')) <> LOWER(REGEXP_REPLACE(BTRIM(b.item_name), '\s+', ' ', 'g'));

  DELETE FROM public.item_mappings b
  USING public.item_mappings a
  WHERE a.adjusted_item_name IS NOT NULL
    AND LOWER(REGEXP_REPLACE(BTRIM(a.adjusted_item_name), '\s+', ' ', 'g')) = LOWER(REGEXP_REPLACE(BTRIM(b.item_name), '\s+', ' ', 'g'))
    AND LOWER(REGEXP_REPLACE(BTRIM(a.item_name), '\s+', ' ', 'g')) <> LOWER(REGEXP_REPLACE(BTRIM(b.item_name), '\s+', ' ', 'g'));

  -- Remove case/whitespace duplicate item_name rows keeping the most complete trimmed row
  DELETE FROM public.item_mappings m
  USING (
    SELECT ctid,
           ROW_NUMBER() OVER (
             PARTITION BY LOWER(REGEXP_REPLACE(BTRIM(item_name), '\s+', ' ', 'g'))
             ORDER BY (mapping IS NOT NULL) DESC, (second_mapping IS NOT NULL) DESC, (adjusted_item_name IS NOT NULL) DESC, (item_name = BTRIM(item_name)) DESC, item_name ASC
           ) AS rn
    FROM public.item_mappings
  ) dup
  WHERE m.ctid = dup.ctid AND dup.rn > 1;

  -- Trim all remaining item_mappings strings
  UPDATE public.item_mappings
  SET
    item_name = REGEXP_REPLACE(BTRIM(item_name), '\s+', ' ', 'g'),
    adjusted_item_name = NULLIF(REGEXP_REPLACE(BTRIM(COALESCE(adjusted_item_name, '')), '\s+', ' ', 'g'), ''),
    mapping = NULLIF(REGEXP_REPLACE(BTRIM(COALESCE(mapping, '')), '\s+', ' ', 'g'), ''),
    second_mapping = NULLIF(REGEXP_REPLACE(BTRIM(COALESCE(second_mapping, '')), '\s+', ' ', 'g'), '');
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_mappings_norm_unique
  ON public.item_mappings (LOWER(REGEXP_REPLACE(BTRIM(item_name), '\s+', ' ', 'g')));
