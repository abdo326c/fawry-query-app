-- Migration 2.3.3: Hygiene Auto-Snapshot & Rollback Procedures

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
  v_deleted_mappings_json JSONB := '[]'::jsonb;
  v_deleted_fixes_json JSONB := '[]'::jsonb;
  v_audit_id BIGINT;
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

  -- 4. Auto-clean if requested with PRE-CLEAN SNAPSHOT for safe rollback
  IF p_clean THEN
    -- Capture & Delete Duplicate Item Mappings
    WITH dups AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(item_name)) ORDER BY id ASC) as rn
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

    -- Capture & Delete Duplicate Manual Fixes
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

  -- 5. Calculate Health Score (0 - 100)
  IF v_total_tx = 0 THEN
    v_health_score := 100.0;
  ELSE
    v_health_score := ROUND(GREATEST(0, (1.0 - (v_invalid_id_tx + v_unmapped_tx + v_identical_dups + v_dup_mappings + v_dup_fixes)::NUMERIC / (v_total_tx * 2.0))) * 100, 1);
  END IF;

  -- 6. Log audit entry with rollback snapshot
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
    'duplicate_fixes', v_dup_fixes,
    'cleaned_mappings', v_cleaned_mappings,
    'cleaned_fixes', v_cleaned_fixes,
    'auto_cleaned', p_clean
  );
END;
$$;

-- 7. Rollback Database Hygiene Audit Procedure
CREATE OR REPLACE FUNCTION public.rollback_database_hygiene_audit(p_audit_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audit RECORD;
  v_snapshot JSONB;
  v_m JSONB;
  v_f JSONB;
  v_restored_m INTEGER := 0;
  v_restored_f INTEGER := 0;
  v_email TEXT;
BEGIN
  SELECT * INTO v_audit FROM audit_logs WHERE id = p_audit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log record % not found', p_audit_id;
  END IF;

  IF (v_audit.details ->> 'is_reverted')::BOOLEAN IS TRUE THEN
    RAISE EXCEPTION 'Audit run % has already been reverted', p_audit_id;
  END IF;

  v_snapshot := v_audit.details -> 'revert_snapshot';
  IF v_snapshot IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No snapshot found for this audit run.');
  END IF;

  -- Restore Mappings
  FOR v_m IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot -> 'deleted_mappings', '[]'::jsonb))
  LOOP
    INSERT INTO item_mappings (item_name, adjusted_item_name, mapping, second_mapping)
    VALUES (
      v_m ->> 'item_name',
      v_m ->> 'adjusted_item_name',
      v_m ->> 'mapping',
      v_m ->> 'second_mapping'
    );
    v_restored_m := v_restored_m + 1;
  END LOOP;

  -- Restore Fixes
  FOR v_f IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot -> 'deleted_fixes', '[]'::jsonb))
  LOOP
    INSERT INTO manual_fixes (reference_number, correct_id, item_name, mapping, second_mapping)
    VALUES (
      v_f ->> 'reference_number',
      v_f ->> 'correct_id',
      v_f ->> 'item_name',
      v_f ->> 'mapping',
      v_f ->> 'second_mapping'
    );
    v_restored_f := v_restored_f + 1;
  END LOOP;

  -- Mark original audit log as reverted
  UPDATE audit_logs
  SET details = jsonb_set(details, '{is_reverted}', 'true'::jsonb, true)
  WHERE id = p_audit_id;

  BEGIN
    v_email := NULLIF(auth.jwt() ->> 'email', '');
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  v_email := COALESCE(v_email, 'admin@nu.edu.eg');

  INSERT INTO audit_logs (user_email, action, affected_references, details)
  VALUES (
    v_email,
    'Database Hygiene Rollback',
    'Audit #' || p_audit_id,
    jsonb_build_object(
      'target_audit_id', p_audit_id,
      'restored_mappings', v_restored_m,
      'restored_fixes', v_restored_f,
      'reverted_at', now()
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'audit_id', p_audit_id,
    'restored_mappings', v_restored_m,
    'restored_fixes', v_restored_f,
    'message', 'Successfully restored ' || v_restored_m || ' mapping rules and ' || v_restored_f || ' manual fixes.'
  );
END;
$$;
