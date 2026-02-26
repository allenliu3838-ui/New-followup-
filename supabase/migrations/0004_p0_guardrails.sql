-- P0 Guardrails: strict input validation, PII blocking, server-side audit,
-- update metadata, anti-abuse limits, receipt token, and visit history.

-- 1) Unified updated_at/updated_by metadata (server-side)
create or replace function public._set_updated_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Add columns if missing
alter table public.projects          add column if not exists updated_at timestamptz not null default now();
alter table public.projects          add column if not exists updated_by uuid;
alter table public.patients_baseline add column if not exists updated_at timestamptz not null default now();
alter table public.patients_baseline add column if not exists updated_by uuid;
alter table public.visits_long       add column if not exists updated_at timestamptz not null default now();
alter table public.visits_long       add column if not exists updated_by uuid;
alter table public.labs_long         add column if not exists updated_at timestamptz not null default now();
alter table public.labs_long         add column if not exists updated_by uuid;
alter table public.meds_long         add column if not exists updated_at timestamptz not null default now();
alter table public.meds_long         add column if not exists updated_by uuid;
alter table public.variants_long     add column if not exists updated_at timestamptz not null default now();
alter table public.variants_long     add column if not exists updated_by uuid;
alter table public.patient_tokens    add column if not exists updated_at timestamptz not null default now();
alter table public.patient_tokens    add column if not exists updated_by uuid;

-- Triggers
 drop trigger if exists tr_projects_updated_meta on public.projects;
create trigger tr_projects_updated_meta before update on public.projects
for each row execute function public._set_updated_meta();

drop trigger if exists tr_patients_updated_meta on public.patients_baseline;
create trigger tr_patients_updated_meta before update on public.patients_baseline
for each row execute function public._set_updated_meta();

drop trigger if exists tr_visits_updated_meta on public.visits_long;
create trigger tr_visits_updated_meta before update on public.visits_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_labs_updated_meta on public.labs_long;
create trigger tr_labs_updated_meta before update on public.labs_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_meds_updated_meta on public.meds_long;
create trigger tr_meds_updated_meta before update on public.meds_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_vars_updated_meta on public.variants_long;
create trigger tr_vars_updated_meta before update on public.variants_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_tokens_updated_meta on public.patient_tokens;
create trigger tr_tokens_updated_meta before update on public.patient_tokens
for each row execute function public._set_updated_meta();

-- 2) PII detection + audit log
create table if not exists public.security_audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid,
  patient_code text,
  token_hash text,
  actor_uid uuid,
  event_type text not null,
  severity text not null default 'warn',
  details jsonb not null default '{}'::jsonb
);

create index if not exists security_audit_logs_created_idx on public.security_audit_logs(created_at desc);
create index if not exists security_audit_logs_project_idx on public.security_audit_logs(project_id, created_at desc);

alter table public.security_audit_logs enable row level security;

drop policy if exists sec_audit_select_own on public.security_audit_logs;
create policy sec_audit_select_own
on public.security_audit_logs for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._contains_pii(p_text text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text;
begin
  if p_text is null then
    return false;
  end if;
  v := lower(trim(p_text));
  if v = '' then
    return false;
  end if;

  -- China mobile phone (11 digits, common prefixes)
  if v ~ '(?:^|\D)1[3-9][0-9]{9}(?:\D|$)' then return true; end if;
  -- China ID (18)
  if v ~ '(?:^|\D)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9xX](?:\D|$)' then return true; end if;
  -- MRN / 病案号 / 住院号 keywords + id-like tail
  if v ~ '(mrn|病案号|住院号|门诊号|身份证|phone|手机号|电话)' then return true; end if;
  -- Suspicious long numeric identifier (8+ consecutive digits)
  if v ~ '\d{8,}' then return true; end if;
  -- Chinese personal name-like pattern after explicit label
  if v ~ '(姓名|患者|病人)[:： ]?[\x{4e00}-\x{9fa5}]{2,4}' then return true; end if;

  return false;
end;
$$;

-- 3) Visit history for admin traceability
create table if not exists public.visits_long_history (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null,
  project_id uuid not null,
  patient_code text not null,
  action text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  old_row jsonb,
  new_row jsonb
);

create index if not exists visits_hist_visit_idx on public.visits_long_history(visit_id, changed_at desc);
create index if not exists visits_hist_project_idx on public.visits_long_history(project_id, changed_at desc);

alter table public.visits_long_history enable row level security;

