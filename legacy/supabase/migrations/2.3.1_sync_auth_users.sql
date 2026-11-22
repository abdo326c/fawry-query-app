-- Migration 2.3.1: Synchronize all registered accounts from auth.users into user_roles
-- Automatically populates user_roles for any user in Supabase Authentication

-- 1. Import all registered accounts from auth.users that are not yet in user_roles
INSERT INTO public.user_roles (email, role, updated_by, updated_at)
SELECT
  LOWER(TRIM(u.email)),
  CASE WHEN LOWER(TRIM(u.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
  'auth.users initial sync',
  NOW()
FROM auth.users u
WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
ON CONFLICT (email) DO NOTHING;

-- 2. Create RPC function public.sync_auth_users()
-- Allows the web app / Admin to pull all registered users on demand
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
  -- Insert missing users from auth.users
  WITH ins AS (
    INSERT INTO public.user_roles (email, role, updated_by, updated_at)
    SELECT
      LOWER(TRIM(u.email)),
      CASE WHEN LOWER(TRIM(u.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      'auth.users sync',
      NOW()
    FROM auth.users u
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ON CONFLICT (email) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  -- Also sweep any user emails from import_batches and audit_logs
  INSERT INTO public.user_roles (email, role, updated_by, updated_at)
  SELECT DISTINCT LOWER(TRIM(user_email)), 'viewer', 'history sync', NOW()
  FROM (
    SELECT user_email FROM public.import_batches WHERE user_email IS NOT NULL AND user_email <> 'System' AND user_email LIKE '%@%'
    UNION
    SELECT user_email FROM public.audit_logs WHERE user_email IS NOT NULL AND user_email <> 'System' AND user_email LIKE '%@%'
  ) h
  WHERE LOWER(TRIM(user_email)) <> 'ammahmoud@nu.edu.eg'
  ON CONFLICT (email) DO NOTHING;

  SELECT COUNT(*) INTO v_total FROM public.user_roles;

  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.sync_auth_users() TO authenticated;

-- 3. Automatic Trigger: Whenever a new user is created in auth.users, add them to user_roles
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND TRIM(NEW.email) <> '' THEN
    INSERT INTO public.user_roles (email, role, updated_by, updated_at)
    VALUES (
      LOWER(TRIM(NEW.email)),
      CASE WHEN LOWER(TRIM(NEW.email)) = 'ammahmoud@nu.edu.eg' THEN 'admin' ELSE 'viewer' END,
      'auth.signup',
      NOW()
    )
    ON CONFLICT (email) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();
