-- ──────────────────────────────────────────────────────────
-- Migration 0025: 支持个人发票类型
--
-- 问题：原发票字段仅支持单位/企业发票（需要税号），
--       个人付费用户无税号，无法申请发票。
-- 方案：新增 invoice_type 列区分 personal / company，
--       个人发票仅需姓名与邮箱，不强制税号。
-- ──────────────────────────────────────────────────────────

-- 1. 在 billing_orders 表新增 invoice_type 列
alter table public.billing_orders
  add column if not exists invoice_type text
    check (invoice_type in ('personal', 'company'))
    default 'company';

-- 2. 更新 create_billing_order() — 接受 invoice_type 参数
create or replace function public.create_billing_order(
  p_plan_code       text,
  p_billing_cycle   text,
  p_extra_projects  int       default 0,
  p_payment_method  text      default null,
  p_payer_name      text      default null,
  p_payer_email     text      default null,
  p_payer_hospital  text      default null,
  p_payer_phone     text      default null,
  p_invoice_needed  boolean   default false,
  p_invoice_type    text      default 'company',
  p_invoice_title   text      default null,
  p_invoice_tax_no  text      default null,
  p_invoice_email   text      default null,
  p_notes           text      default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_no      text;
  v_amount        numeric(10,2);
  v_extra         int;
  v_quota         int;
  v_order_id      uuid;
  v_inv_type      text;
begin
  -- 验证参数
  if p_plan_code not in ('pro','institutional') then
    raise exception 'invalid_plan_code';
  end if;
  if p_billing_cycle not in ('monthly','yearly') then
    raise exception 'invalid_billing_cycle';
  end if;
  -- 发票类型校验
  v_inv_type := coalesce(p_invoice_type, 'company');
  if v_inv_type not in ('personal', 'company') then
    raise exception 'invalid_invoice_type';
  end if;

  v_extra := greatest(coalesce(p_extra_projects, 0), 0);
  v_quota := 3 + v_extra;

  -- 价格计算：Pro 含 3 个项目
  if p_billing_cycle = 'monthly' then
    v_amount := 499 + v_extra * 99;
  else
    v_amount := 4790 + v_extra * 950;
  end if;

  v_order_no := public.generate_order_no();

  insert into public.billing_orders (
    order_no, user_id, plan_code, billing_cycle,
    project_quota, extra_projects, amount_due,
    payment_method,
    payer_name, payer_email, payer_hospital, payer_phone,
    invoice_needed, invoice_type, invoice_title, invoice_tax_no, invoice_email,
    notes, status
  ) values (
    v_order_no, auth.uid(), p_plan_code, p_billing_cycle,
    v_quota, v_extra, v_amount,
    p_payment_method,
    p_payer_name, p_payer_email, p_payer_hospital, p_payer_phone,
    coalesce(p_invoice_needed, false), v_inv_type,
    p_invoice_title, p_invoice_tax_no, p_invoice_email,
    p_notes, 'unpaid'
  )
  returning id into v_order_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (v_order_id, 'created', auth.uid(), jsonb_build_object(
    'order_no', v_order_no, 'plan_code', p_plan_code,
    'billing_cycle', p_billing_cycle, 'amount_due', v_amount,
    'project_quota', v_quota
  ));

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_no', v_order_no,
    'amount_due', v_amount,
    'project_quota', v_quota
  );
end;
$$;

grant execute on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text,text) to authenticated;

-- 3. 更新 get_my_orders() — 返回发票相关字段，方便用户确认开票信息
create or replace function public.get_my_orders()
returns table (
  id              uuid,
  order_no        text,
  plan_code       text,
  billing_cycle   text,
  project_quota   int,
  amount_due      numeric,
  amount_paid     numeric,
  payment_method  text,
  status          text,
  start_at        timestamptz,
  end_at          timestamptz,
  created_at      timestamptz,
  submitted_at    timestamptz,
  reject_reason   text,
  invoice_needed  boolean,
  invoice_type    text,
  invoice_title   text,
  invoice_status  text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, order_no, plan_code, billing_cycle, project_quota,
         amount_due, amount_paid, payment_method, status,
         start_at, end_at, created_at, submitted_at, reject_reason,
         invoice_needed, invoice_type, invoice_title, invoice_status
  from public.billing_orders
  where user_id = auth.uid()
  order by created_at desc;
$$;

grant execute on function public.get_my_orders() to authenticated;

-- 4. 更新 admin_list_orders() — 返回完整发票字段供管理员开票
create or replace function public.admin_list_orders(
  p_status text default null
)
returns table (
  id              uuid,
  order_no        text,
  user_id         uuid,
  owner_email     text,
  real_name       text,
  hospital        text,
  plan_code       text,
  billing_cycle   text,
  project_quota   int,
  amount_due      numeric,
  amount_paid     numeric,
  payment_method  text,
  status          text,
  payer_name      text,
  payer_email     text,
  payer_hospital  text,
  invoice_needed  boolean,
  invoice_type    text,
  invoice_title   text,
  invoice_tax_no  text,
  invoice_email   text,
  invoice_status  text,
  submitted_at    timestamptz,
  paid_at         timestamptz,
  activated_at    timestamptz,
  start_at        timestamptz,
  end_at          timestamptz,
  notes           text,
  admin_notes     text,
  reject_reason   text,
  created_at      timestamptz,
  proof_count     bigint
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
    o.id, o.order_no, o.user_id, u.email::text,
    pr.real_name, pr.hospital,
    o.plan_code, o.billing_cycle, o.project_quota,
    o.amount_due, o.amount_paid, o.payment_method,
    o.status, o.payer_name, o.payer_email, o.payer_hospital,
    o.invoice_needed, o.invoice_type,
    o.invoice_title, o.invoice_tax_no, o.invoice_email,
    o.invoice_status,
    o.submitted_at, o.paid_at, o.activated_at,
    o.start_at, o.end_at,
    o.notes, o.admin_notes, o.reject_reason,
    o.created_at,
    (select count(*) from public.billing_payment_proofs bp where bp.order_id = o.id)
  from public.billing_orders o
  join auth.users u on u.id = o.user_id
  left join public.user_profiles pr on pr.user_id = o.user_id
  where (p_status is null or o.status = p_status)
  order by
    case o.status
      when 'pending_verification' then 0
      when 'unpaid' then 1
      when 'paid' then 2
      when 'activated' then 3
      else 4
    end,
    o.created_at desc;
end;
$$;

grant execute on function public.admin_list_orders(text) to authenticated;