drop policy if exists visits_hist_select_own on public.visits_long_history;
create policy visits_hist_select_own
on public.visits_long_history for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._audit_visits_long_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    insert into public.visits_long_history(visit_id, project_id, patient_code, action, changed_by, old_row, new_row)
    values (new.id, new.project_id, new.patient_code, 'UPDATE', auth.uid(), to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.visits_long_history(visit_id, project_id, patient_code, action, changed_by, old_row, new_row)
    values (old.id, old.project_id, old.patient_code, 'DELETE', auth.uid(), to_jsonb(old), null);
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists tr_visits_history on public.visits_long;
create trigger tr_visits_history
after update or delete on public.visits_long
for each row execute function public._audit_visits_long_changes();

-- 4) Receipt token (no PII/clinical payload)
create table if not exists public.visit_receipts (
  visit_id uuid primary key references public.visits_long(id) on delete cascade,
  receipt_token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

drop function if exists public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);
create or replace function public.patient_submit_visit_v2(
  p_token text,
  p_visit_date date,
  p_sbp numeric,
  p_dbp numeric,
  p_scr_umol_l numeric,
  p_upcr numeric,
  p_egfr numeric,
  p_notes text default null
)
returns table (
  visit_id uuid,
  server_time timestamptz,
  receipt_token text,
  receipt_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_patient_code text;
  v_visit_id uuid;
  v_now timestamptz := now();
  v_receipt_token text;
  v_receipt_exp timestamptz;
  v_min_count int;
  v_same_day_count int;
begin
  select t.project_id, t.patient_code into v_project_id, v_patient_code
  from public.patient_tokens t
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > v_now)
  limit 1;

  if v_project_id is null then
    raise exception 'token_invalid_or_expired';
  end if;

  -- required core fields
  if p_visit_date is null or p_sbp is null or p_dbp is null or p_scr_umol_l is null or p_upcr is null then
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'visit_submit_blocked_missing_core',
      'warn',
      jsonb_build_object('visit_date', p_visit_date, 'sbp', p_sbp, 'dbp', p_dbp, 'scr_umol_l', p_scr_umol_l, 'upcr', p_upcr)
    );
    raise exception 'missing_core_fields';
  end if;

  -- PII blocking (strict)
  if public._contains_pii(v_patient_code) or public._contains_pii(p_notes) then
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'pii_detected_blocked',
      'high',
      jsonb_build_object('notes_len', coalesce(length(p_notes),0), 'patient_code', v_patient_code)
    );
    raise exception 'pii_detected_blocked';
  end if;

  -- anti-abuse: per-token/minute
  select count(*)::int into v_min_count
  from public.visits_long v
  where v.project_id = v_project_id
    and v.patient_code = v_patient_code
    and v.created_at > (v_now - interval '1 minute');

  if v_min_count >= 12 then
    update public.patient_tokens set active = false where token = p_token;
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'token_auto_frozen_rate_limit',
      'high',
      jsonb_build_object('count_1m', v_min_count)
    );
    raise exception 'rate_limited_token_frozen';
  end if;

  select count(*)::int into v_same_day_count
  from public.visits_long v
  where v.project_id = v_project_id
    and v.patient_code = v_patient_code
    and v.visit_date = p_visit_date;

  if v_same_day_count >= 6 then
    update public.patient_tokens set active = false where token = p_token;
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'token_auto_frozen_same_day_spike',
      'high',
      jsonb_build_object('visit_date', p_visit_date, 'same_day_count', v_same_day_count)
    );
    raise exception 'abnormal_duplicate_spike_token_frozen';
  end if;

  perform public.assert_project_write_allowed(v_project_id);

  insert into public.visits_long(project_id, patient_code, visit_date, sbp, dbp, scr_umol_l, upcr, egfr, notes)
  values (v_project_id, v_patient_code, p_visit_date, p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr, left(p_notes, 500))
  returning id into v_visit_id;

  v_receipt_token := replace(gen_random_uuid()::text, '-', '');
  v_receipt_exp := v_now + interval '24 hours';

  insert into public.visit_receipts(visit_id, receipt_token, expires_at)
  values (v_visit_id, v_receipt_token, v_receipt_exp)
  on conflict (visit_id) do update
    set receipt_token = excluded.receipt_token,
        expires_at = excluded.expires_at;

  insert into public.security_audit_logs(project_id, patient_code, token_hash, actor_uid, event_type, severity, details)
  values (
    v_project_id,
    v_patient_code,
    encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
    auth.uid(),
    'visit_submit_ok',
    'info',
    jsonb_build_object('visit_id', v_visit_id, 'visit_date', p_visit_date)
  );

  visit_id := v_visit_id;
  server_time := v_now;
  receipt_token := v_receipt_token;
  receipt_expires_at := v_receipt_exp;
  return next;
end;
$$;

grant execute on function public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- Admin read history helper
drop function if exists public.admin_get_visit_history(uuid, text, int);
create or replace function public.admin_get_visit_history(
  p_project_id uuid,
  p_patient_code text default null,
  p_limit int default 200
)
returns table (
  changed_at timestamptz,
  action text,
  visit_id uuid,
  patient_code text,
  changed_by uuid,
  old_row jsonb,
  new_row jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    h.changed_at,
    h.action,
    h.visit_id,
    h.patient_code,
    h.changed_by,
    h.old_row,
    h.new_row
  from public.visits_long_history h
  where h.project_id = p_project_id
    and (p_patient_code is null or h.patient_code = p_patient_code)
    and exists (
      select 1 from public.projects p
      where p.id = p_project_id and p.created_by = auth.uid()
    )
  order by h.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.admin_get_visit_history(uuid, text, int) to authenticated;

-- 5) Admin one-click token revoke
create or replace function public.revoke_patient_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_patient_code text;
begin
  select project_id, patient_code into v_project_id, v_patient_code
  from public.patient_tokens
  where token = p_token
  limit 1;

  if v_project_id is null then
    raise exception 'token_not_found';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.id = v_project_id and p.created_by = auth.uid()
  ) then
    raise exception 'admin_only';
  end if;

  update public.patient_tokens
  set active = false,
      expires_at = least(coalesce(expires_at, now()), now())
  where token = p_token;

  insert into public.security_audit_logs(project_id, patient_code, actor_uid, event_type, severity, details)
  values (
    v_project_id,
    v_patient_code,
    auth.uid(),
    'token_revoked_by_admin',
    'warn',
    jsonb_build_object('token_hash', encode(digest(coalesce(p_token,''), 'sha256'), 'hex'))
  );
end;
$$;

grant execute on function public.revoke_patient_token(text) to authenticated;
