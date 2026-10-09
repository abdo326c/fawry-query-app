# Fawry Payments Database

Internal web app for NU Finance. It imports Fawry payment exports, matches payments to students, reconciles bank settlement files, and produces the Dynamics 365 (ERP) journal file.

It's a static site (HTML + JavaScript modules). All data lives in Supabase.

## Features

| Tab | What it does |
|---|---|
| Dashboard | Collections pivot by date, mapping or item, per bank (NUADIB64 / NUADCB136) |
| Transactions | Search, filter and export imported payments; import Fawry order and link files |
| Settlement | Upload bank settlement Excel/ZIP files, reconcile them against the system and mark matched payments as settled |
| Item Mappings | Rules that rename items and assign Mapping / 2nd Mapping |
| Manual Fixes | Per-reference corrections (student ID, item name, mappings) |
| Auto-Matcher | Proposes student IDs for invalid or missing IDs (link info, email, national ID, phone, optional name match) |
| Students Details | Student master list lookup and import |
| Payment Links | Catalogue of Fawry payment links |
| ERP Export | Builds the Dynamics 365 journal file and records batch/voucher numbers |

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout, modals, CDN libraries, Content-Security-Policy |
| `styles.css` | Styling (dark and light themes) |
| `supabase.js` | Supabase client (project URL and **public** anon key) |
| `rules.js` | Shared business rules (ID validation, link → fix → mapping order) and paginated data helpers |
| `csv-processor.js` | Importer for Fawry order and link files (CSV / Excel) |
| `settlement.js` | Settlement reconciliation |
| `app.js` | The rest of the UI |

## Running it

ES modules don't load from `file://`, so the app has to be served over HTTP(S).

- **Locally:** run `npx serve .` or `python -m http.server 8080` in this folder, then open http://localhost:8080
- **Hosting:** any static host works (GitHub Pages, Netlify, Vercel, Cloudflare Pages, or an internal web server). There's no build step.

After deploying a new version, do a hard refresh (Ctrl+F5) so browsers don't keep old cached JavaScript.

## Business rules (order of precedence)

The importer, saving a fix or mapping, and **Re-apply Rules** all go through the same function (`applyBusinessRules` in `rules.js`):

1. **Student ID:** taken from the customer name, then the payment link's custom input value, then the manual fix's Correct ID (last one wins). Spaces inside numeric IDs are removed.
2. **Item name:** the original Fawry item name, replaced by the manual fix's Item Name if one is set.
3. **Mapping rule:** looked up on the resulting item name. Its *Adjusted Item Name* is only used when the manual fix didn't set an item name. If a fix renamed the item to a name that has no rule, the original item's rule is used.
4. **Manual fix Mapping / 2nd Mapping:** override the mapping rule. Blank fields never clear anything.

ERP credit per line = `item_price`. For NUADCB136 the importer already stores Net Amount there. For NUADIB64 it's the item's own price, so multi-item orders aren't over-credited.

## Database requirements

Upserts rely on these unique constraints:

| Table | Unique key |
|---|---|
| `transactions` | `(reference_number, item_price, check_column)` |
| `links` | `payment_reference_number` |
| `item_mappings` | `item_name` |
| `manual_fixes` | `reference_number` |
| `payment_links` | `invoice_number` (recommended; the import still works without it, just slower) |
| `student_master` | `student_id` (primary key) |

Columns used on `transactions`: `id, reference_number, payment_date (date), student_id, customer_mobile, total_amount, net_amount, fawry_fees, payment_status, item_name, item_price, merchant_name, bank, check_column, file_name, batch_id, mapping, second_mapping, id_status, is_settled, settlement_batch, erp_batch_number, erp_voucher`.

Other tables used: `import_batches`, `audit_logs`.

Optional RPC: `get_dashboard_pivot(start_date, end_date)` speeds up the dashboard. Without it, the app falls back to a normal query.

## Security checklist (important)

The key in `supabase.js` is the public **anon** key, which every visitor can see. That's normal for Supabase. Student data is protected **only** by Row Level Security (RLS), so before publishing:

1. Enable RLS on **every** table listed above.
2. Allow access only to signed-in users. Example (adapt per table):
   ```sql
   alter table public.transactions enable row level security;
   create policy "staff only" on public.transactions
     for all to authenticated using (true) with check (true);
   ```
3. In Supabase → Authentication → Providers, **disable public sign-ups**, so only accounts you create can log in.
4. Never commit the `service_role` key to this repository.

If the GitHub repository is public, anyone can read this code and the anon key. With RLS set up as above, that doesn't expose any data. A **private** repository is still recommended.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
