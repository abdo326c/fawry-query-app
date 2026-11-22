# Legacy Supabase (PostgreSQL) schema - DO NOT APPLY

These files are the schema and migrations of the old Supabase/PostgreSQL backend, kept only
for history and because some tests read them as documentation of past behaviour.

- They are **PostgreSQL-only** (RLS policies, plpgsql functions, `auth.users`).
- They must **never** be applied to the Turso database or any other database.
- The live schema is [`turso/schema.sql`](../../turso/schema.sql), applied with
  `node scripts/turso_setup.mjs`.
