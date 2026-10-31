-- Migration 2.3.2: Automated Database Hygiene & Snapshot Backup Procedures

-- 1. Fix secure_audit_log_insert to allow fallback for background / system jobs
CREATE OR REPLACE FUNCTION public.secure_audit_log_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  NEW.user_email := COALESCE(
    (SELECT email FROM auth.users WHERE id = auth.uid()),
    NEW.user_email,
    'system@nu.edu.eg'
  );
  RETURN NEW;
END;
$$;

-- 2. Database Hygiene & Deduplication Audit Function
CREATE OR REPLACE FUNCTION public.run_database_hygiene_audit(p_clean BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
BEGIN
  BEGIN
    v_email := NULLIF(auth.jwt() ->> 'email', '');
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  v_email := COALESCE(v_email, 'system@nu.edu.eg');

  -- 1. Transactions metrics
  SELECT count(*) INTO v_total_tx FROM transactions;
  SELECT count(*) INTO v_settled_tx FROM transactions WHERE is_settled = true;
  SELECT count(*) INTO v_unmapped_tx FROM transactions WHERE mapping IS NULL OR mapping = '' OR mapping = 'Unmapped';
  SELECT count(*) INTO v_invalid_id_tx FROM transactions WHERE id_status IS NOT NULL AND id_status <> 'Valid';

  -- Identical duplicate transactions
  SELECT COALESCE(sum(c - 1), 0) INTO v_identical_dups
  FROM (
    SELECT count(*) as c
    FROM transactions
    GROUP BY reference_number, item_name, item_price, payment_date
    HAVING count(*) > 1
  ) s;

  -- 2. Duplicate Mappings
  SELECT COALESCE(sum(c - 1), 0) INTO v_dup_mappings
  FROM (
    SELECT count(*) as c
    FROM item_mappings
    GROUP BY LOWER(TRIM(item_name))
    HAVING count(*) > 1
  ) s;

  -- 3. Duplicate Fixes
  SELECT COALESCE(sum(c - 1), 0) INTO v_dup_fixes
  FROM (
    SELECT count(*) as c
    FROM manual_fixes
    GROUP BY reference_number
    HAVING count(*) > 1
  ) s;

  -- 4. Auto-clean if requested
  IF p_clean THEN
    WITH dups AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(item_name)) ORDER BY id ASC) as rn
      FROM item_mappings
    ),
    del_m AS (
      DELETE FROM item_mappings
      WHERE id IN (SELECT id FROM dups WHERE rn > 1)
      RETURNING 1
    )
    SELECT count(*) INTO v_cleaned_mappings FROM del_m;

    WITH dup_f AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY reference_number ORDER BY id ASC) as rn
      FROM manual_fixes
    ),
    del_f AS (
      DELETE FROM manual_fixes
      WHERE id IN (SELECT id FROM dup_f WHERE rn > 1)
      RETURNING 1
    )
    SELECT count(*) INTO v_cleaned_fixes FROM del_f;
  END IF;

  -- 5. Calculate Health Score (0 - 100)
  IF v_total_tx = 0 THEN
    v_health_score := 100.0;
  ELSE
    v_health_score := ROUND(GREATEST(0, (1.0 - (v_invalid_id_tx + v_unmapped_tx + v_identical_dups + v_dup_mappings + v_dup_fixes)::NUMERIC / (v_total_tx * 2.0))) * 100, 1);
  END IF;

  -- 6. Log audit entry
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
      'auto_cleaned', p_clean
    )
  );

  RETURN jsonb_build_object(
    'health_score', v_health_score,
    'total_transactions', v_total_tx,
    'settled_transactions', v_settled_tx,
    'invalid_ids', v_invalid_id_tx,
    'unmapped_items', v_unmapped_tx,
    'identical_tx_duplicates', v_identical_dups,
    'duplicate_mappings', v_dup_mappings,
    'duplicate_fixes', v_dup_fixes,
    'cleaned_mappings', v_cleaned_mappings,
    'cleaned_fixes', v_cleaned_fixes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_database_hygiene_audit(BOOLEAN) TO authenticated, anon;

-- 3. Database Snapshot Backup Export Function
CREATE OR REPLACE FUNCTION public.export_database_backup_payload()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mappings JSONB;
  v_fixes JSONB;
  v_roles JSONB;
  v_audit JSONB;
  v_tx_summary JSONB;
BEGIN
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
    'version', '2.3.1',
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
$$;

GRANT EXECUTE ON FUNCTION public.export_database_backup_payload() TO authenticated, anon;
