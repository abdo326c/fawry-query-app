-- 2.10.0: Persist student_level ('UG' | 'PG' | NULL) on transactions & foreign_transactions
-- Eliminates runtime student_master scans/fetches during table views and Excel exports,
-- while keeping transaction rows automatically synchronized via triggers.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS student_level VARCHAR(8);

ALTER TABLE public.foreign_transactions
  ADD COLUMN IF NOT EXISTS student_level VARCHAR(8);

-- 1. Pure program string -> 'UG' | 'PG' classifier (mirrors rules.js getStudentProgramLevel)
CREATE OR REPLACE FUNCTION public.classify_program_student_level(p_program TEXT)
RETURNS VARCHAR(8)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw     TEXT;
  v_clean   TEXT;
  v_primary TEXT;
BEGIN
  v_raw := BTRIM(COALESCE(p_program, ''));
  IF v_raw = '' THEN
    RETURN 'PG';
  END IF;

  IF v_raw ~* '^\(UG\)(\s|/|$)' THEN
    RETURN 'UG';
  END IF;
  IF v_raw ~* '^\(PG\)(\s|/|$)' THEN
    RETURN 'PG';
  END IF;

  v_clean := BTRIM(REGEXP_REPLACE(v_raw, '^\((UG|PG)\)\s*', '', 'i'));
  v_primary := BTRIM(SPLIT_PART(v_clean, '/', 1));

  IF v_primary ~* '^(graduate|postgraduate|diploma|phd|master|msc|mba|pg)(\s|$)' THEN
    RETURN 'PG';
  END IF;
  IF v_primary ~* '^(undergraduate|undergrad|bachelor|ug)(\s|$)' THEN
    RETURN 'UG';
  END IF;
  IF v_clean ~* '(^|[^a-z])(undergraduate|undergrad|bachelor|ug)([^a-z]|$)' THEN
    RETURN 'UG';
  END IF;

  RETURN 'PG';
END;
$$;

-- 2. Resolve student_level from student_id via student_master lookup + DIP heuristic
CREATE OR REPLACE FUNCTION public.resolve_student_level(p_student_id TEXT)
RETURNS VARCHAR(8)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sid        TEXT;
  v_norm       TEXT;
  v_padded     TEXT;
  v_prog       TEXT;
BEGIN
  v_sid := BTRIM(COALESCE(p_student_id, ''));
  IF v_sid = '' OR v_sid IN ('Empty', 'Missing', 'Missing ID') THEN
    RETURN NULL;
  END IF;

  IF v_sid ~* '^dip[\s\-]*\d+' THEN
    RETURN 'PG';
  END IF;

  v_norm := regexp_replace(v_sid, '^0+(\d{4,})$', '\1');
  v_padded := CASE WHEN v_norm ~ '^\d+$' AND length(v_norm) < 9 THEN lpad(v_norm, 9, '0') ELSE v_norm END;

  SELECT sm.program
  INTO v_prog
  FROM public.student_master sm
  WHERE sm.student_id IN (v_sid, v_norm, v_padded)
  ORDER BY CASE WHEN sm.student_id = v_sid THEN 0 WHEN sm.student_id = v_norm THEN 1 ELSE 2 END
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN public.classify_program_student_level(v_prog);
END;
$$;

