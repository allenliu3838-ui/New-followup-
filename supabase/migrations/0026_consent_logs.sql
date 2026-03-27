-- ============================================================
-- 0026_consent_logs.sql
-- 用户同意记录：注册、支付、资料提交时记录政策版本与时间戳
-- ============================================================

create table if not exists public.consent_logs (
  id              uuid        not null primary key default gen_random_uuid(),
  user_id         uuid        references auth.users(id) on delete set null,
  action          text        not null,               -- 'register', 'checkout', 'profile_submit', 'contract_apply'
  policy_type     text        not null,               -- 'terms', 'privacy', 'both'
  policy_version  text        not null default 'v1.0',
  ip_address      text,                               -- 可选，由前端传入或 Edge Function 注入
  user_agent      text,                               -- 可选
  created_at      timestamptz not null default now()
);

alter table public.consent_logs enable row level security;

-- 用户只能插入自己的记录
drop policy if exists "consent_insert_own" on consent_logs;
create policy "consent_insert_own" on public.consent_logs
  for insert with check (auth.uid() = user_id);

-- 用户只能读取自己的记录
drop policy if exists "consent_select_own" on consent_logs;
create policy "consent_select_own" on public.consent_logs
  for select using (auth.uid() = user_id);

-- RPC 函数：记录用户同意
create or replace function public.log_consent(
  p_action        text,
  p_policy_type   text default 'both',
  p_policy_version text default 'v1.0',
  p_ip_address    text default null,
  p_user_agent    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.consent_logs (user_id, action, policy_type, policy_version, ip_address, user_agent)
  values (auth.uid(), p_action, p_policy_type, p_policy_version, p_ip_address, p_user_agent);
end;
$$;

grant execute on function public.log_consent(text, text, text, text, text) to authenticated;

-- 管理员查询所有同意记录
create or replace function public.admin_list_consent_logs(p_user_email text default null)
returns setof consent_logs
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  if p_user_email is not null then
    return query
      select cl.* from consent_logs cl
      join auth.users u on u.id = cl.user_id
      where u.email ilike '%' || p_user_email || '%'
      order by cl.created_at desc
      limit 100;
  else
    return query
      select * from consent_logs
      order by created_at desc
      limit 200;
  end if;
end;
$$;

grant execute on function public.admin_list_consent_logs(text) to authenticated;
