# Changelog

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
