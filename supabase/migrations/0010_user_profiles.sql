-- ============================================================
-- 0010_user_profiles.sql
-- 用户资料表 + 管理员搜索结果带完整信息
--
-- 新增：
--   1. user_profiles 表         — 研究者姓名/医院/科室/意向/联系方式
--   2. upsert_my_profile()      — 用户自己保存/更新资料（RPC 供前端调用）
--   3. 更新 admin_list_projects  — 搜索结果附带所有资料字段
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. user_profiles 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  user_id         uuid        not null primary key
                              references auth.users(id) on delete cascade,
  real_name       text,                        -- 姓名
  hospital        text,                        -- 医院/单位
  department      text,                        -- 科室
  interested_plan text,                        -- 意向套餐（仅参考，实际权益由管理员设置）
  contact         text,                        -- 联系方式（微信/手机，可选）
  notes           text,                        -- 备注
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- 用户只能读写自己的资料
create policy "user_own_profile_select" on public.user_profiles
  for select using (auth.uid() = user_id);

create policy "user_own_profile_insert" on public.user_profiles
  for insert with check (auth.uid() = user_id);

create policy "user_own_profile_update" on public.user_profiles
  for update using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. upsert_my_profile() — 用户自己保存资料
--    前端用 authenticated key 调用即可
-- ──────────────────────────────────────────────────────────
create or replace function public.upsert_my_profile(
  p_real_name       text default null,
  p_hospital        text default null,
  p_department      text default null,
  p_interested_plan text default null,
  p_contact         text default null,
  p_notes           text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles
    (user_id, real_name, hospital, department, interested_plan, contact, notes, updated_at)
  values
    (auth.uid(), p_real_name, p_hospital, p_department,
     p_interested_plan, p_contact, p_notes, now())
  on conflict (user_id) do update set
    real_name       = excluded.real_name,
    hospital        = excluded.hospital,
    department      = excluded.department,
    interested_plan = excluded.interested_plan,
    contact         = excluded.contact,
    notes           = excluded.notes,
    updated_at      = now();
end;
$$;

grant execute on function public.upsert_my_profile(text,text,text,text,text,text)
  to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. 更新 admin_list_projects — 附带 user_profiles 全部字段
--    （替换 0009 中的同名函数，需先 drop 旧签名）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_projects(text);

create or replace function public.admin_list_projects(p_email text)
returns table (
  -- 项目字段
  project_id                uuid,
  project_name              text,
  center_code               text,
  module                    text,
  owner_email               text,
  subscription_plan         text,
  subscription_active_until timestamptz,
  trial_expires_at          timestamptz,
  trial_grace_until         timestamptz,
  project_created_at        timestamptz,
  -- 用户资料字段
  real_name                 text,
  hospital                  text,
  department                text,
  interested_plan           text,
  contact                   text,
  profile_notes             text,
  profile_updated_at        timestamptz
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
    p.created_at,
    -- user_profiles（未填写时全部为 NULL）
    pr.real_name,
    pr.hospital,
    pr.department,
    pr.interested_plan,
    pr.contact,
    pr.notes,
    pr.updated_at
  from public.projects p
  join auth.users u on u.id = p.created_by
  left join public.user_profiles pr on pr.user_id = p.created_by
  where u.email ilike '%' || p_email || '%'
  order by p.created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to authenticated;
