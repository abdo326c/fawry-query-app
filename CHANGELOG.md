# Changelog

## 2.12.1 – 2026-11-22

Security and data-safety fixes for the new Turso / Vercel API (critical and high findings from the review).

**After deploying:** run `node scripts/turso_setup.mjs` once against the production database (with `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` set and **without** `ADMIN_INITIAL_PASSWORD`) to install the new database triggers. It is safe to re-run; it changes no data.

### Critical
- **Any signed-in user could make themselves admin.** `upsert` had no entry in the permission table, so the role check always passed, even for viewers and deactivated users. One request could set `role: 'admin'`, reopen a closed accounting period, overwrite audit entries or change settled/archived rows. Upsert now needs both the insert and update roles. Unknown operations and unknown roles are refused, and deactivated or role-less accounts can't write anything.

### High
- **The month-end period lock is enforced by the database again.** SQLite triggers on `transactions`, `foreign_transactions` and `manual_fixes` block inserts, updates and deletes in a closed month, and moving rows into one. Postgres had these triggers; the Turso port only checked in some API paths. These paths now covered:
  - bulk rule-field updates
  - ERP reverts
  - hygiene rollbacks
  - student-level updates (closed months are skipped, as before)
  - upserts that would overwrite a closed-month row
- **The audit log is append-only.** Nobody can edit or delete entries through the API, and the database refuses deletes. Inserts can no longer set their own id, timestamp or author.
- **The archive is append-only.** Archived rows can't be changed or deleted. Re-importing an old Fawry file no longer brings archived (settled, ERP-posted) payments back as unsettled. The archive run no longer deletes a payment it failed to copy into the archive.
- **Other admins can't take over the owner account.** Only the primary admin can reset or set the primary admin's password.
- **Updating and deleting manual fixes works again.** The period-lock check failed every time with "ambiguous column name".
- **Each write request is saved completely or not at all.** Imports were split into 200-row batches that could half-commit while the screen reported the whole chunk as failed.
- **Writes are no longer re-sent after an unclear network error.** Re-sending could save audit entries, settlement runs or payments twice. Reads still retry. Writes retry only when the database was locked, which means nothing was saved.
- **The Supabase-to-Turso copy script fails loudly** instead of silently replacing rows. It checks the row count against Supabase and never skips rows when Supabase returns short pages.

## 2.11.1 – 2026-11-18

- **All Excel exports show dates as `yyyy-mm-dd`** (`yyyy-mm-dd hh:mm:ss` when there is a time). Real Excel date cells (Fawry Query export, Dynamics 365 journal) keep their date value with the new display format; date text in columns named "… Date", "Created", "Expiry", "Time" etc. is rewritten (e.g. `17/11/2026`, `17-Nov-2026`, `1/25/2026 3:05 PM`). Applied once in `writeCompressedExcel`, so every export is covered. The dashboard collection report's daily rows also use `yyyy-mm-dd` instead of `17-Nov-2026`.

## 2.11.0 – 2026-11-17

Fixes for the critical and high-severity issues found in a full code review.

**Before deploying:**
1. Supabase → Authentication → turn **off** "Allow new users to sign up".
2. Run `migrations/2.11.0_security_and_hygiene_fixes.sql` in the SQL editor.
3. Make sure the `SUPABASE_SERVICE_ROLE_KEY` repository secret is set (backup and hygiene jobs now fail without it instead of silently "succeeding").

**After deploying:** signed-in accounts with no `user_roles` row no longer see any data, and non-`@nu.edu.eg` accounts start inactive. Add or activate staff in the Users & Roles admin page.

### ERP / money
- **Re-importing a BM (USD) statement no longer clears the ERP batch/voucher** of already-posted deposits (they could be exported and posted twice). The sync never writes ERP fields; only Record ERP and Unlink do.
- **Recording or unlinking an ERP batch on BM deposits now fails loudly** if the database write fails, instead of stamping only this browser.
- **ERP export / dashboard read BM deposits database-first.** A stale browser cache no longer overrides other users' corrections, cleared batches or deleted duplicates; cache-only rows are used only when the database can't be reached (with a warning).
- **ERP export no longer skips BM deposits** at 1,000-row page boundaries (it paged on the non-unique `value_date`).
- **Past dates are no longer stored with today's USD→EGP rate** when the historical rate can't be fetched; the nearest earlier known rate is used instead. Future value dates are not fetched.
- **`fetchAll` no longer returns duplicate rows** when one parallel page fails and the sequential fallback runs.

