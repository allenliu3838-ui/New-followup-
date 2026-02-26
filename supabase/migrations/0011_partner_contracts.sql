-- ============================================================
-- 0011_partner_contracts.sql
-- 合作伙伴申请 & 合同管理
--
-- 流程：
--   用户提交申请 → 管理员审批（录价格/折扣）→ 收款后激活 → 自动开通权益
--
-- 新增：
--   1. partner_contracts 表
--   2. apply_partner_contract()   — 用户提交申请
--   3. get_my_contract()          — 用户查看自己的最新合同
--   4. admin_list_contracts()     — 管理员查看所有合同（带用户资料）
--   5. admin_review_contract()    — 管理员审批（录价格/折扣/备注）
--   6. admin_reject_contract()    — 管理员拒绝
--   7. admin_activate_contract()  — 确认收款并激活权益（更新所有该用户项目）
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. partner_contracts 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.partner_contracts (
  id               uuid        not null primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,

  -- 用户申请时填写
  apply_plan       text        not null default 'institution'
                               check (apply_plan in ('pro','institution')),
  apply_note       text,                              -- 申请说明（研究方向、中心数等）
  applied_at       timestamptz not null default now(),

  -- 管理员审批字段
  status           text        not null default 'pending'
                               check (status in ('pending','approved','rejected','cancelled')),
  discount_pct     int         check (discount_pct between 1 and 99),  -- 40 = 6折（优惠40%）
  plan             text        check (plan in ('pro','institution','partner')),
  annual_price_cny numeric(10,2),                    -- 协议年费（元）
  payment_status   text        not null default 'unpaid'
                               check (payment_status in ('unpaid','paid','overdue')),
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text,                             -- 管理员备注

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.partner_contracts enable row level security;

-- 用户只能读自己的合同
DROP POLICY IF EXISTS "user_own_contracts_select" ON partner_contracts;
create policy "user_own_contracts_select" on public.partner_contracts
  for select using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. apply_partner_contract() — 用户提交申请
--    每个用户只能有一条 pending/approved 合同
-- ──────────────────────────────────────────────────────────
create or replace function public.apply_partner_contract(
  p_plan text default 'institution',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- 检查是否已有进行中的申请
  if exists (
    select 1 from public.partner_contracts
    where user_id = auth.uid()
      and status in ('pending', 'approved')
  ) then
    raise exception 'contract_already_active: 已有进行中的申请或合同，如需变更请联系平台';
  end if;

  if p_plan not in ('pro', 'institution') then
    raise exception 'invalid_plan';
  end if;

  insert into public.partner_contracts (user_id, apply_plan, apply_note)
  values (auth.uid(), p_plan, p_note)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.apply_partner_contract(text, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. get_my_contract() — 用户查看自己最新合同状态
-- ──────────────────────────────────────────────────────────
drop function if exists public.get_my_contract();
create or replace function public.get_my_contract()
returns table (
  id               uuid,
  apply_plan       text,
  apply_note       text,
  applied_at       timestamptz,
  status           text,
  discount_pct     int,
  plan             text,
  annual_price_cny numeric,
  payment_status   text,
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, apply_plan, apply_note, applied_at,
         status, discount_pct, plan, annual_price_cny,
         payment_status, paid_at, activated_at, expires_at, admin_note
  from public.partner_contracts
  where user_id = auth.uid()
  order by created_at desc
  limit 1;
$$;

grant execute on function public.get_my_contract() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. admin_list_contracts() — 管理员查看所有合同
--    可按 status 过滤（null = 全部）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_contracts(text);
create or replace function public.admin_list_contracts(
  p_status text default null   -- 'pending' / 'approved' / null(全部)
)
returns table (
  contract_id      uuid,
  user_id          uuid,
  owner_email      text,
  -- 用户资料
  real_name        text,
  hospital         text,
  department       text,
  contact          text,
  profile_notes    text,
  -- 申请信息
  apply_plan       text,
  apply_note       text,
  applied_at       timestamptz,
  -- 合同状态
  status           text,
  discount_pct     int,
  plan             text,
  annual_price_cny numeric,
  payment_status   text,
  paid_at          timestamptz,
  activated_at     timestamptz,
  expires_at       timestamptz,
  admin_note       text,
  created_at       timestamptz
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
    c.id,
    c.user_id,
    u.email::text,
    pr.real_name,
    pr.hospital,
    pr.department,
    pr.contact,
    pr.notes,
    c.apply_plan,
    c.apply_note,
    c.applied_at,
    c.status,
    c.discount_pct,
    c.plan,
    c.annual_price_cny,
    c.payment_status,
    c.paid_at,
    c.activated_at,
    c.expires_at,
    c.admin_note,
    c.created_at
  from public.partner_contracts c
  join auth.users u on u.id = c.user_id
  left join public.user_profiles pr on pr.user_id = c.user_id
  where (p_status is null or c.status = p_status)
  order by
    case c.status when 'pending' then 0 when 'approved' then 1 else 2 end,
    c.applied_at desc;
end;
$$;

grant execute on function public.admin_list_contracts(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. admin_review_contract() — 管理员审批（录价格/折扣）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_review_contract(
  p_contract_id    uuid,
  p_discount_pct   int          default null,   -- 如 40 = 优惠40% = 6折
  p_plan           text         default null,   -- 实际授予计划
  p_annual_price   numeric      default null,   -- 协议年费（元）
  p_admin_note     text         default null
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

  update public.partner_contracts
  set
    status           = 'approved',
    discount_pct     = coalesce(p_discount_pct, discount_pct),
    plan             = coalesce(p_plan,         apply_plan),
    annual_price_cny = coalesce(p_annual_price, annual_price_cny),
    admin_note       = coalesce(p_admin_note,   admin_note),
    updated_at       = now()
  where id = p_contract_id
    and status = 'pending';

  if not found then
    raise exception 'contract_not_found_or_not_pending';
  end if;
end;
$$;

grant execute on function public.admin_review_contract(uuid,int,text,numeric,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. admin_reject_contract() — 管理员拒绝申请
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reject_contract(
  p_contract_id uuid,
  p_admin_note  text default null
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

  update public.partner_contracts
  set status = 'rejected', admin_note = p_admin_note, updated_at = now()
  where id = p_contract_id and status = 'pending';

  if not found then
    raise exception 'contract_not_found_or_not_pending';
  end if;
end;
$$;

grant execute on function public.admin_reject_contract(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. admin_activate_contract() — 确认收款并激活
--    同时更新该用户名下所有项目的订阅
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_activate_contract(
  p_contract_id uuid,
  p_expires_at  timestamptz default null   -- 默认一年后
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_plan     text;
  v_expires  timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select user_id, coalesce(plan, apply_plan), coalesce(p_expires_at, now() + interval '1 year')
  into   v_user_id, v_plan, v_expires
  from   public.partner_contracts
  where  id = p_contract_id
    and  status = 'approved';

  if not found then
    raise exception 'contract_not_found_or_not_approved';
  end if;

  -- 更新合同
  update public.partner_contracts
  set
    payment_status = 'paid',
    paid_at        = now(),
    activated_at   = now(),
    expires_at     = v_expires,
    updated_at     = now()
  where id = p_contract_id;

  -- 该用户名下所有项目升级
  update public.projects
  set
    subscription_plan         = v_plan,
    subscription_active_until = v_expires
  where created_by = v_user_id;
end;
$$;

grant execute on function public.admin_activate_contract(uuid, timestamptz) to authenticated;
