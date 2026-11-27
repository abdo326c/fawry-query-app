# Fawry Payments Database

Internal web app for NU Finance. It imports Fawry payment exports, matches payments to students, reconciles bank settlement files, and produces the Dynamics 365 (ERP) journal file.

The front end is built with Vite and served by Vercel. Data lives in a Turso (libSQL / SQLite) database, reached only through the Vercel functions in `api/` (`auth.js`, `query.js`, `rpc.js`), which check the signed-in user's role on every request.

## Features

| Tab | What it does |
|---|---|
| Dashboard | Multi-currency collections pivot by date, mapping or item, per bank (NUADIB64 / NUADCB136 / Banque Misr USD) with USD→EGP FX sync |
| Transactions | Search, filter and export imported Fawry payments; import Fawry order and link files |
| BM Transactions | Import Banque Misr (USD) bank statements (Excel/CSV/PDF), auto-match student names, and manage foreign deposits |
| Settlement | Upload bank settlement Excel/ZIP files, reconcile them against the system, save run history, and mark matched payments as settled |
| Item Mappings | Rules that rename items and assign Mapping / 2nd Mapping |
| Manual Fixes | Per-reference corrections (student ID, item name, mappings) |
| Auto-Matcher | Proposes student IDs for invalid or missing IDs (link info, email, national ID, phone, optional name match) |
| Students Details | Student master list lookup, UG/PG classification, statement export, and bulk import |
| Payment Links | Catalogue of Fawry payment links |
| ERP Export | Builds the Dynamics 365 journal file (Fawry + BM USD deposits) and records batch/voucher numbers |
| Users & Roles | Admin-only 4-tier RBAC management (`viewer`, `operator`, `accountant`, `admin`), user activation/deactivation, and Audit Log with point-in-time revert |

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout, modals, CDN libraries (with SRI hashes), Content-Security-Policy |
| `styles.css` | Styling (dark and light themes) |
| `ui-chrome.js` | Service Worker registration, sidebar rail collapse, auth password toggle, and dropdown popovers |
| `supabase.js` | Supabase-compatible client wrapper that calls the `/api/*` functions |
| `rules.js` | Shared business rules (ID validation, link → fix → mapping order), Excel compression/date formatting, and paginated data helpers |
| `app-utils.js` | Shared UI helpers (`Toast`, progress wrappers, currency/status formatting, script loader) |
| `csv-processor.js` | Importer for Fawry order and link files (CSV / Excel) |
| `settlement.js` | Settlement reconciliation and saved settlement batch history |
| `foreign-transactions.js` | Banque Misr (USD) statement parser (Excel/CSV/PDF) and student deposit matcher |
| `fx-rates.js` | Historical and daily USD→EGP exchange rate store and sync helpers |
| `dashboard.js` | Dashboard pivot, KPI summary, FX rate controls, and collection report Excel export |
| `auto-matcher.js` | Student ID auto-matching engine UI and proposal review |
| `erp-export.js` | Dynamics 365 (ERP) journal preview, Excel export, and batch/voucher recording |
| `admin-audit.js` | Users & Roles RBAC admin panel, Audit Log viewer/undo, Double-Payment detector, and Database Hygiene modal |
| `app.js` | Core application controller, authentication, transactions, mappings, fixes, students, and foreign deposits UI |
| `api/` | Vercel functions: sign-in (JWT), table queries and RPCs with role checks |
| `turso/schema.sql` | Live database schema (tables, period-lock and append-only triggers) |
| `scripts/` | Setup, backup/restore, hygiene, FX rate and maintenance scripts (see Operations) |
| `legacy/supabase/` | Old PostgreSQL schema and migrations. History only: never apply them |

## Setup and deploy (Turso + Vercel)

1. **Database:** create a Turso database (`turso db create fawry`), then get its URL
   (`turso db show fawry --url`) and a token (`turso db tokens create fawry`).
2. **Schema and first admin:** with the variables from `.env.example` set, run
   `node scripts/turso_setup.mjs`. It applies `turso/schema.sql` (safe to re-run; it changes no
   data) and, when `ADMIN_INITIAL_PASSWORD` is set, creates/resets the `ADMIN_EMAIL` login.
   Run it again (without `ADMIN_INITIAL_PASSWORD`) after any release that changes the schema.
3. **Vercel:** set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `JWT_SECRET` (a long random
   string) in Project Settings -> Environment Variables. The build is `npm run build` (output
   `dist/`). Node 22+ (`.nvmrc` = 24).
4. **Local:** `npm ci`, then `npm run dev`. Tests: `npm test`; lint: `npm run lint`.

