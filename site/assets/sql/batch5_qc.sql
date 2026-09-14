-- GENERATED compatibility batch 5/6; execute all six in order, stop on error.
-- MIGRATION 026: 0024_billing_fixes.sql
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

-- MIGRATION 027: 0025_personal_invoice.sql
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
drop function if exists public.get_my_orders();
create function public.get_my_orders()
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
drop function if exists public.admin_list_orders(text);
create function public.admin_list_orders(
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

-- MIGRATION 028: 0026_consent_logs.sql
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

-- MIGRATION 029: 0027_storage_policy_fix.sql
-- ============================================================
-- 0027_storage_policy_fix.sql
-- 创建 payment-proofs bucket + 修复 storage policy
--
-- 问题：
--   1. bucket 可能尚未创建
--   2. 现有 policy applied to public（匿名可访问）
--   3. 缺少路径隔离（用户可读写他人文件）
--
-- 修复：
--   - 创建 bucket（如不存在）
--   - 删除旧 policy
--   - 新建 policy：仅 authenticated 用户可操作
--   - INSERT/SELECT/DELETE 均按 auth.uid() 路径隔离
--   - 上传路径格式：{user_id}/{order_id}/{timestamp}.{ext}
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 0. 创建 bucket（如不存在）
-- ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs',
  'payment-proofs',
  false,                                                    -- 私有
  10485760,                                                 -- 10MB
  array['image/png','image/jpeg','image/webp','application/pdf']
)
on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────
-- 1. 删除所有已存在的 policy（旧的 + 新的，保证幂等）
-- ──────────────────────────────────────────────────────────
drop policy if exists "payment_proofs_user_read" on storage.objects;
drop policy if exists "payment_proofs_user_upload" on storage.objects;
drop policy if exists "payment_proofs_insert_own" on storage.objects;
drop policy if exists "payment_proofs_select_own" on storage.objects;
drop policy if exists "payment_proofs_delete_own" on storage.objects;

-- ──────────────────────────────────────────────────────────
-- 2. INSERT — 仅允许已登录用户上传到自己的目录
--    路径第一段必须是 auth.uid()
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 3. SELECT — 仅允许已登录用户读取自己目录下的文件
--    管理员通过 signed URL (service_role) 访问他人凭证
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 4. DELETE — 仅允许用户删除自己目录下的文件（可选）
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 5. UPDATE — 禁止更新已上传的凭证（不创建 update policy）
--    凭证一旦上传即不可修改，只能删除重传
-- ──────────────────────────────────────────────────────────
-- 不创建 update policy = 默认禁止 update

-- MIGRATION 030: 0028_remove_pgcrypto_dependency.sql
-- 修复：gen_random_bytes(integer) does not exist
-- 原因：pgcrypto 扩展未启用时 gen_random_bytes() 和 digest() 不可用
-- 修复：改用 PostgreSQL 内置函数：
--   gen_random_bytes(16) → gen_random_uuid()（内置，PG13+）
--   digest(x,'sha256')   → sha256(x::bytea)  （内置，PG11+）

DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
  p_token       text,
  p_visit_date  date,
  p_sbp         numeric DEFAULT NULL,
  p_dbp         numeric DEFAULT NULL,
  p_scr_umol_l  numeric DEFAULT NULL,
  p_upcr        numeric DEFAULT NULL,
  p_egfr        numeric DEFAULT NULL,
  p_notes       text    DEFAULT NULL
)
RETURNS TABLE(
  visit_id           uuid,
  server_time        timestamptz,
  receipt_token      text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_row    patient_tokens%ROWTYPE;
  v_project_row  projects%ROWTYPE;
  v_visit_id     uuid;
  v_receipt      text;
  v_expires      timestamptz;
  v_recent_count int;
  v_same_day     int;
BEGIN
  -- ① 查 token，验证有效性
  SELECT * INTO v_token_row
  FROM patient_tokens t
  WHERE t.token = p_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found' USING HINT = 'token无效，请确认链接正确';
  END IF;

  -- ② token 是否已撤销
  IF v_token_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_revoked'
      USING HINT = '该随访链接已被管理员撤销：' || COALESCE(v_token_row.revoke_reason, '无原因说明');
  END IF;

  -- ③ token 是否已过期
  IF v_token_row.expires_at IS NOT NULL AND v_token_row.expires_at < now() THEN
    RAISE EXCEPTION 'token_expired' USING HINT = '随访链接已过期，请联系管理员重新生成';
  END IF;

  -- ④ token 是否仍激活
  IF NOT v_token_row.active THEN
    RAISE EXCEPTION 'token_inactive' USING HINT = '随访链接已停用';
  END IF;

  -- ⑤ 单次 token：已用过则拒绝
  IF v_token_row.single_use AND v_token_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_already_used'
      USING HINT = '该单次链接已于 ' || v_token_row.used_at::text || ' 提交过，如需重填请联系管理员';
  END IF;

  -- ⑥ 查项目
  SELECT * INTO v_project_row FROM projects WHERE id = v_token_row.project_id;

  -- ⑦ 检查写入权限（订阅/试用状态）
  PERFORM assert_project_write_allowed(v_token_row.project_id);

  -- ⑧ 核心字段校验
  IF p_visit_date IS NULL THEN
    RAISE EXCEPTION 'missing_visit_date' USING HINT = '随访日期必填';
  END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields'
      USING HINT = '至少填写一项核心指标（血压、血肌酐或尿蛋白/肌酐比）';
  END IF;

  -- ⑨ PII 检测
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    RAISE EXCEPTION 'pii_detected_blocked'
      USING HINT = '备注中疑似包含个人身份信息（手机号/身份证/住院号等），请删除后重新提交';
  END IF;

  -- ⑩ 频率限制：每分钟不超过 12 次
  SELECT COUNT(*) INTO v_recent_count
  FROM visits_long
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at  > now() - interval '1 minute';

  IF v_recent_count >= 12 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    INSERT INTO security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    VALUES (v_token_row.project_id, v_token_row.patient_code,
            encode(sha256(p_token::bytea), 'hex'),
            'rate_limit_exceeded', 'HIGH',
            jsonb_build_object('recent_count', v_recent_count, 'window', '1min'));
    RAISE EXCEPTION 'rate_limit_exceeded' USING HINT = '提交过于频繁，链接已被暂停';
  END IF;

  -- ⑪ 同日重复检测：每日不超过 6 次
  SELECT COUNT(*) INTO v_same_day
  FROM visits_long
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date  = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录
  INSERT INTO visits_long(
    project_id, patient_code, visit_date,
    sbp, dbp, scr_umol_l, upcr, egfr,
    egfr_formula_version,
    notes
  ) VALUES (
    v_token_row.project_id,
    v_token_row.patient_code,
    p_visit_date,
    p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr,
    CASE
      WHEN p_egfr IS NULL THEN NULL
      WHEN p_scr_umol_l IS NULL THEN 'missing_inputs'
      ELSE 'CKD-EPI-2021-Cr'
    END,
    LEFT(COALESCE(p_notes, ''), 500)
  )
  RETURNING id INTO v_visit_id;

  -- ⑬ 若 single_use，标记已使用
  IF v_token_row.single_use THEN
    UPDATE patient_tokens SET used_at = now() WHERE token = p_token;
  END IF;

  -- ⑭ 生成回执 token（24 小时有效）
  -- 使用 gen_random_uuid() 替代 gen_random_bytes(16)，无需 pgcrypto
  v_receipt := replace(gen_random_uuid()::text, '-', '');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT ON CONSTRAINT visit_receipts_pkey DO UPDATE
    SET receipt_token = v_receipt,
        expires_at    = v_expires;

  -- ⑮ 审计日志
  -- 使用 sha256() 替代 digest(x,'sha256')，无需 pgcrypto
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(sha256(p_token::bytea), 'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id',   v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;

-- MIGRATION 031: 0029_meds_route_frequency.sql
-- Add route and frequency columns to meds_long for structured medication dosing
alter table public.meds_long add column if not exists route text;
alter table public.meds_long add column if not exists frequency text;

comment on column public.meds_long.route is 'Administration route: PO, IV, SC, IM, topical, other';
comment on column public.meds_long.frequency is 'Dosing frequency: qd, bid, tid, qod, qw, biw, q2w, qm, prn, other';
