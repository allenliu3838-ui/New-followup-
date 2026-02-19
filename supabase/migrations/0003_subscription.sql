-- KidneySphere AI — Subscription Model (v3)
--
-- Changes:
--   1. Trial period: 56 days → 90 days (3 months)
--      Grace period: 70 days → 100 days (10-day buffer after trial)
--   2. Add subscription_plan + subscription_active_until to projects
--   3. Update assert_project_write_allowed() to allow paid subscribers
--   4. Add admin_set_subscription() RPC (service-role only)
--
-- Subscription plans:
--   'trial'       — default; write access until trial_expires_at
--   'pro'         — paid individual/lab plan
--   'institution' — paid multi-center plan
--
-- Write-access rules (any one of):
--   A. trial_enabled = false  (admin override)
--   B. plan IN ('pro','institution') AND active_until IS NULL OR active_until > now()
--   C. plan = 'trial' AND now() <= trial_expires_at
--
-- After trial + grace: data is NEVER deleted. Researchers can still READ and
-- download their data. Paying restores write access immediately.
-- ---------------------------

-- ---------------------------
-- 1. Extend trial defaults for NEW projects
-- ---------------------------

ALTER TABLE public.projects
  ALTER COLUMN trial_expires_at SET DEFAULT (now() + interval '90 days'),
  ALTER COLUMN trial_grace_until SET DEFAULT (now() + interval '100 days');

-- ---------------------------
-- 2. Backfill existing projects that haven't expired yet
--    (extend their trial proportionally to 90 days from started_at)
-- ---------------------------

UPDATE public.projects
SET
  trial_expires_at  = trial_started_at + interval '90 days',
  trial_grace_until = trial_started_at + interval '100 days'
WHERE
  trial_enabled = true
  AND now() < (trial_started_at + interval '90 days');

-- ---------------------------
-- 3. Add subscription columns
-- ---------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS subscription_active_until timestamptz;

ALTER TABLE public.projects
  ADD CONSTRAINT subscription_plan_check
    CHECK (subscription_plan IN ('trial', 'pro', 'institution'));

-- ---------------------------
-- 4. Update write-lock function
-- ---------------------------

CREATE OR REPLACE FUNCTION public.assert_project_write_allowed(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trial_enabled          boolean;
  v_trial_expires          timestamptz;
  v_subscription_plan      text;
  v_subscription_until     timestamptz;
BEGIN
  SELECT
    trial_enabled,
    trial_expires_at,
    subscription_plan,
    subscription_active_until
  INTO
    v_trial_enabled,
    v_trial_expires,
    v_subscription_plan,
    v_subscription_until
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;

  -- Rule A: trial restriction disabled by admin
  IF NOT v_trial_enabled THEN
    RETURN;
  END IF;

  -- Rule B: active paid subscription
  IF v_subscription_plan IN ('pro', 'institution') THEN
    IF v_subscription_until IS NULL OR v_subscription_until > now() THEN
      RETURN;
    END IF;
    -- Paid plan has expired → fall through to trial check
  END IF;

  -- Rule C: within trial period
  IF v_trial_expires IS NOT NULL AND now() <= v_trial_expires THEN
    RETURN;
  END IF;

  -- Nothing matched → block write
  RAISE EXCEPTION 'subscription_required';
END;
$$;

-- ---------------------------
-- 5. Admin RPC: activate / extend subscription
--    Must be called with service_role key (server-side only).
-- ---------------------------

CREATE OR REPLACE FUNCTION public.admin_set_subscription(
  p_project_id      uuid,
  p_plan            text,
  p_active_until    timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_role text;
BEGIN
  v_session_role := current_setting('role', true);

  -- Allowed callers:
  --   'service_role'    → Supabase service-role key (server-side / Edge Functions)
  --   'supabase_admin'  → Supabase internal admin
  --   'postgres'        → SQL Editor (superuser, trusted admin access)
  -- All other roles (authenticated, anon) are blocked unless they own the project.
  IF v_session_role NOT IN ('service_role', 'supabase_admin', 'postgres') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = p_project_id AND created_by = auth.uid()
    ) THEN
      RAISE EXCEPTION 'admin_only';
    END IF;
  END IF;

  IF p_plan NOT IN ('trial', 'pro', 'institution') THEN
    RAISE EXCEPTION 'invalid_plan: %. Must be one of: trial, pro, institution', p_plan;
  END IF;

  UPDATE public.projects
  SET
    subscription_plan         = p_plan,
    subscription_active_until = p_active_until
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found: %', p_project_id;
  END IF;
END;
$$;

-- Usage example (run in Supabase SQL Editor):
--
--   SELECT public.admin_set_subscription(
--     'your-project-uuid'::uuid,
--     'pro'::text,
--     (now() + interval '1 year')::timestamptz
--   );
--
-- To find project UUIDs:
--   SELECT id, name, center_code, subscription_plan FROM public.projects;

GRANT EXECUTE ON FUNCTION public.admin_set_subscription(uuid, text, timestamptz)
  TO authenticated;

-- ---------------------------
-- 6. Expose subscription fields via patient_get_context
--    (so patient follow-up links also respect subscription state)
-- ---------------------------

CREATE OR REPLACE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE (
  project_id              uuid,
  project_name            text,
  center_code             text,
  module                  text,
  patient_code            text,
  sex                     text,
  birth_year              int,
  trial_expires_at        timestamptz,
  trial_grace_until       timestamptz,
  subscription_plan       text,
  subscription_active_until timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                       AS project_id,
    p.name                     AS project_name,
    p.center_code,
    p.module,
    t.patient_code,
    b.sex,
    b.birth_year,
    p.trial_expires_at,
    p.trial_grace_until,
    p.subscription_plan,
    p.subscription_active_until
  FROM public.patient_tokens t
  JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.patients_baseline b
    ON b.project_id = t.project_id AND b.patient_code = t.patient_code
  WHERE t.token = p_token
    AND t.active = true
    AND (t.expires_at IS NULL OR t.expires_at > now())
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.patient_get_context(text) TO anon, authenticated;

-- END