Users are created by an admin in **Users & Roles**; there is no public sign-up.

## Operations

| Job / script | What it does |
|---|---|
| `weekly_backup.yml` (Fri 16:00 UTC) | Hygiene audit (inspection only), then `scripts/backup_to_drive.js`. The backup runs even if the audit fails; the job turns red if either failed. |
| `database_hygiene.yml` (daily 00:00 UTC) | Inspection; a manual run with "apply fixes" deletes exact duplicate mapping rules. |
| `daily_fx_rate.yml` (09-12 UTC) | Saves today's USD->EGP rate at 12:00 Cairo time, or later if GitHub ran late and no rate exists yet. Never overwrites a manual rate. |

A failed scheduled run opens (or comments on) a GitHub issue named "Scheduled job failed: ...".

**Repository secrets** (Settings -> Secrets -> Actions): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
`GDRIVE_TOKEN_JSON`, and optional `BACKUP_ENCRYPTION_KEY` (8+ chars; encrypts weekly backups as
AES-256-GCM `.zip.enc`). Optional variable `BACKUP_RETENTION` (default 12).

### Backups

`scripts/backup_to_drive.js` exports every table of `turso/schema.sql` (except the transient
`period_lock_bypass`) to `fawry_backup_YYYYMMDD_HHmmss.zip` with a manifest of row counts and
SHA-256 checksums, uploads it to Drive (Fawry Payments Backup > Year > Month > Week) and moves
backups older than the newest `BACKUP_RETENTION` to the Drive trash.
`node scripts/backup_to_drive.js --local-only [--out dir]` writes the zip locally instead.

**The backup contains `app_users` (password hashes) and student personal data. Share the Drive
folder with nobody except the finance admins.**

### Restore

Only into a new, empty database:

1. Create a database and run `node scripts/turso_setup.mjs` against it.
2. `node scripts/restore_from_backup.mjs <zip> --manifest <zip name>_manifest.json` (dry run:
   checks zip, checksums, row counts and that the target is empty).
3. Same command with `--confirm` to restore; it verifies the row counts afterwards.
4. Point Vercel's `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` at the new database.

Restoring over existing data is refused (audit log and archive are append-only by trigger).

### Maintenance scripts

- `scripts/delete_foreign_transactions.mjs` deletes all BM (USD) deposits: dry run by default,
  `--confirm` to delete; saves a JSON backup to `backups/` first.
- `scripts/load_test_10_users.mjs` needs `LOAD_TEST_ALLOW=1`, `LOAD_TEST_EMAIL` and
  `--target <url>` equal to `TURSO_DATABASE_URL`. Never run it against production.

### Rotating the Turso token

1. `turso db tokens create <db>` (new token).
2. Update `TURSO_AUTH_TOKEN` in Vercel (then redeploy) and in the GitHub repository secrets.
3. Check the app and run a workflow manually (e.g. the FX job).
4. Invalidate old tokens: `turso db tokens invalidate <db>` (this invalidates **all** tokens of
   the database, so do it only after step 2 everywhere, then create one fresh token if needed).

## Business rules (order of precedence)

The importer, saving or deleting a fix or mapping, and **Re-apply Rules** all go through the same function (`applyBusinessRules` in `rules.js`). Re-applying always starts from the **originally imported** values (`original_student_id`, and the item name kept in `check_column`), so removing a link, fix or rule undoes it. Re-applies only write the rule columns (`student_id`, `item_name`, `mapping`, `second_mapping`, `id_status`) and never change settled or ERP-recorded transactions unless you tick them in the Re-apply preview.

1. **Student ID:** taken from the customer name, then the payment link's custom input value, then the manual fix's Correct ID (last one wins). Spaces inside numeric IDs are removed.
2. **Item name:** the original Fawry item name, replaced by the manual fix's Item Name if one is set.
3. **Mapping rule:** looked up on the resulting item name. Its *Adjusted Item Name* is only used when the manual fix didn't set an item name. If a fix renamed the item to a name that has no rule, the original item's rule is used.
4. **Manual fix Mapping / 2nd Mapping:** override the mapping rule. Blank fields never clear anything.

ERP credit per line = `item_price`. For NUADCB136 the importer already stores Net Amount there. For NUADIB64 it's the item's own price, so multi-item orders aren't over-credited.

## Security

- Every read and write goes through `api/`, which checks the JWT and the user's role
  (`viewer < operator < accountant < admin`). The browser never holds a database token.
- `JWT_SECRET`, `TURSO_AUTH_TOKEN` and the Drive token are secrets: keep them in Vercel / GitHub
  settings, never in the repository.
- Closed accounting periods, the audit log and the archive are protected by database triggers.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
