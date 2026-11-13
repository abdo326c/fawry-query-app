-- Migration 2.6.0: Admin User Deactivation, Reactivation & Permanent Deletion
-- Adds active status tracking on user_roles, enforces active-only RLS access,
-- and provides Admin-only SECURITY DEFINER RPCs to ban/unban or delete auth.users accounts.

-- 1. Add is_active column to public.user_roles (safe & idempotent)
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE public.user_roles
SET is_active = TRUE
WHERE LOWER(TRIM(email)) = 'ammahmoud@nu.edu.eg' AND is_active IS DISTINCT FROM TRUE;

-- 2. Enforce deactivation inside RLS role helper functions
CREATE OR REPLACE FUNCTION public.role_level(r TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE LOWER(COALESCE(r, 'viewer'))
    WHEN 'admin' THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'operator' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
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
  v_email     TEXT;
  v_role      TEXT;
  v_is_active BOOLEAN;
BEGIN
  v_email := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_email = '' THEN
    RETURN 'none';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RETURN 'admin';
  END IF;

  SELECT role, COALESCE(is_active, TRUE)
  INTO v_role, v_is_active
  FROM public.user_roles
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF v_is_active IS FALSE THEN
    RETURN 'deactivated';
  END IF;

  RETURN COALESCE(v_role, 'viewer');
END;
$$;

-- Also block deactivated users from reading data via SELECT policies
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'transactions', 'links', 'item_mappings', 'manual_fixes',
    'student_master', 'payment_links', 'import_batches', 'audit_logs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS rbac_select ON %I', tbl);
    EXECUTE format('CREATE POLICY rbac_select ON %I FOR SELECT TO authenticated USING (public.has_min_role(''viewer''))', tbl);
  END LOOP;
END $$;

-- 3. Update sync_auth_users() so deleted users aren't re-created from old audit history
--    and ban status in auth.users stays mirrored in user_roles.is_active
CREATE OR REPLACE FUNCTION public.sync_auth_users()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_inserted INTEGER := 0;
  v_total    INTEGER := 0;
BEGIN
  WITH ins AS (
    INSERT INTO public.user_roles (email, role, is_active, updated_by, updated_at)
    SELECT
      LOWER(TRIM(u.email)),
      CASE WHEN LOWER(TRIM(u.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      (u.banned_until IS NULL OR u.banned_until <= NOW()),
      'auth.users sync',
      NOW()
    FROM auth.users u
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ON CONFLICT (email) DO UPDATE SET
      is_active = CASE
        WHEN LOWER(TRIM(public.user_roles.email)) = 'ammahmoud@nu.edu.eg' THEN TRUE
        ELSE EXCLUDED.is_active
      END
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  SELECT COUNT(*) INTO v_total FROM public.user_roles;
  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;

-- 4. Admin RPC: Deactivate or Reactivate a user account (updates user_roles + bans/unbans auth.users + revokes sessions)
CREATE OR REPLACE FUNCTION public.admin_set_user_active(target_email TEXT, active BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller      TEXT;
  v_email       TEXT;
  v_user_id     UUID;
  v_ban_until   TIMESTAMPTZ;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Permission denied: Admin role required';
  END IF;

  v_caller := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', 'Admin')));
  v_email  := LOWER(TRIM(COALESCE(target_email, '')));

  IF v_email = '' OR POSITION('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'Valid target email is required';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' AND active = FALSE THEN
    RAISE EXCEPTION 'Primary Admin account cannot be deactivated';
  END IF;
  IF v_email = v_caller AND active = FALSE THEN
    RAISE EXCEPTION 'You cannot deactivate your own active Admin account';
  END IF;

  v_ban_until := CASE WHEN active THEN NULL ELSE '2099-12-31T23:59:59Z'::timestamptz END;

  INSERT INTO public.user_roles (email, role, is_active, updated_by, updated_at)
  VALUES (
    v_email,
    CASE WHEN v_email = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
    active,
    v_caller,
    NOW()
  )
  ON CONFLICT (email) DO UPDATE SET
    is_active  = active,
    updated_by = v_caller,
    updated_at = NOW();

  SELECT id INTO v_user_id
  FROM auth.users
  WHERE LOWER(TRIM(email)) = v_email
  LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    UPDATE auth.users
    SET banned_until = v_ban_until,
        updated_at   = NOW()
    WHERE id = v_user_id;

    IF active = FALSE THEN
      DELETE FROM auth.sessions WHERE user_id = v_user_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'email', v_email,
    'is_active', active,
    'auth_user_found', v_user_id IS NOT NULL
  );
END;
$$;

-- 5. Admin RPC: Permanently delete a user from user_roles and Supabase Auth (auth.users)
CREATE OR REPLACE FUNCTION public.admin_delete_user(target_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller       TEXT;
  v_email        TEXT;
  v_deleted_auth INTEGER := 0;
BEGIN
  IF NOT public.has_min_role('admin') THEN
    RAISE EXCEPTION 'Permission denied: Admin role required';
  END IF;

  v_caller := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', 'Admin')));
  v_email  := LOWER(TRIM(COALESCE(target_email, '')));

  IF v_email = '' OR POSITION('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'Valid target email is required';
  END IF;
  IF v_email = 'ammahmoud@nu.edu.eg' THEN
    RAISE EXCEPTION 'Primary Admin account cannot be deleted';
  END IF;
  IF v_email = v_caller THEN
    RAISE EXCEPTION 'You cannot delete your own active Admin account';
  END IF;

  DELETE FROM public.user_roles WHERE LOWER(TRIM(email)) = v_email;

  WITH del AS (
    DELETE FROM auth.users
    WHERE LOWER(TRIM(email)) = v_email
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted_auth FROM del;

  RETURN jsonb_build_object(
    'email', v_email,
    'deleted_auth_users', v_deleted_auth
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_user_active(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(TEXT) TO authenticated;
