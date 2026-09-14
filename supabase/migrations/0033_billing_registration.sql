-- Billing boundaries and registration. Run transactionally after 0032.
-- Preserve existing authorizations as explicit legacy sources for human review.
BEGIN;
create table if not exists public.account_entitlements (
  source_type text not null check(source_type in ('order','contract','manual','legacy')),
  source_id text not null,
  user_id uuid not null references auth.users(id),
  plan text not null check(plan in ('pro','institution','partner')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  project_quota int not null check(project_quota between 1 and 10000),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(source_type,source_id),
  check(ends_at is null or ends_at > starts_at)
);
alter table public.account_entitlements enable row level security;
revoke all on public.account_entitlements from public,anon,authenticated;
create index if not exists account_entitlements_user_idx on public.account_entitlements(user_id);

alter table public.user_profiles add column if not exists account_trial_started_at timestamptz;
alter table public.user_profiles add column if not exists account_trial_expires_at timestamptz;
insert into public.user_profiles(user_id) select id from auth.users on conflict do nothing;
update public.user_profiles pr set
 account_trial_started_at=coalesce(pr.account_trial_started_at,(select min(trial_started_at) from public.projects where created_by=pr.user_id),(select created_at from auth.users where id=pr.user_id),now()),
 account_trial_expires_at=coalesce(pr.account_trial_expires_at,(select min(trial_expires_at) from public.projects where created_by=pr.user_id),(select created_at+interval '30 days' from auth.users where id=pr.user_id),now()+interval '30 days');

insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'order',id::text,user_id,case plan_code when 'institutional' then 'institution' else plan_code end,
 coalesce(activated_at,created_at),end_at,greatest(1,least(project_quota,10000))
from public.billing_orders where status='activated' and end_at>coalesce(activated_at,created_at)
on conflict do nothing;
insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'contract',c.id::text,c.user_id,coalesce(c.plan,c.apply_plan),coalesce(c.activated_at,c.created_at),c.expires_at,greatest(3,least(coalesce(p.project_quota,3),10000))
from public.partner_contracts c left join public.user_profiles p on p.user_id=c.user_id
where c.status='approved' and c.payment_status='paid' and (c.expires_at is null or c.expires_at>coalesce(c.activated_at,c.created_at)) on conflict do nothing;
-- Explicit legacy sources: no automatic revocation of potentially valid old purchases.
insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'legacy',p.id::text,p.created_by,case when not p.trial_enabled then 'partner' else p.subscription_plan end,
 least(p.created_at,now()-interval '1 second'),case when not p.trial_enabled then null else p.subscription_active_until end,
 greatest(3,least(coalesce(pr.project_quota,3),10000))
from public.projects p left join public.user_profiles pr on pr.user_id=p.created_by
where p.created_by is not null and (not p.trial_enabled or (p.subscription_plan in ('pro','institution','partner') and (p.subscription_active_until is null or p.subscription_active_until>now())))
and not exists(select 1 from public.account_entitlements e where e.user_id=p.created_by and e.plan=p.subscription_plan and e.ends_at is not distinct from p.subscription_active_until)
on conflict do nothing;

create or replace function public._account_access(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_plan text; v_end timestamptz; v_quota int; v_trial timestamptz; v_admin boolean;
begin
 select exists(select 1 from platform_admins a join auth.users u on u.email=a.email where u.id=p_user_id) into v_admin;
 select account_trial_expires_at into v_trial from user_profiles where user_id=p_user_id;
 if v_admin then return jsonb_build_object('plan','partner','ends_at',null,'quota',10000,'can_write',true,'trial_expires_at',v_trial); end if;
 select e.plan into v_plan from account_entitlements e where e.user_id=p_user_id and e.revoked_at is null and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now())
 order by case e.plan when 'institution' then 0 when 'partner' then 1 else 2 end limit 1;
 select case when bool_or(ends_at is null) then null else max(ends_at) end,max(project_quota) into v_end,v_quota
 from account_entitlements where user_id=p_user_id and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now());
 return jsonb_build_object('plan',coalesce(v_plan,'trial'),'ends_at',v_end,'quota',coalesce(v_quota,1),'can_write',v_plan is not null or coalesce(v_trial>now(),false),'trial_expires_at',v_trial);
end $$;
revoke all on function public._account_access(uuid) from public,anon,authenticated;

