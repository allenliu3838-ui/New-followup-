-- ============================================================
-- 0023_billing_orders.sql
-- 半自动支付中心：订单、付款凭证、审计日志
--
-- 流程：
--   用户下单 → 扫码/转账 → 上传凭证 → 管理员核验 → 开通权益
--
-- 新增：
--   1. billing_orders          — 订单表
--   2. billing_payment_proofs  — 付款凭证
--   3. billing_audit_logs      — 审计日志
--   4. 用户权益字段扩展（project_quota 等）
--   5. RPC 函数：下单、上传凭证、管理员审核、开通
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. billing_orders 订单表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_orders (
  id                  uuid        not null primary key default gen_random_uuid(),
  order_no            text        not null unique,       -- KS + YYYYMMDD + 6位随机码
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- 套餐信息
  plan_code           text        not null default 'pro'
                                  check (plan_code in ('pro','institutional')),
  billing_cycle       text        not null default 'monthly'
                                  check (billing_cycle in ('monthly','yearly')),
  project_quota       int         not null default 3,     -- 购买的项目配额
  extra_projects      int         not null default 0,     -- 超出基础3个的额外项目数

  -- 金额
  currency            text        not null default 'CNY',
  amount_due          numeric(10,2) not null,             -- 应付金额
  amount_paid         numeric(10,2),                      -- 实付金额（凭证上传时填）

  -- 支付
  payment_method      text        check (payment_method in ('wechat_qr','alipay_qr','bank_transfer')),

  -- 状态
  status              text        not null default 'unpaid'
                                  check (status in (
                                    'unpaid',                  -- 待付款
                                    'pending_verification',    -- 已提交凭证，待核验
                                    'paid',                    -- 已确认到账
                                    'activated',               -- 已开通权益
                                    'rejected',                -- 凭证驳回
                                    'cancelled',               -- 已取消
                                    'expired',                 -- 订单过期未支付
                                    'refund_pending',          -- 退款处理中
                                    'refunded'                 -- 已退款
                                  )),

  -- 付款人信息
  payer_name          text,
  payer_email         text,
  payer_hospital      text,
  payer_phone         text,

  -- 发票
  invoice_needed      boolean     not null default false,
  invoice_title       text,
  invoice_tax_no      text,
  invoice_email       text,
  invoice_status      text        default 'none'
                                  check (invoice_status in ('none','requested','issued')),

  -- 时间
  submitted_at        timestamptz,                        -- 凭证提交时间
  paid_at             timestamptz,                        -- 管理员确认到账时间
  activated_at        timestamptz,                        -- 权益开通时间
  start_at            timestamptz,                        -- 权益生效时间
  end_at              timestamptz,                        -- 权益到期时间

  -- 备注
  notes               text,                               -- 用户备注
  admin_notes         text,                               -- 管理员备注
  reject_reason       text,                               -- 驳回原因

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.billing_orders enable row level security;

-- 用户只能读自己的订单
drop policy if exists "user_own_orders_select" on billing_orders;
create policy "user_own_orders_select" on public.billing_orders
  for select using (auth.uid() = user_id);

-- 用户只能 insert 自己的订单（通过 RPC）
drop policy if exists "user_own_orders_insert" on billing_orders;
create policy "user_own_orders_insert" on public.billing_orders
  for insert with check (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. billing_payment_proofs 付款凭证表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_payment_proofs (
  id            uuid        not null primary key default gen_random_uuid(),
  order_id      uuid        not null references public.billing_orders(id) on delete cascade,
  file_url      text        not null,
  file_name     text,
  file_type     text,                                     -- image/png, application/pdf 等
  uploaded_by   uuid        not null references auth.users(id),
  created_at    timestamptz not null default now()
);

alter table public.billing_payment_proofs enable row level security;

drop policy if exists "user_own_proofs_select" on billing_payment_proofs;
create policy "user_own_proofs_select" on public.billing_payment_proofs
  for select using (auth.uid() = uploaded_by);

drop policy if exists "user_own_proofs_insert" on billing_payment_proofs;
create policy "user_own_proofs_insert" on public.billing_payment_proofs
  for insert with check (auth.uid() = uploaded_by);

-- ──────────────────────────────────────────────────────────
-- 3. billing_audit_logs 审计日志表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_audit_logs (
  id                uuid        not null primary key default gen_random_uuid(),
  order_id          uuid        not null references public.billing_orders(id) on delete cascade,
  action            text        not null,                 -- created, proof_uploaded, verified, activated, rejected, cancelled, refunded
  operator_user_id  uuid        references auth.users(id),
  before_json       jsonb,
  after_json        jsonb,
  created_at        timestamptz not null default now()
);

alter table public.billing_audit_logs enable row level security;

-- 仅管理员可读审计日志（通过 RPC）
-- 不给普通用户直接 select 权限

-- ──────────────────────────────────────────────────────────
-- 4. 用户权益扩展：在 user_profiles 加 project_quota
-- ──────────────────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists project_quota int not null default 3;

-- ──────────────────────────────────────────────────────────
-- 5. 生成订单号的辅助函数
-- ──────────────────────────────────────────────────────────
create or replace function public.generate_order_no()
returns text
language plpgsql
as $$
declare
  v_date text;
  v_rand text;
  v_no   text;
begin
  v_date := to_char(now(), 'YYYYMMDD');
  -- 6位随机十六进制
  v_rand := upper(substr(md5(gen_random_uuid()::text), 1, 6));
  v_no   := 'KS' || v_date || v_rand;
  -- 碰撞检查
  while exists (select 1 from public.billing_orders where order_no = v_no) loop
    v_rand := upper(substr(md5(gen_random_uuid()::text), 1, 6));
    v_no   := 'KS' || v_date || v_rand;
  end loop;
  return v_no;
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 6. create_billing_order() — 用户下单
-- ──────────────────────────────────────────────────────────
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
begin
  -- 验证参数
  if p_plan_code not in ('pro','institutional') then
    raise exception 'invalid_plan_code';
  end if;
  if p_billing_cycle not in ('monthly','yearly') then
    raise exception 'invalid_billing_cycle';
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
    invoice_needed, invoice_title, invoice_tax_no, invoice_email,
    notes, status
  ) values (
    v_order_no, auth.uid(), p_plan_code, p_billing_cycle,
    v_quota, v_extra, v_amount,
    p_payment_method,
    p_payer_name, p_payer_email, p_payer_hospital, p_payer_phone,
    coalesce(p_invoice_needed, false), p_invoice_title, p_invoice_tax_no, p_invoice_email,
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

grant execute on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. submit_payment_proof() — 用户上传凭证
-- ──────────────────────────────────────────────────────────
create or replace function public.submit_payment_proof(
  p_order_id      uuid,
  p_file_url      text,
  p_file_name     text      default null,
  p_file_type     text      default null,
  p_amount_paid   numeric   default null,
  p_payment_method text     default null,
  p_payer_name    text      default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 校验订单归属
  if not exists (
    select 1 from public.billing_orders
    where id = p_order_id and user_id = auth.uid()
      and status in ('unpaid', 'rejected')
  ) then
    raise exception 'order_not_found_or_not_payable';
  end if;

  -- 保存凭证
  insert into public.billing_payment_proofs (order_id, file_url, file_name, file_type, uploaded_by)
  values (p_order_id, p_file_url, p_file_name, p_file_type, auth.uid());

  -- 更新订单状态
  update public.billing_orders
  set
    status          = 'pending_verification',
    submitted_at    = now(),
    amount_paid     = coalesce(p_amount_paid, amount_paid),
    payment_method  = coalesce(p_payment_method, payment_method),
    payer_name      = coalesce(p_payer_name, payer_name),
    updated_at      = now()
  where id = p_order_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id)
  values (p_order_id, 'proof_uploaded', auth.uid());
end;
$$;

grant execute on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. get_my_orders() — 用户查看自己的订单列表
-- ──────────────────────────────────────────────────────────
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
  reject_reason   text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, order_no, plan_code, billing_cycle, project_quota,
         amount_due, amount_paid, payment_method, status,
         start_at, end_at, created_at, submitted_at, reject_reason
  from public.billing_orders
  where user_id = auth.uid()
  order by created_at desc;
$$;

grant execute on function public.get_my_orders() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 9. admin_list_orders() — 管理员查看所有订单
-- ──────────────────────────────────────────────────────────
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
    o.invoice_needed, o.invoice_status,
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

-- ──────────────────────────────────────────────────────────
-- 10. admin_get_order_proofs() — 管理员查看订单凭证
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_get_order_proofs(p_order_id uuid)
returns table (
  id          uuid,
  file_url    text,
  file_name   text,
  file_type   text,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select bp.id, bp.file_url, bp.file_name, bp.file_type, bp.created_at
  from public.billing_payment_proofs bp
  where bp.order_id = p_order_id
  order by bp.created_at desc;
end;
$$;

grant execute on function public.admin_get_order_proofs(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 11. admin_verify_order() — 管理员确认到账并开通
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
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select * into v_order from public.billing_orders where id = p_order_id;
  if not found then
    raise exception 'order_not_found';
  end if;

  if v_order.status not in ('pending_verification', 'unpaid', 'paid') then
    raise exception 'order_status_invalid: %', v_order.status;
  end if;

  -- 计算生效/到期时间
  -- 如果用户还有剩余订阅，从到期日顺延
  v_start := coalesce(p_start_at, now());
  if v_order.billing_cycle = 'monthly' then
    v_end := coalesce(p_end_at, v_start + interval '1 month');
  else
    v_end := coalesce(p_end_at, v_start + interval '1 year');
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
    project_quota = v_order.project_quota,
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
    'plan_code', v_order.plan_code
  ));
end;
$$;

grant execute on function public.admin_verify_order(uuid, timestamptz, timestamptz, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 12. admin_reject_order() — 管理员驳回凭证
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

grant execute on function public.admin_reject_order(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 13. 创建凭证上传的 Storage bucket
-- ──────────────────────────────────────────────────────────
-- NOTE: Supabase Storage bucket 需要在 Supabase Dashboard 创建：
--   名称：payment-proofs
--   公开：否（私有）
--   允许上传文件类型：image/png, image/jpeg, image/webp, application/pdf
--   最大文件大小：10MB

-- ──────────────────────────────────────────────────────────
-- 14. 用户项目配额检查函数
-- ──────────────────────────────────────────────────────────
create or replace function public.check_project_quota()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_quota   int;
  v_used    int;
begin
  select coalesce(project_quota, 3)
  into v_quota
  from public.user_profiles
  where user_id = auth.uid();

  -- 如果没有 profile，默认配额 3
  if not found then
    v_quota := 3;
  end if;

  select count(*)::int into v_used
  from public.projects
  where created_by = auth.uid();

  return jsonb_build_object(
    'quota', v_quota,
    'used', v_used,
    'remaining', greatest(v_quota - v_used, 0)
  );
end;
$$;

grant execute on function public.check_project_quota() to authenticated;

-- END