### Settlement
- **"Save Run to History" works again** (it wrote to columns that don't exist in `settlement_batches`).
- **Month-first dates (`1/25/2026`) no longer abort reconciliation**; impossible dates are rejected.
- **Mark as Settled only updates unsettled items**, so items settled under another batch keep their batch number. Saved (historical) runs are read-only.

### BM (USD) deposits
- **Two students with the same name are never auto-matched** to a deposit; the handler bonus can break ties but not force a 100% match.
- **Excel date cells** (serial numbers) are parsed correctly instead of being saved as `"45672.5"`.

### Database & automation (migration 2.11.0)
- Default-deny roles; active-viewer read policies on every table (including `foreign_transactions`, `exchange_rates`, `settlement_batches`, `user_roles`), evaluated once per query.
- `sync_auth_users()` is admin/automation-only and no longer re-activates users an admin deactivated.
- The audit-log guard trigger is attached, so audit entries can't be forged to drive admin Revert.
- Nightly hygiene only deletes mapping rules that are true duplicates (same mappings); case variants that map differently are reported, not deleted. Scheduled runs are inspection-only; deleting needs a manual run with "apply fixes".
- Weekly backup now includes `foreign_transactions`, `settlement_batches`, `links`, `payment_links`, `import_batches`, `exchange_rates` and the full audit log, and the job fails (red) on any error.
- `schema.sql` carries a warning: it is out of date and must not be re-run on production.

## 2.1.0 – 2026-10-11

Fixes to the "Re-apply Rules" logic.

**Database change required:** run `migrations/2.1.0_original_student_id.sql` before deploying.

### Data correctness
- **Removing a link or manual fix now restores the original student ID.** Re-apply used to start from the ID already saved on the transaction, so an ID set by a deleted fix or removed link stayed forever. Imports now store `original_student_id`, and every re-apply starts from it. Rows imported before 2.1.0 whose ID came from a link or fix can't be recovered automatically; re-importing their Fawry file fills the original ID in.
- **Deleting a mapping or a manual fix updates the affected transactions** straight away, the same way saving one does.
- **Re-applies only write the rule columns** (`student_id`, `item_name`, `mapping`, `second_mapping`, `id_status`), by id. Before, the preview saved whole rows captured when it was computed, which could put back old settlement/ERP values written in the meantime.
- **Settled and ERP-recorded transactions are protected.** Saving or deleting a fix/mapping and importing links leave them unchanged and say how many were skipped. The Re-apply preview shows them with a "Settled" / "In ERP" badge, unticked by default, and asks for confirmation if you include them.
- A numeric `student_id` column no longer makes every linked or fixed row appear as changed.

### Re-apply preview
- The Old Value and New Value columns line up with their headers (a header column was missing).
- "Reason" describes what actually caused each change (Student Link, Manual Fix, Mapping Rule, Original restored, Status Re-validation) instead of listing every rule that exists for the reference.
- A summary line shows how many rows would change and how many are settled/ERP.
- "Select all" reflects the rows each time the preview opens.
- Applying is recorded in the audit log.

### Maintenance
- One shared, tested function (`diffTransaction` in `rules.js`) is used by Re-apply Rules, fix/mapping save and delete, and links import.
- New tests in `tests/reapply.test.js` cover removal, idempotency, reasons, locked rows and field-only updates.
- Cache-busting version set to 2.1.0 and service-worker cache bumped, so browsers load the new code.

## 2.0.0 – 2026-10-10

Bug-fix release following a full code review.

### Critical
- **App wouldn't load:** a corrupted line in the auto-matcher (`app.js`) was a syntax error that stopped the whole app from running.
- **Add Mapping button crashed:** it referenced a form field that doesn't exist, so the form never opened.

### Data correctness
- **Manual fixes no longer wipe mappings.** Saving an ID-only fix (single or bulk upload) used to clear Mapping and 2nd Mapping. Blank fields now leave existing values alone.
- **The Add Fix and Add Mapping forms always start empty.** Values from a previously edited fix were being saved onto new fixes.
- **One shared rule engine (`rules.js`):** import, fix save, mapping save and Re-apply Rules now give identical results (link, then fix, then mapping rule, then fix mapping overrides).
- **Revert is safe.** Re-importing a file no longer takes ownership of rows created by an earlier import, and Revert never deletes transactions that are settled or recorded in ERP.
- **ERP export:**
  - The credit per line is `item_price`. The order-level Net Amount was being repeated on every item of multi-item NUADIB64 orders.
  - Rows already recorded in ERP are excluded by default to prevent double posting.
  - Partial data is never exported after a load error.
- **No more silent 1,000-row limits** (Supabase returns at most 1,000 rows per request):
  - Manual fixes and mappings loaded during import
  - The settlement "Missing in Settlement" search
  - ERP data and filters
  - Re-apply Rules (stops on error instead of skipping pages)
- **Saving a mapping that renames items** now updates every affected transaction. Before, it skipped rows when more than 1,000 matched.
- **Duplicate cleanup** compares the original item (`check_column`), so two different items that share an adjusted name are no longer deleted as duplicates. Settled and ERP-recorded copies are never deleted.
- **A links import that fails to save now reports failure** instead of "completed successfully".
- **Import:**
  - Reference numbers are trimmed.
  - DIP student IDs keep their prefix.
  - Stray spaces are removed from numeric student IDs ("2310 00123" becomes "231000123").
  - The import stops if rules can't be loaded.
- **A fix that renames an item** to a name with no mapping rule keeps the original item's mapping.

### Settlement
- The same file can be reconciled again without reloading the page.
- Excel dates are read without timezone conversion, so late-evening payments stay on the correct day.
- Rows without `ORDER_REF_NUMBER` are ignored and counted, instead of being grouped as "undefined".
- A reference counts as settled only when all of its items are settled.

### Other fixes
- **Auto-Matcher:**
  - The "Error" status filter works.
  - IDs aren't forced to integers.
  - Failing student lookups are reported.
  - The full student name list is only downloaded when name matching is turned on.
- **Payment Links:**
  - Edit and Delete buttons work. Delete used to fail after the confirm dialog.
  - Import errors are shown, and duplicate invoice numbers in one file are handled without creating duplicate links.
- Errors from save, upload and delete operations are now shown instead of a false "success" message.
- Stale search results can no longer overwrite newer ones (Transactions, ERP).
- Error messages are HTML-escaped wherever they're displayed.
- File inputs reset, so the same file can be selected twice in a row.
- The dashboard KPI cards respect the bank filter.

### Security and maintenance
- **Content-Security-Policy:** restored to a strict allow-list. The previous "allow everything" policy has been removed.
- **CDN libraries pinned to exact versions:** supabase-js 2.45.4, fuse.js 7.0.0, flatpickr 4.6.13. flatpickr themes now load from jsdelivr.
- **Cache-busting version** set to 2.0.0.
- **Added** a README (setup, database requirements, RLS security checklist) and this changelog.
