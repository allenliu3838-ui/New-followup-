-- ============================================================
-- 0022_admin_status_permissions.sql
-- 管理员状态权限增强
--
-- 新增：
--   1. 管理员永久写入豁免 — assert_project_write_allowed 检查创建者是否为管理员
--   2. admin_cancel_contract()   — 取消已批准/待审的合同
--   3. admin_update_contract()   — 修改合同字段（付款状态、到期时间、套餐等）
--   4. admin_set_expiry()        — 直接设定项目到期日期
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. 更新 assert_project_write_allowed：管理员项目永久放行
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
  v_created_by     uuid;
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until, created_by
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until, v_created_by
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- Rule 0: 项目创建者是平台管理员 → 永久放行
  if exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = v_created_by
  ) then
    return;
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
-- 2. admin_cancel_contract() — 取消合同（pending/approved → cancelled）
--    同时撤销该用户项目的订阅（如果已激活过）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_cancel_contract(
  p_contract_id uuid,
  p_admin_note  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status  text;
  v_payment text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select user_id, status, payment_status
  into   v_user_id, v_status, v_payment
  from   public.partner_contracts
  where  id = p_contract_id;

  if not found then
    raise exception 'contract_not_found';
  end if;

  if v_status not in ('pending', 'approved') then
    raise exception 'only_pending_or_approved_can_cancel';
  end if;

  -- 取消合同
  update public.partner_contracts
  set
    status         = 'cancelled',
    admin_note     = coalesce(p_admin_note, admin_note),
    updated_at     = now()
  where id = p_contract_id;

  -- 如果已经付款激活过，撤销该用户所有项目的订阅 → 回到试用
  if v_payment = 'paid' then
    update public.projects
    set
      subscription_plan         = 'trial',
      subscription_active_until = null,
      trial_expires_at          = now() + interval '30 days',
      trial_grace_until         = now() + interval '37 days'
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_cancel_contract(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. admin_update_contract() — 通用合同更新
--    可修改：付款状态、到期时间、套餐、年费、折扣、备注
--    同时同步更新该用户的项目订阅
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_update_contract(
  p_contract_id      uuid,
  p_payment_status   text         default null,   -- 'unpaid'/'paid'/'overdue'
  p_expires_at       timestamptz  default null,
  p_plan             text         default null,   -- 'pro'/'institution'/'partner'
  p_annual_price     numeric      default null,
  p_discount_pct     int          default null,
  p_admin_note       text         default null
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

  -- 更新合同字段（只更新传入的非 null 参数）
  update public.partner_contracts
  set
    payment_status   = coalesce(p_payment_status, payment_status),
    expires_at       = coalesce(p_expires_at, expires_at),
    plan             = coalesce(p_plan, plan),
    annual_price_cny = coalesce(p_annual_price, annual_price_cny),
    discount_pct     = coalesce(p_discount_pct, discount_pct),
    admin_note       = coalesce(p_admin_note, admin_note),
    paid_at          = case
                         when p_payment_status = 'paid' and paid_at is null then now()
                         else paid_at
                       end,
    activated_at     = case
                         when p_payment_status = 'paid' and activated_at is null then now()
                         else activated_at
                       end,
    updated_at       = now()
  where id = p_contract_id
    and status in ('pending', 'approved');

  if not found then
    raise exception 'contract_not_found_or_not_editable';
  end if;

  -- 读取更新后的合同数据，同步到用户项目
  select user_id, coalesce(plan, apply_plan), expires_at
  into   v_user_id, v_plan, v_expires
  from   public.partner_contracts
  where  id = p_contract_id;

  -- 如果付款状态为 paid，同步更新项目订阅
  if coalesce(p_payment_status, (select payment_status from public.partner_contracts where id = p_contract_id)) = 'paid' then
    update public.projects
    set
      subscription_plan         = v_plan,
      subscription_active_until = v_expires
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_update_contract(uuid, text, timestamptz, text, numeric, int, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. admin_set_expiry() — 直接设定项目到期日期
--    可以同时修改 subscription_plan
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_expiry(
  p_project_id   uuid,
  p_expires_at   timestamptz,
  p_plan         text default null  -- 可选：同时修改计划
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_plan text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select subscription_plan into v_current_plan
  from public.projects where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- 根据当前计划更新对应字段
  if coalesce(p_plan, v_current_plan) = 'trial' then
    update public.projects
    set
      subscription_plan = 'trial',
      trial_expires_at  = p_expires_at,
      trial_grace_until = p_expires_at + interval '7 days'
    where id = p_project_id;
  else
    update public.projects
    set
      subscription_plan         = coalesce(p_plan, v_current_plan),
      subscription_active_until = p_expires_at
    where id = p_project_id;
  end if;
end;
$$;

grant execute on function public.admin_set_expiry(uuid, timestamptz, text) to authenticated;