create or replace function public._sync_account_projects(p_user_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb;
begin
 v:=public._account_access(p_user_id);
 update projects set subscription_plan=v->>'plan',subscription_active_until=(v->>'ends_at')::timestamptz,
 trial_enabled=true,trial_expires_at=(v->>'trial_expires_at')::timestamptz,trial_grace_until=(v->>'trial_expires_at')::timestamptz+interval '7 days' where created_by=p_user_id;
 update user_profiles set project_quota=(v->>'quota')::int,updated_at=now() where user_id=p_user_id;
end $$;
revoke all on function public._sync_account_projects(uuid) from public,anon,authenticated;

create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid; v jsonb;
begin
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found'; end if;
 v:=public._account_access(v_uid);
 if not coalesce((v->>'can_write')::boolean,false) then raise exception 'subscription_required'; end if;
end $$;
revoke all on function public.assert_project_write_allowed(uuid) from public,anon,authenticated;

-- Broad row ownership is not column authorization. Preserve safe project editing.
revoke insert,update,truncate on public.projects from public,anon,authenticated;
grant insert(name,center_code,module,registry_type,description) on public.projects to authenticated;
grant update(name,description) on public.projects to authenticated;
revoke insert,update,truncate on public.user_profiles from public,anon,authenticated;
grant update(real_name,hospital,department,interested_plan,contact,notes) on public.user_profiles to authenticated;
revoke insert,update,delete,truncate on public.billing_orders,public.billing_payment_proofs,public.billing_audit_logs from public,anon,authenticated;
drop policy if exists user_own_orders_insert on public.billing_orders;
drop policy if exists user_own_proofs_insert on public.billing_payment_proofs;

create or replace function public._create_project_account_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid; v jsonb; v_used int; v_started timestamptz;
begin
 v_uid:=auth.uid();
 if v_uid is null then
   -- Trusted SQL/service maintenance must explicitly supply a real owner.
   if current_setting('role',true) not in ('postgres','service_role','supabase_admin','none') or new.created_by is null then raise exception 'authentication_required'; end if;
   v_uid:=new.created_by;
 elsif new.created_by is not null and new.created_by<>v_uid then raise exception 'owner_mismatch'; end if;
 perform 1 from auth.users where id=v_uid for update;
 if not found then raise exception 'owner_not_found'; end if;
 insert into user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
 select id,created_at,created_at+interval '30 days' from auth.users where id=v_uid on conflict do nothing;
 update user_profiles set account_trial_started_at=coalesce(account_trial_started_at,now()),account_trial_expires_at=coalesce(account_trial_expires_at,now()+interval '30 days') where user_id=v_uid;
 v:=public._account_access(v_uid);
 select count(*) into v_used from projects where created_by=v_uid;
 if v_used >= (v->>'quota')::int then raise exception 'project_quota_exceeded'; end if;
 if not (v->>'can_write')::boolean then raise exception 'subscription_required'; end if;
 if nullif(trim(new.name),'') is null or nullif(trim(new.center_code),'') is null then raise exception 'project_name_and_center_required'; end if;
 if new.module not in ('IGAN','LN','MN','DKD','CKD','KTX','GENERAL') then raise exception 'invalid_module'; end if;
 new.created_by:=v_uid; new.subscription_plan:=v->>'plan'; new.subscription_active_until:=(v->>'ends_at')::timestamptz;
 select account_trial_started_at into v_started from user_profiles where user_id=v_uid;
 new.trial_enabled:=true;new.trial_started_at:=v_started;new.trial_expires_at:=(v->>'trial_expires_at')::timestamptz;new.trial_grace_until:=new.trial_expires_at+interval '7 days';
 return new;
end $$;
revoke all on function public._create_project_account_guard() from public,anon,authenticated;
drop trigger if exists tr_account_project_guard on public.projects;
create trigger tr_account_project_guard before insert on public.projects for each row execute function public._create_project_account_guard();

create or replace function public.create_project(p_name text,p_center_code text,p_module text default 'GENERAL',p_description text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 insert into projects(name,center_code,module,registry_type,description) values(trim(p_name),trim(p_center_code),upper(p_module),lower(p_module),p_description) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.create_project(text,text,text,text) from public,anon;
grant execute on function public.create_project(text,text,text,text) to authenticated;

create or replace function public.check_project_quota()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; v_used int;
begin
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 v:=public._account_access(auth.uid()); select count(*) into v_used from projects where created_by=auth.uid();
 return v || jsonb_build_object('used',v_used,'remaining',greatest((v->>'quota')::int-v_used,0));
end $$;
revoke all on function public.check_project_quota() from public,anon;
grant execute on function public.check_project_quota() to authenticated;

-- Only administrators issue manual authorizations. Remove owner exception.
create or replace function public.admin_set_subscription(p_project_id uuid,p_plan text,p_active_until timestamptz default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only'; end if;
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found'; end if;
 perform 1 from auth.users where id=v_uid for update;
 if p_plan is null or p_plan not in ('trial','pro','institution','partner') then raise exception 'invalid_plan'; end if;
 if p_active_until is not null and p_active_until<=now() then raise exception 'future_expiry_required'; end if;
 update account_entitlements set revoked_at=now() where user_id=v_uid and source_type in ('manual','legacy');
 if p_plan<>'trial' then
 insert into account_entitlements(source_type,source_id,user_id,plan,ends_at,project_quota)
 values('manual',v_uid::text,v_uid,p_plan,p_active_until,3)
 on conflict(source_type,source_id) do update set plan=excluded.plan,starts_at=now(),ends_at=excluded.ends_at,revoked_at=null,updated_at=now();
 end if;
 perform public._sync_account_projects(v_uid);
end $$;
revoke all on function public.admin_set_subscription(uuid,text,timestamptz) from public,anon;
grant execute on function public.admin_set_subscription(uuid,text,timestamptz) to authenticated;

create or replace function public.admin_set_partner(p_project_id uuid,p_active_until timestamptz default '2099-12-31 23:59:59+00')
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.admin_set_subscription(p_project_id,'partner',p_active_until); end $$;
create or replace function public.admin_reset_to_trial(p_project_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.admin_set_subscription(p_project_id,'trial',null); end $$;
create or replace function public.admin_set_expiry(p_project_id uuid,p_expires_at timestamptz,p_plan text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;v_plan text;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select created_by,subscription_plan into v_uid,v_plan from projects where id=p_project_id;
 if not found then raise exception 'project_not_found';end if;
 if p_expires_at is null or p_expires_at<=now() then raise exception 'future_expiry_required';end if;
 if coalesce(p_plan,v_plan)='trial' then
 update user_profiles set account_trial_expires_at=p_expires_at where user_id=v_uid;
 perform public._sync_account_projects(v_uid);
 else perform public.admin_set_subscription(p_project_id,coalesce(p_plan,v_plan),p_expires_at);end if;
end $$;
create or replace function public.admin_adjust_trial(p_project_id uuid,p_extra_days int default 30)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;v jsonb;v_until timestamptz;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 if p_extra_days is null or p_extra_days not between 1 and 365 then raise exception 'invalid_extension_days';end if;
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found';end if;
 perform 1 from auth.users where id=v_uid for update;v:=public._account_access(v_uid);
 if v->>'plan'='trial' then
 update user_profiles set account_trial_expires_at=greatest(account_trial_expires_at,now())+make_interval(days=>p_extra_days) where user_id=v_uid;
 perform public._sync_account_projects(v_uid);
 else
 if v->>'ends_at' is null then return;end if;
 v_until:=(v->>'ends_at')::timestamptz+make_interval(days=>p_extra_days);
 perform public.admin_set_subscription(p_project_id,v->>'plan',v_until);
 end if;
end $$;

-- Reject unsupported institutional self-service; keep old signature as a guarded wrapper.
create or replace function public.create_billing_order(
 p_plan_code text,p_billing_cycle text,p_extra_projects int default 0,p_payment_method text default null,
 p_payer_name text default null,p_payer_email text default null,p_payer_hospital text default null,p_payer_phone text default null,
 p_invoice_needed boolean default false,p_invoice_type text default 'company',p_invoice_title text default null,p_invoice_tax_no text default null,p_invoice_email text default null,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;v_no text;v_amount numeric;v_extra int;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_plan_code is distinct from 'pro' then raise exception 'institution_requires_quote';end if;
 if p_billing_cycle is null or p_billing_cycle not in ('monthly','yearly') then raise exception 'invalid_billing_cycle';end if;
 if p_extra_projects is null or p_extra_projects not between 0 and 27 then raise exception 'invalid_project_count';end if;
 if p_payment_method is not null and p_payment_method not in ('wechat_qr','alipay_qr','bank_transfer') then raise exception 'invalid_payment_method';end if;
 if p_invoice_type is null or p_invoice_type not in ('company','personal') then raise exception 'invalid_invoice_type';end if;
 if p_invoice_needed and (nullif(trim(p_invoice_title),'') is null or nullif(trim(p_invoice_email),'') is null or (p_invoice_type='company' and nullif(trim(p_invoice_tax_no),'') is null)) then raise exception 'invoice_fields_required';end if;
 perform 1 from auth.users where id=auth.uid() for update;
 if (select count(*) from billing_orders where user_id=auth.uid() and created_at>now()-interval '15 minutes')>=5 then raise exception 'order_rate_limited';end if;
 v_extra:=p_extra_projects;v_amount:=case when p_billing_cycle='monthly' then 499+99*v_extra else 4790+950*v_extra end;v_no:=generate_order_no();
 insert into billing_orders(order_no,user_id,plan_code,billing_cycle,project_quota,extra_projects,amount_due,payment_method,payer_name,payer_email,payer_hospital,payer_phone,invoice_needed,invoice_type,invoice_title,invoice_tax_no,invoice_email,invoice_status,notes)
 values(v_no,auth.uid(),'pro',p_billing_cycle,3+v_extra,v_extra,v_amount,p_payment_method,p_payer_name,p_payer_email,p_payer_hospital,p_payer_phone,coalesce(p_invoice_needed,false),p_invoice_type,p_invoice_title,p_invoice_tax_no,p_invoice_email,case when p_invoice_needed then 'requested' else 'none' end,p_notes) returning id into v_id;
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(v_id,'created',auth.uid(),jsonb_build_object('amount_due',v_amount,'project_quota',3+v_extra));
 return jsonb_build_object('order_id',v_id,'order_no',v_no,'amount_due',v_amount,'project_quota',3+v_extra);
end $$;
drop function if exists public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text);
revoke all on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text,text) from public,anon;
grant execute on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text,text) to authenticated;

-- Persist keys, never client-provided URLs. Both order ownership and object existence are required.
create or replace function public.submit_payment_proof(p_order_id uuid,p_file_url text,p_file_name text default null,p_file_type text default null,p_amount_paid numeric default null,p_payment_method text default null,p_payer_name text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order billing_orders%rowtype;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 select * into v_order from billing_orders where id=p_order_id and user_id=auth.uid() for update;
 if not found or v_order.status not in ('unpaid','rejected') then raise exception 'order_not_found_or_not_payable';end if;
 if p_amount_paid is null or p_amount_paid<=0 then raise exception 'positive_paid_amount_required';end if;
 if p_file_url is null or p_file_url !~ ('^'||auth.uid()::text||'/'||p_order_id::text||'/[a-zA-Z0-9._-]+$') then raise exception 'invalid_proof_key';end if;
 if not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=p_file_url) then raise exception 'proof_object_not_found';end if;
 if exists(select 1 from billing_payment_proofs where order_id=p_order_id and file_url=p_file_url) then raise exception 'proof_already_submitted';end if;
 insert into billing_payment_proofs(order_id,file_url,file_name,file_type,uploaded_by) values(p_order_id,p_file_url,left(p_file_name,200),p_file_type,auth.uid());
 update billing_orders set status='pending_verification',submitted_at=now(),amount_paid=p_amount_paid,payment_method=coalesce(p_payment_method,payment_method),payer_name=coalesce(p_payer_name,payer_name),updated_at=now() where id=p_order_id;
 insert into billing_audit_logs(order_id,action,operator_user_id) values(p_order_id,'proof_uploaded',auth.uid());
end $$;
revoke all on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) from public,anon;
grant execute on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) to authenticated;

update storage.buckets set public=false,file_size_limit=10485760,allowed_mime_types=array['image/png','image/jpeg','image/webp','application/pdf'] where id='payment-proofs';
drop policy if exists payment_proofs_insert_own on storage.objects;
create policy payment_proofs_insert_own on storage.objects for insert to authenticated with check(
 bucket_id='payment-proofs' and (storage.foldername(name))[1]=auth.uid()::text and exists(select 1 from billing_orders o where o.id::text=(storage.foldername(name))[2] and o.user_id=auth.uid() and o.status in ('unpaid','rejected')));
drop policy if exists payment_proofs_select_own on storage.objects;
create policy payment_proofs_select_own on storage.objects for select to authenticated using(
 bucket_id='payment-proofs' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_platform_admin()));
