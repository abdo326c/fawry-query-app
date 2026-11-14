-- Migration 2.7.0: Label Existing Students in student_master with (UG) or (PG)
-- Rule: All Undergraduate programs are labeled (UG); otherwise (PG).

CREATE OR REPLACE FUNCTION public.label_existing_students_ug_pg()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ug_updated INTEGER := 0;
  v_pg_updated INTEGER := 0;
BEGIN
  IF NOT public.has_min_role('operator') THEN
    RAISE EXCEPTION 'Insufficient permissions: operator role or higher required.';
  END IF;

  -- 1. Label Undergraduate students as (UG)
  WITH upd_ug AS (
    UPDATE public.student_master
    SET
      program = '(UG) ' || REGEXP_REPLACE(BTRIM(COALESCE(program, '')), '^\((?:UG|PG)\)\s*', '', 'i'),
      updated_at = NOW()
    WHERE
      REGEXP_REPLACE(BTRIM(COALESCE(program, '')), '^\((?:UG|PG)\)\s*', '', 'i') ~* '^(undergraduate|undergrad|bachelor|ug)\M'
      AND COALESCE(program, '') !~ '^\(UG\)\s'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_ug_updated FROM upd_ug;

  -- 2. Label all other students as (PG)
  WITH upd_pg AS (
    UPDATE public.student_master
    SET
      program = CASE
        WHEN BTRIM(REGEXP_REPLACE(COALESCE(program, ''), '^\((?:UG|PG)\)\s*', '', 'i')) = '' THEN '(PG)'
        ELSE '(PG) ' || BTRIM(REGEXP_REPLACE(COALESCE(program, ''), '^\((?:UG|PG)\)\s*', '', 'i'))
      END,
      updated_at = NOW()
    WHERE
      REGEXP_REPLACE(BTRIM(COALESCE(program, '')), '^\((?:UG|PG)\)\s*', '', 'i') !~* '^(undergraduate|undergrad|bachelor|ug)\M'
      AND COALESCE(program, '') !~ '^\(PG\)(\s|$)'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pg_updated FROM upd_pg;

  RETURN jsonb_build_object(
    'ok', true,
    'ug_updated', v_ug_updated,
    'pg_updated', v_pg_updated,
    'total_updated', v_ug_updated + v_pg_updated
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.label_existing_students_ug_pg() TO authenticated;

-- Also execute immediately when this migration is run in the SQL Editor:
UPDATE public.student_master
SET
  program = CASE
    WHEN REGEXP_REPLACE(BTRIM(COALESCE(program, '')), '^\((?:UG|PG)\)\s*', '', 'i') ~* '^(undergraduate|undergrad|bachelor|ug)\M'
      THEN '(UG) ' || BTRIM(REGEXP_REPLACE(COALESCE(program, ''), '^\((?:UG|PG)\)\s*', '', 'i'))
    WHEN BTRIM(REGEXP_REPLACE(COALESCE(program, ''), '^\((?:UG|PG)\)\s*', '', 'i')) = ''
      THEN '(PG)'
    ELSE '(PG) ' || BTRIM(REGEXP_REPLACE(COALESCE(program, ''), '^\((?:UG|PG)\)\s*', '', 'i'))
  END,
  updated_at = NOW()
WHERE COALESCE(program, '') !~ '^\((?:UG|PG)\)(\s|$)';