-- 3. Backfill existing transactions & foreign_transactions before attaching triggers
WITH sm_exact AS (
  SELECT
    BTRIM(student_id) AS sid,
    public.classify_program_student_level(program) AS lvl
  FROM public.student_master
  WHERE BTRIM(COALESCE(student_id, '')) <> ''
),
sm_norm AS (
  SELECT DISTINCT ON (norm_id)
    norm_id,
    lvl
  FROM (
    SELECT
      regexp_replace(BTRIM(student_id), '^0+(\d{4,})$', '\1') AS norm_id,
      public.classify_program_student_level(program) AS lvl
    FROM public.student_master
    WHERE BTRIM(COALESCE(student_id, '')) <> ''
  ) sub
  WHERE norm_id <> ''
  ORDER BY norm_id
),
tx_resolved AS (
  SELECT
    t.id,
    CASE
      WHEN BTRIM(COALESCE(t.student_id, '')) IN ('', 'Empty', 'Missing', 'Missing ID') THEN NULL
      WHEN BTRIM(t.student_id) ~* '^dip[\s\-]*\d+' THEN 'PG'
      ELSE COALESCE(e.lvl, n.lvl)
    END AS target_level
  FROM public.transactions t
  LEFT JOIN sm_exact e ON e.sid = BTRIM(t.student_id)
  LEFT JOIN sm_norm n
    ON e.lvl IS NULL
   AND regexp_replace(BTRIM(COALESCE(t.student_id, '')), '^0+(\d{4,})$', '\1') = n.norm_id
)
UPDATE public.transactions t
SET student_level = r.target_level
FROM tx_resolved r
WHERE t.id = r.id
  AND t.student_level IS DISTINCT FROM r.target_level;

WITH sm_exact AS (
  SELECT
    BTRIM(student_id) AS sid,
    public.classify_program_student_level(program) AS lvl
  FROM public.student_master
  WHERE BTRIM(COALESCE(student_id, '')) <> ''
),
sm_norm AS (
  SELECT DISTINCT ON (norm_id)
    norm_id,
    lvl
  FROM (
    SELECT
      regexp_replace(BTRIM(student_id), '^0+(\d{4,})$', '\1') AS norm_id,
      public.classify_program_student_level(program) AS lvl
    FROM public.student_master
    WHERE BTRIM(COALESCE(student_id, '')) <> ''
  ) sub
  WHERE norm_id <> ''
  ORDER BY norm_id
),
ft_resolved AS (
  SELECT
    ft.id,
    CASE
      WHEN BTRIM(COALESCE(ft.student_id, '')) IN ('', 'Empty', 'Missing', 'Missing ID') THEN NULL
      WHEN BTRIM(ft.student_id) ~* '^dip[\s\-]*\d+' THEN 'PG'
      ELSE COALESCE(e.lvl, n.lvl)
    END AS target_level
  FROM public.foreign_transactions ft
  LEFT JOIN sm_exact e ON e.sid = BTRIM(ft.student_id)
  LEFT JOIN sm_norm n
    ON e.lvl IS NULL
   AND regexp_replace(BTRIM(COALESCE(ft.student_id, '')), '^0+(\d{4,})$', '\1') = n.norm_id
)
UPDATE public.foreign_transactions ft
SET student_level = r.target_level
FROM ft_resolved r
WHERE ft.id = r.id
  AND ft.student_level IS DISTINCT FROM r.target_level;

-- 4. Triggers to keep student_level synchronized automatically on writes
CREATE OR REPLACE FUNCTION public.trg_sync_tx_student_level()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    NEW.student_level := public.resolve_student_level(NEW.student_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_transactions_sync_student_level
  BEFORE INSERT OR UPDATE OF student_id ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_tx_student_level();

CREATE OR REPLACE TRIGGER trg_foreign_transactions_sync_student_level
  BEFORE INSERT OR UPDATE OF student_id ON public.foreign_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_tx_student_level();

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
    AND t.student_level IS DISTINCT FROM v_level;

  UPDATE public.foreign_transactions ft
  SET student_level = v_level
  WHERE ft.student_id = ANY(v_candidates)
    AND ft.student_level IS DISTINCT FROM v_level;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_student_master_propagate_level_ins
  AFTER INSERT ON public.student_master
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_propagate_student_master_level();

CREATE OR REPLACE TRIGGER trg_student_master_propagate_level_upd
  AFTER UPDATE OF student_id, program ON public.student_master
  FOR EACH ROW
  WHEN (NEW.program IS DISTINCT FROM OLD.program OR NEW.student_id IS DISTINCT FROM OLD.student_id)
  EXECUTE FUNCTION public.trg_propagate_student_master_level();

REVOKE ALL ON FUNCTION public.classify_program_student_level(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_program_student_level(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_student_level(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_student_level(TEXT) TO authenticated;
