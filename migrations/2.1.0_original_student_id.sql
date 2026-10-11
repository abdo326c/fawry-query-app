-- Migration for v2.1.0 – run ONCE in the Supabase SQL editor BEFORE deploying the new app files.
--
-- Adds transactions.original_student_id: the student ID exactly as it was imported,
-- before any payment link or manual fix was applied. "Re-apply Rules" now starts from this
-- value, so deleting a manual fix or removing a link correctly restores the original ID.

-- 1. New column
alter table public.transactions
    add column if not exists original_student_id text;

-- 2. Backfill rows whose current ID is still the imported one
--    (no link value and no manual-fix Correct ID for that reference).
update public.transactions t
set original_student_id = t.student_id
where t.original_student_id is null
  and not exists (
      select 1 from public.manual_fixes f
      where f.reference_number = t.reference_number
        and coalesce(f.correct_id, '') <> ''
  )
  and not exists (
      select 1 from public.links l
      where l.payment_reference_number = t.reference_number
        and coalesce(l.custom_input_value, '') <> ''
  );

-- 3. How many rows could NOT be backfilled (their current ID came from a link or fix).
--    For these, the original ID isn't stored anywhere. They keep working exactly as before;
--    re-importing their original Fawry file fills original_student_id in.
select count(*) as rows_without_original_id
from public.transactions
where original_student_id is null;
