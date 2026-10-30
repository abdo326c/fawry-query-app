-- Migration 2.3.0: 4-Tier Role-Based Access Control (RBAC)
-- Roles: viewer (1) < operator (2) < accountant (3) < admin (4)
-- Primary Admin: Ammahmoud@nu.edu.eg

-- 1. User Roles Table
CREATE TABLE IF NOT EXISTS user_roles (
  email       VARCHAR(255) PRIMARY KEY,
  role        VARCHAR(50) NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'operator', 'accountant', 'admin')),
  updated_by  VARCHAR(255),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Primary Admin (Ammahmoud@nu.edu.eg)
INSERT INTO user_roles (email, role, updated_by)
VALUES ('ammahmoud@nu.edu.eg', 'admin', 'system')
ON CONFLICT (email) DO UPDATE SET role = 'admin', updated_at = NOW();

-- Also seed any existing users from import_batches / audit_logs as viewer if not present
INSERT INTO user_roles (email, role, updated_by)
SELECT DISTINCT LOWER(TRIM(user_email)), 'viewer', 'system'
FROM (
  SELECT user_email FROM import_batches WHERE user_email IS NOT NULL AND user_email <> 'System'
  UNION
  SELECT user_email FROM audit_logs WHERE user_email IS NOT NULL AND user_email <> 'System'
) u
WHERE LOWER(TRIM(user_email)) <> 'ammahmoud@nu.edu.eg'
ON CONFLICT (email) DO NOTHING;

-- 2. Helper Functions for RLS
CREATE OR REPLACE FUNCTION public.role_level(r TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE LOWER(COALESCE(r, 'viewer'))
    WHEN 'admin' THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'operator' THEN 2
    ELSE 1
  END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_role  TEXT;
BEGIN
  v_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'viewer';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RETURN 'admin';
  END IF;

  SELECT role INTO v_role
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  RETURN COALESCE(v_role, 'viewer');
END;
$$;

CREATE OR REPLACE FUNCTION public.has_min_role(required_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.role_level(public.current_user_role()) >= public.role_level(required_role);
$$;

-- 3. Enable RLS on user_roles
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_select ON user_roles;
CREATE POLICY user_roles_select ON user_roles
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS user_roles_admin_write ON user_roles;
CREATE POLICY user_roles_admin_write ON user_roles
  FOR ALL TO authenticated
  USING (public.has_min_role('admin'))
  WITH CHECK (public.has_min_role('admin'));

-- 4. Granular Role-Based RLS Policies on Application Tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transactions', 'links', 'item_mappings', 'manual_fixes',
    'student_master', 'payment_links', 'import_batches', 'audit_logs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_full_access ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_select ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_insert ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_update ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS rbac_delete ON %I', tbl);

    -- Everyone authenticated (Viewer+) can read
    EXECUTE format('CREATE POLICY rbac_select ON %I FOR SELECT TO authenticated USING (true)', tbl);
  END LOOP;
END $$;

-- Operator+ can insert/update transactions, links, student_master, payment_links, import_batches, audit_logs
CREATE POLICY rbac_insert ON transactions FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_update ON transactions FOR UPDATE TO authenticated USING (public.has_min_role('operator')) WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_delete ON transactions FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON links FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_update ON links FOR UPDATE TO authenticated USING (public.has_min_role('operator')) WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_delete ON links FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON student_master FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_update ON student_master FOR UPDATE TO authenticated USING (public.has_min_role('operator')) WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_delete ON student_master FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON payment_links FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_update ON payment_links FOR UPDATE TO authenticated USING (public.has_min_role('operator')) WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_delete ON payment_links FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON import_batches FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_update ON import_batches FOR UPDATE TO authenticated USING (public.has_min_role('operator')) WITH CHECK (public.has_min_role('operator'));
CREATE POLICY rbac_delete ON import_batches FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK (public.has_min_role('operator'));

-- Accountant+ can insert/update item_mappings and manual_fixes; only Admin can delete
CREATE POLICY rbac_insert ON item_mappings FOR INSERT TO authenticated WITH CHECK (public.has_min_role('accountant'));
CREATE POLICY rbac_update ON item_mappings FOR UPDATE TO authenticated USING (public.has_min_role('accountant')) WITH CHECK (public.has_min_role('accountant'));
CREATE POLICY rbac_delete ON item_mappings FOR DELETE TO authenticated USING (public.has_min_role('admin'));

CREATE POLICY rbac_insert ON manual_fixes FOR INSERT TO authenticated WITH CHECK (public.has_min_role('accountant'));
CREATE POLICY rbac_update ON manual_fixes FOR UPDATE TO authenticated USING (public.has_min_role('accountant')) WITH CHECK (public.has_min_role('accountant'));
CREATE POLICY rbac_delete ON manual_fixes FOR DELETE TO authenticated USING (public.has_min_role('admin'));
