-- Migration 2.8.0: Add personal_email (secondary email) to student_master
-- Keeps NU university email (@nu.edu.eg) as the main `email` column and
-- moves non-NU personal emails into `personal_email`.

ALTER TABLE public.student_master
  ADD COLUMN IF NOT EXISTS personal_email TEXT;

-- 1. Move any non-NU personal emails currently stored in `email` into `personal_email`
UPDATE public.student_master
SET
  personal_email = COALESCE(NULLIF(BTRIM(personal_email), ''), BTRIM(email)),
  email = NULL
WHERE email IS NOT NULL
  AND BTRIM(email) <> ''
  AND LOWER(BTRIM(email)) !~ '@([a-z0-9-]+\.)*nu\.edu([.,]eg)?$';

-- 2. If `personal_email` holds an NU email while `email` is empty, promote it to `email`
UPDATE public.student_master
SET
  email = BTRIM(personal_email),
  personal_email = NULL
WHERE (email IS NULL OR BTRIM(email) = '')
  AND personal_email IS NOT NULL
  AND LOWER(BTRIM(personal_email)) ~ '@([a-z0-9-]+\.)*nu\.edu([.,]eg)?$';

-- 3. Indexes for lookup, auto-matching, and trigram search on personal_email
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email
  ON public.student_master (personal_email);
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email_lower
  ON public.student_master (LOWER(BTRIM(personal_email)));
CREATE INDEX IF NOT EXISTS idx_student_master_personal_email_trgm
  ON public.student_master USING gin (personal_email gin_trgm_ops);
