-- Migration 2.11.5: Drop Unused & Duplicate Indexes (~55 MB Storage Savings on Free Plan)
--
-- Safe to run multiple times (idempotent).
-- Ensures canonical active indexes exist before dropping redundant legacy copies and
-- zero-scan GIN/B-tree indexes on public.student_master and public.transactions.

-- 1. Ensure canonical active indexes exist first
CREATE INDEX IF NOT EXISTS idx_student_master_national
  ON public.student_master (national_id);

CREATE INDEX IF NOT EXISTS idx_transactions_student_id
  ON public.transactions (student_id);

-- 2. Drop unused & duplicate indexes on public.student_master
--    (Keeps student_master_pkey, idx_student_master_national, and idx_student_master_name_trgm)
DROP INDEX IF EXISTS public.idx_student_master_email_trgm;
DROP INDEX IF EXISTS public.idx_student_master_natid_trgm;
DROP INDEX IF EXISTS public.idx_student_master_personal_email_trgm;
DROP INDEX IF EXISTS public.idx_student_master_mobile_trgm;
DROP INDEX IF EXISTS public.idx_student_master_gmobile_trgm;
DROP INDEX IF EXISTS public.idx_student_master_email;
DROP INDEX IF EXISTS public.idx_student_master_email_lower;
DROP INDEX IF EXISTS public.idx_student_master_id;
DROP INDEX IF EXISTS public.idx_student_master_nat_id;
DROP INDEX IF EXISTS public.idx_student_master_national_id;
DROP INDEX IF EXISTS public.idx_student_master_mobile;
DROP INDEX IF EXISTS public.idx_student_master_personal_email;
DROP INDEX IF EXISTS public.idx_student_master_personal_email_lower;
DROP INDEX IF EXISTS public.idx_student_master_college;

-- 3. Drop zero-scan GIN & redundant duplicate indexes on public.transactions
--    (Keeps idx_transactions_date_id, idx_transactions_date_bank, idx_transactions_student_id,
--     idx_transactions_ref_trgm, idx_transactions_student_trgm, idx_transactions_item_trgm,
--     idx_transactions_check_col_trgm, and all active B-tree indexes)
DROP INDEX IF EXISTS public.idx_transactions_mobile_trgm;
DROP INDEX IF EXISTS public.idx_transactions_mapping_trgm;
DROP INDEX IF EXISTS public.idx_transactions_second_mapping_trgm;
DROP INDEX IF EXISTS public.idx_transactions_student;
DROP INDEX IF EXISTS public.idx_transactions_payment_date;
