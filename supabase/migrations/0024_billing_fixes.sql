-- ============================================================
-- 0024_billing_fixes.sql
-- 修复 billing 系统关键问题
--
-- 1. 添加索引（性能）
-- 2. 修复续费顺延逻辑（从到期日延续，不覆盖）
-- 3. 行锁防止并发操作
-- 4. 审计日志 RLS 防直接访问
-- 5. 订单过期自动标记函数
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. 添加索引
-- ──────────────────────────────────────────────────────────
create index if not exists idx_billing_orders_user_id
  on public.billing_orders(user_id);

create index if not exists idx_billing_orders_status
  on public.billing_orders(status);

create index if not exists idx_billing_orders_created_at
  on public.billing_orders(created_at desc);

create index if not exists idx_billing_payment_proofs_order_id
  on public.billing_payment_proofs(order_id);

-- ──────────────────────────────────────────────────────────
-- 2. 审计日志：禁止直接 SELECT（只能通过管理员 RPC）
-- ──────────────────────────────────────────────────────────
drop policy if exists "no_direct_access" on billing_audit_logs;
create policy "no_direct_access" on public.billing_audit_logs
  for select using (false);

-- ──────────────────────────────────────────────────────────
-- 3. 修复 admin_verify_order()：续费顺延 + 行锁
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_verify_order(
  p_order_id    uuid,
  p_start_at    timestamptz default null,
  p_end_at      timestamptz default null,
  p_admin_notes text        default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        public.billing_orders%rowtype;
  v_start        timestamptz;
  v_end          timestamptz;
  v_existing_end timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  -- 行锁：防止并发操作
  select * into v_order
  from public.billing_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order_not_found';
  end if;

  if v_order.status not in ('pending_verification', 'unpaid', 'paid') then
    raise exception 'order_status_invalid: %', v_order.status;
  end if;

  -- 续费顺延：如果用户有活跃订阅，从到期日开始延续
  if p_start_at is not null then
    v_start := p_start_at;
  else
    select max(end_at) into v_existing_end
    from public.billing_orders
    where user_id = v_order.user_id
      and status = 'activated'
      and end_at > now();

    -- 如果有未到期订阅，从到期日顺延；否则从现在开始
    v_start := coalesce(v_existing_end, now());
  end if;

  if p_end_at is not null then
    v_end := p_end_at;
  elsif v_order.billing_cycle = 'monthly' then
    v_end := v_start + interval '1 month';
  else
    v_end := v_start + interval '1 year';
  end if;

  -- 更新订单
  update public.billing_orders
  set
    status       = 'activated',
    paid_at      = coalesce(paid_at, now()),
    activated_at = now(),
    start_at     = v_start,
    end_at       = v_end,
    admin_notes  = coalesce(p_admin_notes, admin_notes),
    updated_at   = now()
  where id = p_order_id;

  -- 更新用户项目配额
  update public.user_profiles
  set
    project_quota = greatest(project_quota, v_order.project_quota),
    updated_at    = now()
  where user_id = v_order.user_id;

  -- 升级该用户所有项目的订阅
  update public.projects
  set
    subscription_plan         = v_order.plan_code,
    subscription_active_until = v_end
  where created_by = v_order.user_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (p_order_id, 'activated', auth.uid(), jsonb_build_object(
    'start_at', v_start, 'end_at', v_end,
    'project_quota', v_order.project_quota,
    'plan_code', v_order.plan_code,
    'renewed_from', v_existing_end
  ));
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 4. 修复 admin_reject_order()：也加行锁
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reject_order(
  p_order_id      uuid,
  p_reject_reason text default null
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

  update public.billing_orders
  set
    status        = 'rejected',
    reject_reason = p_reject_reason,
    updated_at    = now()
  where id = p_order_id
    and status = 'pending_verification';

  if not found then
    raise exception 'order_not_found_or_not_pending';
  end if;

  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (p_order_id, 'rejected', auth.uid(), jsonb_build_object('reason', p_reject_reason));
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 5. 过期订单自动标记函数（可手动或定时调用）
-- ──────────────────────────────────────────────────────────
create or replace function public.expire_old_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.billing_orders
  set status = 'expired', updated_at = now()
  where status = 'unpaid'
    and created_at < now() - interval '30 days';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- END