drop policy if exists payment_proofs_delete_own on storage.objects;
create policy payment_proofs_delete_own on storage.objects for delete to authenticated using(
 bucket_id='payment-proofs' and (storage.foldername(name))[1]=auth.uid()::text and not exists(select 1 from billing_payment_proofs p where p.file_url=name));

create or replace function public.admin_verify_order(p_order_id uuid,p_start_at timestamptz default null,p_end_at timestamptz default null,p_admin_notes text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o billing_orders%rowtype;v_uid uuid;v_start timestamptz;v_end timestamptz;v_existing timestamptz;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select user_id into v_uid from billing_orders where id=p_order_id;if not found then raise exception 'order_not_found';end if;
 perform 1 from auth.users where id=v_uid for update;
 select * into o from billing_orders where id=p_order_id for update;
 if o.status='activated' then return;end if;
 if o.status<>'pending_verification' then raise exception 'order_not_pending';end if;
 if not exists(select 1 from billing_payment_proofs where order_id=o.id) then raise exception 'payment_proof_required';end if;
 if o.amount_paid is null or o.amount_paid<o.amount_due then raise exception 'payment_amount_insufficient';end if;
 select max(ends_at) into v_existing from account_entitlements where user_id=o.user_id and revoked_at is null and ends_at>now();
 v_start:=coalesce(p_start_at,greatest(v_existing,now()));
 v_end:=coalesce(p_end_at,v_start+case when o.billing_cycle='monthly' then interval '1 month' else interval '1 year' end);
 if v_end<=v_start or v_end<=now() or (v_existing is not null and v_end<v_existing) then raise exception 'invalid_or_shortening_expiry';end if;
 update billing_orders set status='activated',paid_at=now(),activated_at=now(),start_at=v_start,end_at=v_end,admin_notes=p_admin_notes,updated_at=now() where id=o.id;
 insert into account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
 values('order',o.id::text,o.user_id,case o.plan_code when 'institutional' then 'institution' else o.plan_code end,case when p_start_at is null then now() else p_start_at end,v_end,o.project_quota);
 perform public._sync_account_projects(o.user_id);
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(o.id,'activated',auth.uid(),jsonb_build_object('start_at',v_start,'end_at',v_end,'project_quota',o.project_quota));
end $$;
revoke all on function public.admin_verify_order(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.admin_verify_order(uuid,timestamptz,timestamptz,text) to authenticated;

create or replace function public.admin_set_invoice_status(p_order_id uuid,p_status text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 if p_status is null or p_status not in ('requested','issued') then raise exception 'invalid_invoice_status';end if;
 update billing_orders set invoice_status=p_status,updated_at=now() where id=p_order_id and invoice_needed and status='activated';
 if not found then raise exception 'activated_invoice_order_required';end if;
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(p_order_id,'invoice_status',auth.uid(),jsonb_build_object('status',p_status));
end $$;
revoke all on function public.admin_set_invoice_status(uuid,text) from public,anon;
grant execute on function public.admin_set_invoice_status(uuid,text) to authenticated;

-- Contract state changes affect this source only, preserving independent purchases.
create or replace function public._contract_entitlement_sync()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from auth.users where id=new.user_id for update;
 if new.status='approved' and new.payment_status='paid' then
 if new.expires_at is null or new.expires_at<=now() then raise exception 'future_contract_expiry_required';end if;
 insert into account_entitlements(source_type,source_id,user_id,plan,ends_at,project_quota)
 values('contract',new.id::text,new.user_id,coalesce(new.plan,new.apply_plan),new.expires_at,3)
 on conflict(source_type,source_id) do update set plan=excluded.plan,ends_at=excluded.ends_at,revoked_at=null,updated_at=now();
 else update account_entitlements set revoked_at=now(),updated_at=now() where source_type='contract' and source_id=new.id::text;end if;
 perform public._sync_account_projects(new.user_id);return new;
end $$;
revoke all on function public._contract_entitlement_sync() from public,anon,authenticated;
drop trigger if exists tr_contract_entitlement on public.partner_contracts;
create trigger tr_contract_entitlement after insert or update on public.partner_contracts for each row execute function public._contract_entitlement_sync();
create or replace function public.admin_cancel_contract(p_contract_id uuid,p_admin_note text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 update partner_contracts set status='cancelled',admin_note=coalesce(p_admin_note,admin_note),updated_at=now() where id=p_contract_id and status in ('pending','approved');
 if not found then raise exception 'contract_not_editable';end if;
end $$;
create or replace function public.admin_update_contract(p_contract_id uuid,p_payment_status text default null,p_expires_at timestamptz default null,p_plan text default null,p_annual_price numeric default null,p_discount_pct int default null,p_admin_note text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 update partner_contracts set payment_status=coalesce(p_payment_status,payment_status),expires_at=coalesce(p_expires_at,expires_at),plan=coalesce(p_plan,plan),annual_price_cny=coalesce(p_annual_price,annual_price_cny),discount_pct=coalesce(p_discount_pct,discount_pct),admin_note=coalesce(p_admin_note,admin_note),updated_at=now()
 where id=p_contract_id and status in ('pending','approved');
 if not found then raise exception 'contract_not_editable';end if;
end $$;
create or replace function public.admin_activate_contract(p_contract_id uuid,p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c partner_contracts%rowtype;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select * into c from partner_contracts where id=p_contract_id for update;
 if not found or c.status<>'approved' then raise exception 'contract_not_approved';end if;
 if c.payment_status='paid' and c.activated_at is not null then return;end if;
 update partner_contracts set payment_status='paid',paid_at=now(),activated_at=now(),expires_at=coalesce(p_expires_at,now()+interval '1 year'),updated_at=now() where id=c.id;
end $$;

-- Registered consent is attributable and version allowlisted. Not a signature/ethics approval.
alter table public.consent_logs alter column policy_version set default 'v2.0';
create or replace function public.log_consent(p_action text,p_policy_type text default 'both',p_policy_version text default 'v2.0',p_ip_address text default null,p_user_agent text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_action not in ('register','checkout','profile_submit','contract_apply') or p_policy_type not in ('terms','privacy','both') or p_policy_version<>'v2.0' then raise exception 'invalid_consent_version_or_action';end if;
 insert into consent_logs(user_id,action,policy_type,policy_version,ip_address,user_agent) values(auth.uid(),p_action,p_policy_type,p_policy_version,null,left(p_user_agent,1000));
end $$;
revoke insert on public.consent_logs from public,anon,authenticated;
revoke all on function public.log_consent(text,text,text,text,text) from public,anon;
grant execute on function public.log_consent(text,text,text,text,text) to authenticated;
revoke all on function public.expire_old_orders() from public,anon,authenticated;
grant execute on function public.expire_old_orders() to service_role;

-- New/overridden callable routines require an explicit authenticated grant plus internal checks.
revoke all on function public.admin_set_partner(uuid,timestamptz),public.admin_reset_to_trial(uuid),public.admin_set_expiry(uuid,timestamptz,text),public.admin_adjust_trial(uuid,int),public.admin_cancel_contract(uuid,text),public.admin_update_contract(uuid,text,timestamptz,text,numeric,int,text),public.admin_activate_contract(uuid,timestamptz) from public,anon;
grant execute on function public.admin_set_partner(uuid,timestamptz),public.admin_reset_to_trial(uuid),public.admin_set_expiry(uuid,timestamptz,text),public.admin_adjust_trial(uuid,int),public.admin_cancel_contract(uuid,text),public.admin_update_contract(uuid,text,timestamptz,text,numeric,int,text),public.admin_activate_contract(uuid,timestamptz) to authenticated;

create table if not exists public.account_entitlement_audit (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,
 source_type text not null,source_id text not null,operation text not null,
 changed_by uuid,changed_at timestamptz not null default now(),old_row jsonb,new_row jsonb
);
alter table public.account_entitlement_audit enable row level security;
revoke all on public.account_entitlement_audit from public,anon,authenticated;
create or replace function public._audit_account_entitlements() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into account_entitlement_audit(user_id,source_type,source_id,operation,changed_by,old_row,new_row)
 values(new.user_id,new.source_type,new.source_id,tg_op,auth.uid(),case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));return new;
end $$;
revoke all on function public._audit_account_entitlements() from public,anon,authenticated;
create trigger tr_account_entitlement_audit after insert or update on public.account_entitlements for each row execute function public._audit_account_entitlements();
insert into public.registry_schema_versions(version) values('0033_billing_registration') on conflict do nothing;
COMMIT;
