-- ============================================================
-- 0009_platform_admins.sql
-- 平台管理员体系
--
-- 新增内容：
--   1. platform_admins 表      — 记录平台管理员邮箱
--   2. partner 订阅计划        — 合作机构/友好单位，由管理员手动授权
--   3. is_platform_admin()     — 判断当前登录用户是否为平台管理员
--   4. admin_list_projects()   — 按邮箱搜索某用户的全部项目
--   5. admin_adjust_trial()    — 延长试用天数
--   6. admin_set_partner()     — 设为合作伙伴（长期免费）
--   7. admin_reset_to_trial()  — 撤回为普通试用
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. platform_admins 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  email       text        not null primary key,
  note        text,
  created_at  timestamptz not null default now()
);

-- 仅 postgres / service_role 可直接操作该表；前端用户通过 RPC 间接访问
alter table public.platform_admins enable row level security;
-- 不授予 authenticated / anon 任何直接访问权限（RPC 走 SECURITY DEFINER）

-- ──────────────────────────────────────────────────────────
-- 2. 把 'partner' 加入 subscription_plan 允许值
--    旧约束：('trial', 'pro', 'institution')
--    新约束：('trial', 'pro', 'institution', 'partner')
-- ──────────────────────────────────────────────────────────
alter table public.projects
  drop constraint if exists subscription_plan_check;

alter table public.projects
  add constraint subscription_plan_check
  check (subscription_plan in ('trial', 'pro', 'institution', 'partner'));

-- ──────────────────────────────────────────────────────────
-- 3. 更新 assert_project_write_allowed：
--    partner 计划视同 pro/institution，按 active_until 判断
-- ──────────────────────────────────────────────────────────
create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trial_enabled  boolean;
  v_trial_expires  timestamptz;
  v_plan           text;
  v_sub_until      timestamptz;
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- Rule A: 管理员已关闭试用限制
  if not v_trial_enabled then
    return;
  end if;

  -- Rule B: 付费订阅或合作伙伴计划有效
  if v_plan in ('pro', 'institution', 'partner') and
     (v_sub_until is null or now() <= v_sub_until) then
    return;
  end if;

  -- Rule C: 在试用期内
  if v_trial_expires is not null and now() <= v_trial_expires then
    return;
  end if;

  -- 以上均不满足 → 拒绝写入
  raise exception 'subscription_required';
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 4. is_platform_admin() — 当前用户是否为平台管理员
-- ──────────────────────────────────────────────────────────
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public, auth
stable
as $$
  select exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = auth.uid()
  );
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. admin_list_projects(p_email)
--    按邮箱搜索该用户名下所有项目（模糊匹配，ILIKE）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_projects(text);
create or replace function public.admin_list_projects(p_email text)
returns table (
  project_id             uuid,
  project_name           text,
  center_code            text,
  module                 text,
  owner_email            text,
  subscription_plan      text,
  subscription_active_until timestamptz,
  trial_expires_at       timestamptz,
  trial_grace_until      timestamptz,
  created_at             timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select
    p.id,
    p.name,
    p.center_code,
    p.module,
    u.email::text,
    p.subscription_plan,
    p.subscription_active_until,
    p.trial_expires_at,
    p.trial_grace_until,
    p.created_at
  from public.projects p
  join auth.users u on u.id = p.created_by
  where u.email ilike '%' || p_email || '%'
  order by p.created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. admin_adjust_trial(p_project_id, p_extra_days)
--    从「现在」或「当前到期日」两者较大值起，延长 N 天
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_adjust_trial(
  p_project_id uuid,
  p_extra_days  int default 30
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select greatest(trial_expires_at, now())
  into   v_base
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  update public.projects
  set
    trial_expires_at  = v_base + make_interval(days => p_extra_days),
    trial_grace_until = v_base + make_interval(days => p_extra_days) + interval '7 days',
    subscription_plan = 'trial'        -- 确保计划还是 trial（不影响已付费计划）
  where id = p_project_id
    and subscription_plan = 'trial';   -- 只改 trial 状态的项目，不覆盖 pro/institution

  -- 如果是付费计划，改写 active_until
  update public.projects
  set
    subscription_active_until = greatest(subscription_active_until, now())
                                + make_interval(days => p_extra_days)
  where id = p_project_id
    and subscription_plan in ('pro', 'institution');
end;
$$;

grant execute on function public.admin_adjust_trial(uuid, int) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. admin_set_partner(p_project_id, p_active_until)
--    设为合作伙伴计划（默认永久：2099-12-31）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_partner(
  p_project_id  uuid,
  p_active_until timestamptz default '2099-12-31 23:59:59+00'::timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.projects
  set
    subscription_plan         = 'partner',
    subscription_active_until = p_active_until
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_set_partner(uuid, timestamptz) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. admin_reset_to_trial(p_project_id)
--    撤回为普通试用（从今天起 30 天 + 7 天宽限）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reset_to_trial(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.projects
  set
    subscription_plan         = 'trial',
    subscription_active_until = null,
    trial_expires_at          = now() + interval '30 days',
    trial_grace_until         = now() + interval '37 days'
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_reset_to_trial(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 初始管理员：在此处插入平台管理员邮箱
-- （部署时在 Supabase SQL Editor 运行一次）
-- ──────────────────────────────────────────────────────────
-- insert into public.platform_admins (email, note)
-- values ('your-admin@example.com', '平台超级管理员')
-- on conflict (email) do nothing;
