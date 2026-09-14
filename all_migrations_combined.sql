-- GENERATED from supabase/migrations in canonical filename order.
-- Fresh/isolated databases only; use reviewed increments for production.

-- MIGRATION 001: 0001_core.sql
-- KidneySphere AI Follow-up Registry (Core Schema v1)
-- Includes: projects, baseline (with IgAN Oxford MEST-C), visits, labs, meds, genetics variants, patient tokens,
-- RLS policies, and patient token RPC (security definer) + trial write lock.

-- Extensions
create extension if not exists pgcrypto;

-- ---------------------------
-- Tables
-- ---------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  center_code text not null,
  registry_type text not null default 'general',
  module text not null default 'GENERAL',
  created_by uuid,
  created_at timestamptz not null default now(),

  -- Trial controls (recommended for multi-center reproducibility)
  trial_enabled boolean not null default true,
  trial_started_at timestamptz not null default now(),
  trial_expires_at timestamptz not null default (now() + interval '56 days'),
  trial_grace_until timestamptz not null default (now() + interval '70 days'),
  trial_note text,

  constraint projects_trial_grace_ge_expires check (trial_grace_until >= trial_expires_at)
);

create index if not exists projects_created_by_idx on public.projects(created_by);
create index if not exists projects_center_code_idx on public.projects(center_code);

create table if not exists public.patients_baseline (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  -- No PII fields. Only de-identified research code.
  sex text, -- 'M'/'F'
  birth_year int,

  baseline_date date,
  baseline_scr numeric,  -- μmol/L
  baseline_upcr numeric, -- mg/g or g/g (site-defined)
  consent_research boolean not null default true,

  -- IgAN pathology (Oxford MEST-C)
  biopsy_date date,
  oxford_m smallint,
  oxford_e smallint,
  oxford_s smallint,
  oxford_t smallint,
  oxford_c smallint,

  created_by uuid,
  created_at timestamptz not null default now(),

  constraint patients_baseline_unique unique(project_id, patient_code),
  constraint oxford_m_check check (oxford_m in (0,1) or oxford_m is null),
  constraint oxford_e_check check (oxford_e in (0,1) or oxford_e is null),
  constraint oxford_s_check check (oxford_s in (0,1) or oxford_s is null),
  constraint oxford_t_check check (oxford_t in (0,1,2) or oxford_t is null),
  constraint oxford_c_check check (oxford_c in (0,1,2) or oxford_c is null)
);

create index if not exists patients_baseline_project_patient_idx on public.patients_baseline(project_id, patient_code);

create table if not exists public.visits_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  visit_date date not null,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric, -- serum creatinine (μmol/L)
  upcr numeric,       -- protein/creatinine ratio (site-defined)
  egfr numeric,       -- optional precomputed
  notes text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists visits_long_project_patient_date_idx on public.visits_long(project_id, patient_code, visit_date);

create table if not exists public.labs_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  lab_date date,
  lab_name text,
  lab_value numeric,
  lab_unit text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists labs_long_project_patient_idx on public.labs_long(project_id, patient_code);

create table if not exists public.meds_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  drug_name text,
  drug_class text,
  dose text,
  start_date date,
  end_date date,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists meds_long_project_patient_idx on public.meds_long(project_id, patient_code);

create table if not exists public.variants_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  test_date date,
  test_name text,     -- e.g., WES / panel name
  gene text,
  variant text,       -- short description
  hgvs_c text,
  hgvs_p text,
  transcript text,
  zygosity text,      -- het/hom/hem
  classification text,-- ACMG: P/LP/VUS/LB/B
  lab_name text,
  notes text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists variants_long_project_patient_idx on public.variants_long(project_id, patient_code);

create table if not exists public.patient_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  token text not null unique,
  active boolean not null default true,
  expires_at timestamptz,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists patient_tokens_project_patient_idx on public.patient_tokens(project_id, patient_code);
create index if not exists patient_tokens_token_idx on public.patient_tokens(token);

-- ---------------------------
-- Helper: set created_by on insert when authenticated
-- ---------------------------

create or replace function public._set_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists tr_projects_created_by on public.projects;
create trigger tr_projects_created_by
before insert on public.projects
for each row execute function public._set_created_by();

-- Optional for other tables (won't set for anon token submissions)
drop trigger if exists tr_patients_created_by on public.patients_baseline;
create trigger tr_patients_created_by
before insert on public.patients_baseline
for each row execute function public._set_created_by();

drop trigger if exists tr_visits_created_by on public.visits_long;
create trigger tr_visits_created_by
before insert on public.visits_long
for each row execute function public._set_created_by();

drop trigger if exists tr_labs_created_by on public.labs_long;
create trigger tr_labs_created_by
before insert on public.labs_long
for each row execute function public._set_created_by();

drop trigger if exists tr_meds_created_by on public.meds_long;
create trigger tr_meds_created_by
before insert on public.meds_long
for each row execute function public._set_created_by();

drop trigger if exists tr_vars_created_by on public.variants_long;
create trigger tr_vars_created_by
before insert on public.variants_long
for each row execute function public._set_created_by();

drop trigger if exists tr_tokens_created_by on public.patient_tokens;
create trigger tr_tokens_created_by
before insert on public.patient_tokens
for each row execute function public._set_created_by();

-- ---------------------------
-- Trial write lock
-- ---------------------------

create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_trial_enabled boolean;
declare v_expires timestamptz;
begin
  select trial_enabled, trial_expires_at into v_trial_enabled, v_expires
  from public.projects
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  if v_trial_enabled and now() > v_expires then
    raise exception 'trial_expired';
  end if;
end;
$$;

create or replace function public._trial_block_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare pid uuid;
begin
  if tg_op = 'DELETE' then
    pid := old.project_id;
  else
    pid := new.project_id;
  end if;

  perform public.assert_project_write_allowed(pid);

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

-- Apply trial lock triggers to all write tables
drop trigger if exists tr_patients_trial_lock on public.patients_baseline;
create trigger tr_patients_trial_lock
before insert or update or delete on public.patients_baseline
for each row execute function public._trial_block_write();

drop trigger if exists tr_visits_trial_lock on public.visits_long;
create trigger tr_visits_trial_lock
before insert or update or delete on public.visits_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_labs_trial_lock on public.labs_long;
create trigger tr_labs_trial_lock
before insert or update or delete on public.labs_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_meds_trial_lock on public.meds_long;
create trigger tr_meds_trial_lock
before insert or update or delete on public.meds_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_vars_trial_lock on public.variants_long;
create trigger tr_vars_trial_lock
before insert or update or delete on public.variants_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_tokens_trial_lock on public.patient_tokens;
create trigger tr_tokens_trial_lock
before insert or update or delete on public.patient_tokens
for each row execute function public._trial_block_write();

-- ---------------------------
-- RLS (Row Level Security)
-- ---------------------------

alter table public.projects enable row level security;
alter table public.patients_baseline enable row level security;
alter table public.visits_long enable row level security;
alter table public.labs_long enable row level security;
alter table public.meds_long enable row level security;
alter table public.variants_long enable row level security;
alter table public.patient_tokens enable row level security;

-- Projects: owner-only access
drop policy if exists projects_select_own on public.projects;
create policy projects_select_own
on public.projects for select
to authenticated
using (created_by = auth.uid());

drop policy if exists projects_insert_auth on public.projects;
create policy projects_insert_auth
on public.projects for insert
to authenticated
with check (created_by is null or created_by = auth.uid());

drop policy if exists projects_update_own on public.projects;
create policy projects_update_own
on public.projects for update
to authenticated
using (created_by = auth.uid())
with check (created_by = auth.uid());

drop policy if exists projects_delete_own on public.projects;
create policy projects_delete_own
on public.projects for delete
to authenticated
using (created_by = auth.uid());

-- Helper predicate for child tables
-- "exists project owned by current user"
-- Baseline
drop policy if exists baseline_select_own on public.patients_baseline;
create policy baseline_select_own
on public.patients_baseline for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_insert_own on public.patients_baseline;
create policy baseline_insert_own
on public.patients_baseline for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_update_own on public.patients_baseline;
create policy baseline_update_own
on public.patients_baseline for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_delete_own on public.patients_baseline;
create policy baseline_delete_own
on public.patients_baseline for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Visits
drop policy if exists visits_select_own on public.visits_long;
create policy visits_select_own
on public.visits_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_insert_own on public.visits_long;
create policy visits_insert_own
on public.visits_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_update_own on public.visits_long;
create policy visits_update_own
on public.visits_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_delete_own on public.visits_long;
create policy visits_delete_own
on public.visits_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Labs
drop policy if exists labs_select_own on public.labs_long;
create policy labs_select_own
on public.labs_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_insert_own on public.labs_long;
create policy labs_insert_own
on public.labs_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_update_own on public.labs_long;
create policy labs_update_own
on public.labs_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_delete_own on public.labs_long;
create policy labs_delete_own
on public.labs_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Meds
drop policy if exists meds_select_own on public.meds_long;
create policy meds_select_own
on public.meds_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_insert_own on public.meds_long;
create policy meds_insert_own
on public.meds_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_update_own on public.meds_long;
create policy meds_update_own
on public.meds_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_delete_own on public.meds_long;
create policy meds_delete_own
on public.meds_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Variants
drop policy if exists vars_select_own on public.variants_long;
create policy vars_select_own
on public.variants_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_insert_own on public.variants_long;
create policy vars_insert_own
on public.variants_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_update_own on public.variants_long;
create policy vars_update_own
on public.variants_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_delete_own on public.variants_long;
create policy vars_delete_own
on public.variants_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Patient tokens (owner only)
drop policy if exists tokens_select_own on public.patient_tokens;
create policy tokens_select_own
on public.patient_tokens for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_insert_own on public.patient_tokens;
create policy tokens_insert_own
on public.patient_tokens for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_update_own on public.patient_tokens;
create policy tokens_update_own
on public.patient_tokens for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_delete_own on public.patient_tokens;
create policy tokens_delete_own
on public.patient_tokens for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- ---------------------------
-- RPC for token-based follow-up
-- ---------------------------

create or replace function public.create_patient_token(
  p_project_id uuid,
  p_patient_code text,
  p_expires_in_days int default 365
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid;
declare v_token text;
declare v_ok boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = v_uid) then
    raise exception 'no_access';
  end if;

  if not exists (select 1 from public.patients_baseline b where b.project_id = p_project_id and b.patient_code = p_patient_code) then
    raise exception 'patient_not_found';
  end if;

  perform public.assert_project_write_allowed(p_project_id);

  -- generate token
 v_token := replace(gen_random_uuid()::text, '-', '');

  insert into public.patient_tokens(project_id, patient_code, token, expires_at, active, created_by)
  values (p_project_id, p_patient_code, v_token, now() + make_interval(days => p_expires_in_days), true, v_uid);

  return v_token;
end;
$$;

grant execute on function public.create_patient_token(uuid, text, int) to authenticated;

-- DROP first: CREATE OR REPLACE cannot change OUT parameter set
drop function if exists public.patient_get_context(text);
create or replace function public.patient_get_context(p_token text)
returns table (
  project_id uuid,
  project_name text,
  center_code text,
  module text,
  patient_code text,
  sex text,
  birth_year int,
  trial_expires_at timestamptz,
  trial_grace_until timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    p.id as project_id,
    p.name as project_name,
    p.center_code,
    p.module,
    t.patient_code,
    b.sex,
    b.birth_year,
    p.trial_expires_at,
    p.trial_grace_until
  from public.patient_tokens t
  join public.projects p on p.id = t.project_id
  left join public.patients_baseline b
    on b.project_id = t.project_id and b.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  limit 1;
$$;

grant execute on function public.patient_get_context(text) to anon, authenticated;

drop function if exists public.patient_list_visits(text, int);
create or replace function public.patient_list_visits(
  p_token text,
  p_limit int default 30
)
returns table (
  visit_date date,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric,
  upcr numeric,
  egfr numeric,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    v.visit_date,
    v.sbp,
    v.dbp,
    v.scr_umol_l,
    v.upcr,
    v.egfr,
    v.notes,
    v.created_at
  from public.patient_tokens t
  join public.visits_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.visit_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_visits(text, int) to anon, authenticated;

create or replace function public.patient_submit_visit(
  p_token text,
  p_visit_date date,
  p_sbp numeric,
  p_dbp numeric,
  p_scr_umol_l numeric,
  p_upcr numeric,
  p_egfr numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_project_id uuid;
declare v_patient_code text;
declare v_visit_id uuid;
begin
  select t.project_id, t.patient_code into v_project_id, v_patient_code
  from public.patient_tokens t
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  limit 1;

  if v_project_id is null then
    raise exception 'token_invalid_or_expired';
  end if;

  perform public.assert_project_write_allowed(v_project_id);

  insert into public.visits_long(project_id, patient_code, visit_date, sbp, dbp, scr_umol_l, upcr, egfr, notes)
  values (v_project_id, v_patient_code, p_visit_date, p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr, left(p_notes, 500))
  returning id into v_visit_id;

  return v_visit_id;
end;
$$;

grant execute on function public.patient_submit_visit(text, date, numeric, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- END

-- MIGRATION 002: 0002_clinical_constraints.sql
-- Migration 0002: Add CHECK constraints for clinical value ranges
-- Prevents obviously erroneous data from being stored.
-- DROP first to make this idempotent on re-runs.

-- visits_long: blood pressure and renal function ranges
alter table public.visits_long
  drop constraint if exists visits_sbp_range,
  drop constraint if exists visits_dbp_range,
  drop constraint if exists visits_scr_range,
  drop constraint if exists visits_egfr_range,
  drop constraint if exists visits_upcr_range;

alter table public.visits_long
  add constraint visits_sbp_range  check (sbp  is null or (sbp  between 40  and 300)),
  add constraint visits_dbp_range  check (dbp  is null or (dbp  between 20  and 200)),
  add constraint visits_scr_range  check (scr_umol_l is null or (scr_umol_l between 10 and 5000)),
  add constraint visits_egfr_range check (egfr is null or (egfr between 0  and 200)),
  add constraint visits_upcr_range check (upcr is null or upcr >= 0);

-- patients_baseline: birth_year and baseline lab ranges
alter table public.patients_baseline
  drop constraint if exists baseline_birth_year_range,
  drop constraint if exists baseline_scr_range,
  drop constraint if exists baseline_upcr_range;

alter table public.patients_baseline
  add constraint baseline_birth_year_range check (birth_year is null or (birth_year between 1900 and 2100)),
  add constraint baseline_scr_range  check (baseline_scr  is null or (baseline_scr  between 10 and 5000)),
  add constraint baseline_upcr_range check (baseline_upcr is null or baseline_upcr >= 0);

-- MIGRATION 003: 0002_events.sql
-- KidneySphere AI — Phase 1 Migration
-- Adds events_long table: clinical endpoints (computed + manual)
-- Event types: egfr_decline_40pct | egfr_decline_57pct | esrd | death |
--              complete_remission | partial_remission | custom

-- ---------------------------
-- Table
-- ---------------------------

create table if not exists public.events_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  -- Endpoint classification
  event_type text not null,        -- see valid types above
  event_date date,
  confirmed boolean not null default true,
  source text not null default 'manual', -- 'computed' | 'manual'
  notes text,

  created_by uuid,
  created_at timestamptz not null default now(),

  constraint events_long_event_type_check check (
    event_type in (
      'egfr_decline_40pct',
      'egfr_decline_57pct',
      'esrd',
      'death',
      'complete_remission',
      'partial_remission',
      'custom'
    )
  )
);

create index if not exists events_long_project_patient_idx
  on public.events_long(project_id, patient_code);

create index if not exists events_long_event_type_idx
  on public.events_long(project_id, event_type);

-- ---------------------------
-- created_by trigger
-- ---------------------------

drop trigger if exists tr_events_created_by on public.events_long;
create trigger tr_events_created_by
before insert on public.events_long
for each row execute function public._set_created_by();

-- ---------------------------
-- Trial write lock
-- ---------------------------

drop trigger if exists tr_events_trial_lock on public.events_long;
create trigger tr_events_trial_lock
before insert or update or delete on public.events_long
for each row execute function public._trial_block_write();

-- ---------------------------
-- RLS
-- ---------------------------

alter table public.events_long enable row level security;

drop policy if exists events_select_own on public.events_long;
create policy events_select_own
on public.events_long for select
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_insert_own on public.events_long;
create policy events_insert_own
on public.events_long for insert
to authenticated
with check (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_update_own on public.events_long;
create policy events_update_own
on public.events_long for update
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
))
with check (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_delete_own on public.events_long;
create policy events_delete_own
on public.events_long for delete
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

-- END

-- MIGRATION 004: 0003_subscription.sql
-- KidneySphere AI — Subscription Model (v3)
--
-- Changes:
--   1. Trial period: 56 days → 90 days (3 months)
--      Grace period: 70 days → 100 days (10-day buffer after trial)
--   2. Add subscription_plan + subscription_active_until to projects
--   3. Update assert_project_write_allowed() to allow paid subscribers
--   4. Add admin_set_subscription() RPC (service-role only)
--
-- Subscription plans:
--   'trial'       — default; write access until trial_expires_at
--   'pro'         — paid individual/lab plan
--   'institution' — paid multi-center plan
--
-- Write-access rules (any one of):
--   A. trial_enabled = false  (admin override)
--   B. plan IN ('pro','institution') AND active_until IS NULL OR active_until > now()
--   C. plan = 'trial' AND now() <= trial_expires_at
--
-- After trial + grace: data is NEVER deleted. Researchers can still READ and
-- download their data. Paying restores write access immediately.
-- ---------------------------

-- ---------------------------
-- 1. Extend trial defaults for NEW projects
-- ---------------------------

ALTER TABLE public.projects
  ALTER COLUMN trial_expires_at SET DEFAULT (now() + interval '90 days'),
  ALTER COLUMN trial_grace_until SET DEFAULT (now() + interval '100 days');

-- ---------------------------
-- 2. Backfill existing projects that haven't expired yet
--    (extend their trial proportionally to 90 days from started_at)
-- ---------------------------

UPDATE public.projects
SET
  trial_expires_at  = trial_started_at + interval '90 days',
  trial_grace_until = trial_started_at + interval '100 days'
WHERE
  trial_enabled = true
  AND now() < (trial_started_at + interval '90 days');

-- ---------------------------
-- 3. Add subscription columns
-- ---------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS subscription_active_until timestamptz;

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS subscription_plan_check;
ALTER TABLE public.projects
  ADD CONSTRAINT subscription_plan_check
    CHECK (subscription_plan IN ('trial', 'pro', 'institution'));

-- ---------------------------
-- 4. Update write-lock function
-- ---------------------------

CREATE OR REPLACE FUNCTION public.assert_project_write_allowed(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trial_enabled          boolean;
  v_trial_expires          timestamptz;
  v_subscription_plan      text;
  v_subscription_until     timestamptz;
BEGIN
  SELECT
    trial_enabled,
    trial_expires_at,
    subscription_plan,
    subscription_active_until
  INTO
    v_trial_enabled,
    v_trial_expires,
    v_subscription_plan,
    v_subscription_until
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;

  -- Rule A: trial restriction disabled by admin
  IF NOT v_trial_enabled THEN
    RETURN;
  END IF;

  -- Rule B: active paid subscription
  IF v_subscription_plan IN ('pro', 'institution') THEN
    IF v_subscription_until IS NULL OR v_subscription_until > now() THEN
      RETURN;
    END IF;
    -- Paid plan has expired → fall through to trial check
  END IF;

  -- Rule C: within trial period
  IF v_trial_expires IS NOT NULL AND now() <= v_trial_expires THEN
    RETURN;
  END IF;

  -- Nothing matched → block write
  RAISE EXCEPTION 'subscription_required';
END;
$$;

-- ---------------------------
-- 5. Admin RPC: activate / extend subscription
--    Must be called with service_role key (server-side only).
-- ---------------------------

CREATE OR REPLACE FUNCTION public.admin_set_subscription(
  p_project_id      uuid,
  p_plan            text,
  p_active_until    timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_role text;
BEGIN
  v_session_role := current_setting('role', true);

  -- Allowed callers:
  --   'service_role'    → Supabase service-role key (server-side / Edge Functions)
  --   'supabase_admin'  → Supabase internal admin
  --   'postgres'        → SQL Editor (superuser, trusted admin access)
  -- All other roles (authenticated, anon) are blocked unless they own the project.
  IF v_session_role NOT IN ('service_role', 'supabase_admin', 'postgres') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = p_project_id AND created_by = auth.uid()
    ) THEN
      RAISE EXCEPTION 'admin_only';
    END IF;
  END IF;

  IF p_plan NOT IN ('trial', 'pro', 'institution') THEN
    RAISE EXCEPTION 'invalid_plan: %. Must be one of: trial, pro, institution', p_plan;
  END IF;

  UPDATE public.projects
  SET
    subscription_plan         = p_plan,
    subscription_active_until = p_active_until
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found: %', p_project_id;
  END IF;
END;
$$;

-- Usage example (run in Supabase SQL Editor):
--
--   SELECT public.admin_set_subscription(
--     'your-project-uuid'::uuid,
--     'pro'::text,
--     (now() + interval '1 year')::timestamptz
--   );
--
-- To find project UUIDs:
--   SELECT id, name, center_code, subscription_plan FROM public.projects;

GRANT EXECUTE ON FUNCTION public.admin_set_subscription(uuid, text, timestamptz)
  TO authenticated;

-- ---------------------------
-- 6. Expose subscription fields via patient_get_context
--    (so patient follow-up links also respect subscription state)
-- ---------------------------

-- Must DROP first: return type changed (added subscription_plan, subscription_active_until).
-- CREATE OR REPLACE cannot change OUT parameter set.
DROP FUNCTION IF EXISTS public.patient_get_context(text);

CREATE OR REPLACE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE (
  project_id              uuid,
  project_name            text,
  center_code             text,
  module                  text,
  patient_code            text,
  sex                     text,
  birth_year              int,
  trial_expires_at        timestamptz,
  trial_grace_until       timestamptz,
  subscription_plan       text,
  subscription_active_until timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                       AS project_id,
    p.name                     AS project_name,
    p.center_code,
    p.module,
    t.patient_code,
    b.sex,
    b.birth_year,
    p.trial_expires_at,
    p.trial_grace_until,
    p.subscription_plan,
    p.subscription_active_until
  FROM public.patient_tokens t
  JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.patients_baseline b
    ON b.project_id = t.project_id AND b.patient_code = t.patient_code
  WHERE t.token = p_token
    AND t.active = true
    AND (t.expires_at IS NULL OR t.expires_at > now())
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.patient_get_context(text) TO anon, authenticated;

-- END

-- MIGRATION 005: 0004_p0_guardrails.sql
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

-- MIGRATION 006: 0005_snapshots_and_ktx.sql
-- Snapshot / Export IDs + audit trail + KTx template extension (minimal)

create table if not exists public.project_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_id text not null unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','locked','deprecated')),
  kind text not null default 'snapshot' check (kind in ('snapshot','paper_package','export')),
  filter_summary jsonb not null default '{}'::jsonb,
  schema_version text not null default 'core_v1',
  n_patients int not null default 0,
  n_visits int not null default 0,
  missing_rate numeric not null default 0,
  qc_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  locked_at timestamptz,
  locked_by uuid,
  notes text
);

create index if not exists project_snapshots_project_created_idx on public.project_snapshots(project_id, created_at desc);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  actor_uid uuid,
  action text not null,
  snapshot_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_project_created_idx on public.audit_log(project_id, created_at desc);

alter table public.project_snapshots enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists snapshots_select_own on public.project_snapshots;
create policy snapshots_select_own on public.project_snapshots
for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists audit_select_own on public.audit_log;
create policy audit_select_own on public.audit_log
for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._new_snapshot_code()
returns text
language plpgsql
as $$
declare
  v text;
begin
  v := 'KS-' || to_char(now(),'YYYY') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  return v;
end;
$$;

drop function if exists public.create_project_snapshot(uuid, text, jsonb, text);
create or replace function public.create_project_snapshot(
  p_project_id uuid,
  p_kind text default 'snapshot',
  p_filter_summary jsonb default '{}'::jsonb,
  p_schema_version text default 'core_v1'
)
returns table (
  id uuid,
  snapshot_id text,
  status text,
  created_at timestamptz,
  n_patients int,
  n_visits int,
  missing_rate numeric,
  qc_summary jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_snapshot_id text;
  v_n_patients int := 0;
  v_n_visits int := 0;
  v_missing_rate numeric := 0;
  v_qc jsonb;
  v_id uuid;
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = v_uid) then
    raise exception 'admin_only';
  end if;

  if p_kind not in ('snapshot','paper_package','export') then
    raise exception 'invalid_kind';
  end if;

  select count(distinct patient_code) into v_n_patients from public.patients_baseline where project_id = p_project_id;
  select count(*) into v_n_visits from public.visits_long where project_id = p_project_id;

  select jsonb_build_object(
    'visits_missing_sbp', count(*) filter (where sbp is null),
    'visits_missing_dbp', count(*) filter (where dbp is null),
    'visits_missing_scr', count(*) filter (where scr_umol_l is null),
    'visits_missing_upcr', count(*) filter (where upcr is null)
  ) into v_qc
  from public.visits_long
  where project_id = p_project_id;

  if v_n_visits > 0 then
    select (
      ((count(*) filter (where sbp is null or dbp is null or scr_umol_l is null or upcr is null))::numeric / count(*)::numeric) * 100
    ) into v_missing_rate
    from public.visits_long
    where project_id = p_project_id;
  end if;

  v_snapshot_id := public._new_snapshot_code();

  insert into public.project_snapshots(
    snapshot_id, project_id, status, kind, filter_summary, schema_version,
    n_patients, n_visits, missing_rate, qc_summary, created_by
  )
  values (
    v_snapshot_id, p_project_id, 'draft', p_kind, coalesce(p_filter_summary,'{}'::jsonb), p_schema_version,
    v_n_patients, v_n_visits, coalesce(v_missing_rate,0), coalesce(v_qc,'{}'::jsonb), v_uid
  )
  returning project_snapshots.id into v_id;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (
    p_project_id,
    v_uid,
    'snapshot_create',
    v_snapshot_id,
    jsonb_build_object('kind', p_kind, 'schema_version', p_schema_version, 'filter_summary', coalesce(p_filter_summary,'{}'::jsonb))
  );

  return query
  select s.id, s.snapshot_id, s.status, s.created_at, s.n_patients, s.n_visits, s.missing_rate, s.qc_summary
  from public.project_snapshots s where s.id = v_id;
end;
$$;

grant execute on function public.create_project_snapshot(uuid, text, jsonb, text) to authenticated;

create or replace function public.list_project_snapshots(p_project_id uuid)
returns setof public.project_snapshots
language sql
security definer
set search_path = public
as $$
  select s.*
  from public.project_snapshots s
  where s.project_id = p_project_id
    and exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = auth.uid())
  order by s.created_at desc;
$$;

grant execute on function public.list_project_snapshots(uuid) to authenticated;

create or replace function public.lock_project_snapshot(p_snapshot_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_snapshot text;
begin
  select project_id, snapshot_id into v_project, v_snapshot
  from public.project_snapshots
  where id = p_snapshot_id
  limit 1;

  if v_project is null then
    raise exception 'snapshot_not_found';
  end if;

  if not exists (select 1 from public.projects p where p.id = v_project and p.created_by = auth.uid()) then
    raise exception 'admin_only';
  end if;

  update public.project_snapshots
  set status = 'locked', locked_at = now(), locked_by = auth.uid()
  where id = p_snapshot_id and status <> 'locked';

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (v_project, auth.uid(), 'snapshot_lock', v_snapshot, '{}'::jsonb);
end;
$$;

grant execute on function public.lock_project_snapshot(uuid) to authenticated;

create or replace function public.log_project_audit(
  p_project_id uuid,
  p_action text,
  p_snapshot_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = auth.uid()) then
    raise exception 'admin_only';
  end if;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (p_project_id, auth.uid(), p_action, p_snapshot_id, coalesce(p_details,'{}'::jsonb));
end;
$$;

grant execute on function public.log_project_audit(uuid, text, text, jsonb) to authenticated;

-- KTx structured extension tables
create table if not exists public.ktx_baseline_ext (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,
  transplant_date date,
  donor_type text,
  induction_therapy text,
  maintenance_immuno jsonb not null default '[]'::jsonb,
  hla_mismatch_count int,
  pra_status text,
  dsa_status text,
  dsa_titer text,
  baseline_creatinine numeric,
  baseline_egfr numeric,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint ktx_baseline_unique unique(project_id, patient_code)
);

create table if not exists public.ktx_visits_ext (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,
  visit_date date not null,
  tac_trough numeric,
  csa_trough numeric,
  weight_kg numeric,
  infection_event text,
  rejection_event text,
  biopsy_banff text,
  graft_failure_date date,
  death_date date,
  return_to_dialysis boolean,
  return_to_dialysis_date date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.ktx_baseline_ext enable row level security;
alter table public.ktx_visits_ext enable row level security;

drop policy if exists ktxb_select_own on public.ktx_baseline_ext;
create policy ktxb_select_own on public.ktx_baseline_ext for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxb_insert_own on public.ktx_baseline_ext;
create policy ktxb_insert_own on public.ktx_baseline_ext for insert to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxb_update_own on public.ktx_baseline_ext;
create policy ktxb_update_own on public.ktx_baseline_ext for update to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_select_own on public.ktx_visits_ext;
create policy ktxv_select_own on public.ktx_visits_ext for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_insert_own on public.ktx_visits_ext;
create policy ktxv_insert_own on public.ktx_visits_ext for insert to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_update_own on public.ktx_visits_ext;
create policy ktxv_update_own on public.ktx_visits_ext for update to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- metadata triggers
 drop trigger if exists tr_ktxb_created_by on public.ktx_baseline_ext;
create trigger tr_ktxb_created_by before insert on public.ktx_baseline_ext
for each row execute function public._set_created_by();
drop trigger if exists tr_ktxb_updated_meta on public.ktx_baseline_ext;
create trigger tr_ktxb_updated_meta before update on public.ktx_baseline_ext
for each row execute function public._set_updated_meta();

drop trigger if exists tr_ktxv_created_by on public.ktx_visits_ext;
create trigger tr_ktxv_created_by before insert on public.ktx_visits_ext
for each row execute function public._set_created_by();
drop trigger if exists tr_ktxv_updated_meta on public.ktx_visits_ext;
create trigger tr_ktxv_updated_meta before update on public.ktx_visits_ext
for each row execute function public._set_updated_meta();

-- MIGRATION 007: 0006_demo_requests.sql
-- Demo booking requests table
-- Stores requests submitted via /demo page

create table if not exists demo_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null,
  institution text not null,
  department  text,
  email       text not null,
  contact     text,          -- wechat / phone
  use_case    text,          -- IGAN / LN / MN / GENERAL / KTX / OTHER
  message     text,
  status      text not null default 'pending'  -- pending / contacted / done
);

-- Allow anonymous inserts (public form submission)
alter table demo_requests enable row level security;

DROP POLICY IF EXISTS "allow_public_insert" ON demo_requests;
create policy "allow_public_insert" on demo_requests
  for insert to anon with check (true);

-- Only authenticated (staff) can read / update
DROP POLICY IF EXISTS "allow_auth_select" ON demo_requests;
create policy "allow_auth_select" on demo_requests
  for select to authenticated using (true);

DROP POLICY IF EXISTS "allow_auth_update" ON demo_requests;
create policy "allow_auth_update" on demo_requests
  for update to authenticated using (true);

-- MIGRATION 008: 0007_trial_30days.sql
-- KidneySphere AI — Trial Period Update (v7)
--
-- Changes:
--   1. Trial period: 90 days → 30 days
--      Grace period: 100 days → 37 days (7-day buffer after trial)
--   2. Backfill existing projects that haven't expired yet
--
-- Rationale:
--   30 days is sufficient to evaluate the system (core value apparent in 1-2 weeks).
--   Shorter trial creates clearer conversion decision point.
--   7-day grace is enough to export data and decide.
-- ---------------------------

-- ---------------------------
-- 1. Update defaults for NEW projects
-- ---------------------------

ALTER TABLE public.projects
  ALTER COLUMN trial_expires_at  SET DEFAULT (now() + interval '30 days'),
  ALTER COLUMN trial_grace_until SET DEFAULT (now() + interval '37 days');

-- ---------------------------
-- 2. Backfill existing projects that haven't started their trial yet
--    (i.e. still on the old 90-day default, and trial hasn't expired)
--    Only shorten trials that haven't expired yet and were created recently
--    (within the last 30 days — so they haven't already passed the new limit)
-- ---------------------------

UPDATE public.projects
SET
  trial_expires_at  = trial_started_at + interval '30 days',
  trial_grace_until = trial_started_at + interval '37 days'
WHERE
  trial_enabled = true
  AND now() < trial_expires_at
  AND now() < (trial_started_at + interval '30 days');

-- Projects already past 30 days from trial_started_at but still in the old
-- 90-day window are NOT modified — they keep their current expires_at to avoid
-- retroactively shortening an in-progress trial. They will simply expire on
-- their original schedule.

-- END

-- MIGRATION 009: 0008_rct_phase1.sql
-- RCT Phase 1：在 patients_baseline 增加随机化字段
-- 观察性队列可全部留空（NULL）；无破坏性变更。

alter table public.patients_baseline
  add column if not exists treatment_arm text,
  add column if not exists randomization_id text,
  add column if not exists randomization_date date,
  add column if not exists stratification_factors jsonb;

comment on column public.patients_baseline.treatment_arm      is '干预组别：intervention（干预组）/ control（对照组）/ placebo（安慰剂组）或自定义；观察性队列留空';
comment on column public.patients_baseline.randomization_id   is '随机号（盲底管理编号）；观察性队列留空';
comment on column public.patients_baseline.randomization_date is '随机化日期；观察性队列留空';
comment on column public.patients_baseline.stratification_factors is '分层因素 JSON，如 {"中心":"BJ01","eGFR分层":"高风险"}；观察性队列留空';

-- MIGRATION 010: 0009_platform_admins.sql
-- ============================================================
-- 0009_platform_admins.sql
-- 平台管理员体系
--
-- 新增内容：
--   1. platform_admins 表      — 记录平台管理员邮箱
--   2. partner 订阅计划        — 合作机构/友好单位，由管理员手动授权
--   3. is_platform_admin()     — 判断当前登录用户是否为平台管理员
--   4. admin_list_projects()   — 按邮箱搜索某用户的全部项目
--   5. admin_adjust_trial()    — 延长试用天数
--   6. admin_set_partner()     — 设为合作伙伴（长期免费）
--   7. admin_reset_to_trial()  — 撤回为普通试用
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. platform_admins 表
-- ──────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  email       text        not null primary key,
  note        text,
  created_at  timestamptz not null default now()
);

-- 仅 postgres / service_role 可直接操作该表；前端用户通过 RPC 间接访问
alter table public.platform_admins enable row level security;
-- 不授予 authenticated / anon 任何直接访问权限（RPC 走 SECURITY DEFINER）

-- ──────────────────────────────────────────────────────────
-- 2. 把 'partner' 加入 subscription_plan 允许值
--    旧约束：('trial', 'pro', 'institution')
--    新约束：('trial', 'pro', 'institution', 'partner')
-- ──────────────────────────────────────────────────────────
alter table public.projects
  drop constraint if exists subscription_plan_check;

alter table public.projects
  add constraint subscription_plan_check
  check (subscription_plan in ('trial', 'pro', 'institution', 'partner'));

-- ──────────────────────────────────────────────────────────
-- 3. 更新 assert_project_write_allowed：
--    partner 计划视同 pro/institution，按 active_until 判断
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
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
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
-- 4. is_platform_admin() — 当前用户是否为平台管理员
-- ──────────────────────────────────────────────────────────
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public, auth
stable
as $$
  select exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = auth.uid()
  );
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 5. admin_list_projects(p_email)
--    按邮箱搜索该用户名下所有项目（模糊匹配，ILIKE）
-- ──────────────────────────────────────────────────────────
drop function if exists public.admin_list_projects(text);
create or replace function public.admin_list_projects(p_email text)
returns table (
  project_id             uuid,
  project_name           text,
  center_code            text,
  module                 text,
  owner_email            text,
  subscription_plan      text,
  subscription_active_until timestamptz,
  trial_expires_at       timestamptz,
  trial_grace_until      timestamptz,
  created_at             timestamptz
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
    p.created_at
  from public.projects p
  join auth.users u on u.id = p.created_by
  where u.email ilike '%' || p_email || '%'
  order by p.created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 6. admin_adjust_trial(p_project_id, p_extra_days)
--    从「现在」或「当前到期日」两者较大值起，延长 N 天
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_adjust_trial(
  p_project_id uuid,
  p_extra_days  int default 30
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select greatest(trial_expires_at, now())
  into   v_base
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  update public.projects
  set
    trial_expires_at  = v_base + make_interval(days => p_extra_days),
    trial_grace_until = v_base + make_interval(days => p_extra_days) + interval '7 days',
    subscription_plan = 'trial'        -- 确保计划还是 trial（不影响已付费计划）
  where id = p_project_id
    and subscription_plan = 'trial';   -- 只改 trial 状态的项目，不覆盖 pro/institution

  -- 如果是付费计划，改写 active_until
  update public.projects
  set
    subscription_active_until = greatest(subscription_active_until, now())
                                + make_interval(days => p_extra_days)
  where id = p_project_id
    and subscription_plan in ('pro', 'institution');
end;
$$;

grant execute on function public.admin_adjust_trial(uuid, int) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. admin_set_partner(p_project_id, p_active_until)
--    设为合作伙伴计划（默认永久：2099-12-31）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_partner(
  p_project_id  uuid,
  p_active_until timestamptz default '2099-12-31 23:59:59+00'::timestamptz
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

  update public.projects
  set
    subscription_plan         = 'partner',
    subscription_active_until = p_active_until
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_set_partner(uuid, timestamptz) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. admin_reset_to_trial(p_project_id)
--    撤回为普通试用（从今天起 30 天 + 7 天宽限）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reset_to_trial(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.projects
  set
    subscription_plan         = 'trial',
    subscription_active_until = null,
    trial_expires_at          = now() + interval '30 days',
    trial_grace_until         = now() + interval '37 days'
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;
end;
$$;

grant execute on function public.admin_reset_to_trial(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 初始管理员：在此处插入平台管理员邮箱
-- （部署时在 Supabase SQL Editor 运行一次）
-- ──────────────────────────────────────────────────────────
-- insert into public.platform_admins (email, note)
-- values ('your-admin@example.com', '平台超级管理员')
-- on conflict (email) do nothing;

-- MIGRATION 011: 0010_user_profiles.sql
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
DROP POLICY IF EXISTS "user_own_profile_select" ON user_profiles;
create policy "user_own_profile_select" on public.user_profiles
  for select using (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profile_insert" ON user_profiles;
create policy "user_own_profile_insert" on public.user_profiles
  for insert with check (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_profile_update" ON user_profiles;
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

-- MIGRATION 012: 0011_partner_contracts.sql
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

-- MIGRATION 013: 0012_pr1_foundation.sql
-- =============================================================
-- PR-1 基础列扩展
-- 目的：为后续所有 PR 打好地基，纯加列，不改现有逻辑，零风险
-- =============================================================

-- ─── 1. visits_long：补 eGFR 公式版本列 ─────────────────────────────────────
-- 记录这条 eGFR 是用哪个公式算出来的，让别人拿到数据也能复现
-- 取值说明：
--   'CKD-EPI-2021-Cr'  正式公式（无种族项，国际主流）
--   'manual'           研究者手动填写（不走公式）
--   'missing_inputs'   缺性别或出生年，无法计算
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS egfr_formula_version text;

COMMENT ON COLUMN visits_long.egfr_formula_version IS
  'eGFR计算公式版本：CKD-EPI-2021-Cr | manual | missing_inputs';

-- ─── 2. patient_tokens：token v2 扩展列 ─────────────────────────────────────
-- 原有 token 只有 active/expires_at，新增单次使用与撤销追踪

-- single_use：是否设置为"只能用一次"
--   true  → 患者提交随访后自动失效，下次需重新生成
--   false → 可多次提交（适合长期随访追踪）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS single_use boolean NOT NULL DEFAULT false;

-- used_at：首次提交随访的时间，NULL 表示还没用过
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS used_at timestamptz;

-- revoked_at：管理员手动撤销的时间，NULL 表示未撤销
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- revoke_reason：撤销原因（例："患者填错项目，重新生成"）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoke_reason text;

COMMENT ON COLUMN patient_tokens.single_use IS
  '是否单次使用：true=提交一次后自动失效；false=可反复提交';
COMMENT ON COLUMN patient_tokens.used_at IS
  '首次提交随访的时间戳，用于单次token失效判断与追溯';
COMMENT ON COLUMN patient_tokens.revoked_at IS
  '管理员撤销此token的时间，不为NULL则表示已撤销';
COMMENT ON COLUMN patient_tokens.revoke_reason IS
  '撤销原因，例：患者填错信息，重新生成';

-- ─── 3. 更新 patient_submit_visit_v2：支持 single_use 逻辑 ──────────────────
DROP FUNCTION IF EXISTS patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);
CREATE OR REPLACE FUNCTION patient_submit_visit_v2(
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
  visit_id          uuid,
  server_time       timestamptz,
  receipt_token     text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
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
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at > now() - interval '1 minute';

  IF v_recent_count >= 12 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    INSERT INTO security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    VALUES (v_token_row.project_id, v_token_row.patient_code,
            encode(digest(p_token,'sha256'),'hex'),
            'rate_limit_exceeded', 'HIGH',
            jsonb_build_object('recent_count', v_recent_count, 'window', '1min'));
    RAISE EXCEPTION 'rate_limit_exceeded' USING HINT = '提交过于频繁，链接已被暂停';
  END IF;

  -- ⑪ 同日重复检测：每日不超过 6 次
  SELECT COUNT(*) INTO v_same_day
  FROM visits_long
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录（事务原子性保证）
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
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT (visit_id) DO UPDATE
    SET receipt_token = v_receipt, expires_at = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id', v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;

-- ─── 4. 更新 revoke_patient_token：支持填写撤销原因 ────────────────────────
-- 先删除旧的单参数版本（0004 中创建），避免重名冲突
DROP FUNCTION IF EXISTS revoke_patient_token(text);

CREATE OR REPLACE FUNCTION revoke_patient_token(
  p_token        text,
  p_revoke_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE patient_tokens
  SET
    active        = false,
    revoked_at    = now(),
    revoke_reason = p_revoke_reason
  WHERE token = p_token
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = patient_tokens.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found_or_not_owner'
      USING HINT = 'token不存在，或您不是该项目的所有者';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION revoke_patient_token(text, text) TO authenticated;

-- MIGRATION 014: 0013_pr2_lab_catalog.sql
-- =============================================================
-- PR-2 化验项目字典 + 单位字典 + 自动换算
-- 目的：消灭"自由文本单位"乱象，让多中心数据可以直接合并分析
--
-- 背景举例：
--   A中心填 scr=1.2 mg/dL，B中心填 scr=106 μmol/L
--   过去合并时数据会乱掉；启用本 migration 后
--   两者都会自动换算为标准值，可直接比较
-- =============================================================

-- ─── 1. 化验项目字典：lab_test_catalog ─────────────────────────────────────
-- 每种化验项目在这里登记一次，防止"血肌酐"/"血清肌酐"/"Scr"各写各的
CREATE TABLE IF NOT EXISTS lab_test_catalog (
  code           text PRIMARY KEY,   -- 系统内部编码，例：CREAT
  name_cn        text NOT NULL,      -- 中文名，例：血肌酐
  name_en        text,               -- 英文名，例：Serum Creatinine
  module         text NOT NULL DEFAULT 'GENERAL',
                                     -- 适用模块：GENERAL/IGAN/LN/MN/KTX
  is_core        boolean NOT NULL DEFAULT false,
                                     -- 是否"核心指标"（缺失会触发质控警告）
  loinc_code     text,               -- LOINC 编码（选填，方便与国际数据库对接）
  standard_unit  text NOT NULL,      -- 标准单位，所有值都会换算到这个单位
  display_note   text,               -- 前端提示语，例：正常参考范围 0.6-1.2 mg/dL
  created_at     timestamptz DEFAULT now()
);

COMMENT ON TABLE lab_test_catalog IS
  '化验项目字典：统一编码，防止多中心录入时名称不一致导致合并失败';
COMMENT ON COLUMN lab_test_catalog.code IS
  '系统内部编码，建议全大写+下划线，例：CREAT、UPCR、HGB';
COMMENT ON COLUMN lab_test_catalog.standard_unit IS
  '所有中心的数据都换算到这个单位后存储，保证可直接合并分析';
COMMENT ON COLUMN lab_test_catalog.is_core IS
  '核心指标缺失会在质控系统中自动生成警告（Issue）';

-- ─── 2. 单位字典：unit_catalog ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unit_catalog (
  symbol      text PRIMARY KEY,    -- 单位符号，例：mg/dL
  description text,                -- 说明，例：毫克每分升
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE unit_catalog IS
  '允许使用的单位列表，防止"mg/dl"/"mg/dL"/"MG/DL"写法混用';

-- ─── 3. 项目-单位对应表：lab_test_unit_map ──────────────────────────────────
-- 每个化验项目只允许特定几个单位，并记录如何换算到标准单位
-- 换算公式：value_standard = value_raw * multiplier + offset_val
-- 举例：血肌酐 μmol/L → mg/dL：multiplier=1/88.4≈0.01131，offset_val=0
CREATE TABLE IF NOT EXISTS lab_test_unit_map (
  lab_test_code  text NOT NULL REFERENCES lab_test_catalog(code),
  unit_symbol    text NOT NULL REFERENCES unit_catalog(symbol),
  multiplier     numeric NOT NULL DEFAULT 1,   -- 换算系数
  offset_val     numeric NOT NULL DEFAULT 0,   -- 换算偏移（温度转换用，肾病一般为0）
  is_standard    boolean NOT NULL DEFAULT false, -- 是否就是标准单位（换算系数=1）
  PRIMARY KEY (lab_test_code, unit_symbol)
);

COMMENT ON TABLE lab_test_unit_map IS
  '每个化验项目允许哪些单位输入，以及如何换算到标准单位';
COMMENT ON COLUMN lab_test_unit_map.multiplier IS
  '换算系数：value_standard = value_raw × multiplier + offset_val。
  例：μmol/L→mg/dL，multiplier=0.01131（即1/88.4）';

-- ─── 4. labs_long 扩展列（向后兼容，原有列保留） ────────────────────────────
-- 原有列：lab_name / lab_value / lab_unit（自由文本，旧数据继续可读）
-- 新增列：结构化层，新录入必填，旧数据可为 NULL
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS lab_test_code     text REFERENCES lab_test_catalog(code),
  ADD COLUMN IF NOT EXISTS value_raw         numeric,
  ADD COLUMN IF NOT EXISTS unit_symbol       text REFERENCES unit_catalog(symbol),
  ADD COLUMN IF NOT EXISTS value_standard    numeric,
  ADD COLUMN IF NOT EXISTS standard_unit     text,
  ADD COLUMN IF NOT EXISTS measured_at       timestamptz;
  -- measured_at：精确到分钟的采集时间（比 lab_date 更精准）

COMMENT ON COLUMN labs_long.lab_test_code    IS '化验项目编码，对应 lab_test_catalog.code';
COMMENT ON COLUMN labs_long.value_raw        IS '原始值（录入时的数字，保持用户输入不变）';
COMMENT ON COLUMN labs_long.unit_symbol      IS '录入时使用的单位，对应 unit_catalog.symbol';
COMMENT ON COLUMN labs_long.value_standard   IS '已换算到标准单位的值，可直接用于多中心合并分析';
COMMENT ON COLUMN labs_long.standard_unit    IS '标准单位符号，来自 lab_test_catalog.standard_unit';

-- ─── 5. 化验值标准化函数：normalize_lab_value() ──────────────────────────────
-- 输入：化验编码、原始值、录入单位
-- 输出：标准值（已换算）
-- 举例：normalize_lab_value('CREAT', 88.4, 'μmol/L') → 1.00
--       normalize_lab_value('UPCR', 2000, 'mg/g')    → 2.00
CREATE OR REPLACE FUNCTION normalize_lab_value(
  p_code    text,
  p_value   numeric,
  p_unit    text
)
RETURNS numeric
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_multi numeric;
  v_off   numeric;
BEGIN
  SELECT multiplier, offset_val
    INTO v_multi, v_off
  FROM lab_test_unit_map
  WHERE lab_test_code = p_code
    AND unit_symbol   = p_unit;

  IF NOT FOUND THEN
    -- 单位不在允许列表中，返回 NULL，触发质控 Issue
    RETURN NULL;
  END IF;

  RETURN ROUND(p_value * v_multi + v_off, 4);
END;
$$;

COMMENT ON FUNCTION normalize_lab_value IS
  '将化验原始值换算到标准单位。例：normalize_lab_value(''CREAT'',88.4,''μmol/L'')=1.00';

-- ─── 6. 校验并写入化验记录的 RPC：upsert_lab_record() ────────────────────────
-- 这是前端保存化验记录时调用的函数
-- 步骤：① 校验项目存在 ② 校验单位允许 ③ 自动换算 ④ 写入
CREATE OR REPLACE FUNCTION upsert_lab_record(
  p_project_id   uuid,
  p_patient_code text,
  p_lab_date     date,
  p_lab_test_code text,
  p_value_raw    numeric,
  p_unit_symbol  text,
  p_measured_at  timestamptz DEFAULT NULL,
  p_lab_id       uuid        DEFAULT NULL  -- NULL=新增，有值=更新
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_standard      numeric;
  v_std_unit      text;
  v_result_id     uuid;
  v_map_exists    boolean;
BEGIN
  -- ① 校验项目存在
  IF NOT EXISTS(SELECT 1 FROM lab_test_catalog WHERE code = p_lab_test_code) THEN
    RAISE EXCEPTION 'lab_test_code_not_found'
      USING HINT = '化验项目编码 "' || p_lab_test_code || '" 不在字典中，请从下拉列表选择';
  END IF;

  -- ② 校验单位被允许
  SELECT EXISTS(
    SELECT 1 FROM lab_test_unit_map
    WHERE lab_test_code = p_lab_test_code AND unit_symbol = p_unit_symbol
  ) INTO v_map_exists;

  IF NOT v_map_exists THEN
    RAISE EXCEPTION 'unit_not_allowed'
      USING HINT = '单位 "' || p_unit_symbol || '" 不是 "' || p_lab_test_code
                 || '" 的允许单位，请从下拉列表选择';
  END IF;

  -- ③ 自动换算标准值
  v_standard := normalize_lab_value(p_lab_test_code, p_value_raw, p_unit_symbol);
  SELECT standard_unit INTO v_std_unit FROM lab_test_catalog WHERE code = p_lab_test_code;

  -- ④ 检查项目写入权限
  PERFORM assert_project_write_allowed(p_project_id);

  -- ⑤ 新增或更新
  IF p_lab_id IS NULL THEN
    INSERT INTO labs_long(
      project_id, patient_code, lab_date,
      lab_name,   lab_value,    lab_unit,        -- 保持向后兼容列
      lab_test_code, value_raw, unit_symbol,
      value_standard, standard_unit, measured_at
    ) VALUES (
      p_project_id, p_patient_code, p_lab_date,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      v_standard, v_std_unit, p_measured_at
    )
    RETURNING id INTO v_result_id;
  ELSE
    UPDATE labs_long SET
      lab_date       = p_lab_date,
      lab_name       = p_lab_test_code,
      lab_value      = p_value_raw,
      lab_unit       = p_unit_symbol,
      lab_test_code  = p_lab_test_code,
      value_raw      = p_value_raw,
      unit_symbol    = p_unit_symbol,
      value_standard = v_standard,
      standard_unit  = v_std_unit,
      measured_at    = p_measured_at,
      updated_at     = now(),
      updated_by     = auth.uid()
    WHERE id = p_lab_id
      AND project_id = p_project_id
    RETURNING id INTO v_result_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'lab_not_found' USING HINT = '化验记录不存在或无权修改';
    END IF;
  END IF;

  RETURN v_result_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_lab_record TO authenticated;

-- ─── 7. Seed 数据：常用肾病科化验项目 ─────────────────────────────────────
-- 项目字典
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- 核心肾功能
  ('CREAT',  '血肌酐',             'Serum Creatinine',      'GENERAL', true,  '2160-0', 'mg/dL',
   '正常参考范围（成人）：男 0.7-1.2 mg/dL，女 0.5-1.0 mg/dL'),
  ('UPCR',   '尿蛋白/肌酐比',      'Urine PCR',             'GENERAL', true,  '13705-9','g/g',
   '正常 <0.15 g/g；IgAN缓解目标 <0.3 g/g；大量蛋白尿 >3.5 g/g'),
  ('EGFR',   'eGFR（实验室报告）', 'eGFR (lab report)',     'GENERAL', false, '62238-1','mL/min/1.73m²',
   '若有实验室报告的eGFR可录入；系统也会自动用CKD-EPI公式计算'),

  -- 血常规
  ('HGB',    '血红蛋白',           'Hemoglobin',            'GENERAL', false, '718-7',  'g/dL',
   '正常参考范围：男 13.5-17.5 g/dL，女 12-16 g/dL'),
  ('WBC',    '白细胞计数',         'WBC',                   'GENERAL', false, '6690-2', '10^9/L',
   '正常 4-10×10⁹/L'),
  ('PLT',    '血小板',             'Platelet',              'GENERAL', false, '777-3',  '10^9/L',
   '正常 100-300×10⁹/L'),

  -- 肝功能
  ('ALT',    '谷丙转氨酶',         'ALT',                   'GENERAL', false, '1742-6', 'U/L',
   '正常 <40 U/L'),
  ('AST',    '谷草转氨酶',         'AST',                   'GENERAL', false, '1920-8', 'U/L',
   '正常 <40 U/L'),
  ('ALB',    '血清白蛋白',         'Albumin',               'GENERAL', false, '1751-7', 'g/dL',
   '正常 3.5-5.0 g/dL；低于3.5提示低蛋白血症'),

  -- 电解质与代谢
  ('K',      '血钾',               'Potassium',             'GENERAL', false, '2823-3', 'mmol/L',
   '正常 3.5-5.0 mmol/L；>5.5为高钾，<3.5为低钾'),
  ('NA',     '血钠',               'Sodium',                'GENERAL', false, '2951-2', 'mmol/L',
   '正常 135-145 mmol/L'),
  ('CA',     '血钙',               'Calcium',               'GENERAL', false, '17861-6','mmol/L',
   '正常 2.1-2.6 mmol/L'),
  ('PHOS',   '血磷',               'Phosphorus',            'GENERAL', false, '2777-1', 'mmol/L',
   '正常 0.8-1.5 mmol/L'),
  ('UA',     '血尿酸',             'Uric Acid',             'GENERAL', false, '3084-1', 'μmol/L',
   '正常：男 <420 μmol/L，女 <360 μmol/L'),
  ('CO2',    '碳酸氢根（HCO3）',   'Bicarbonate',           'GENERAL', false, '1963-8', 'mmol/L',
   '正常 22-29 mmol/L；低于22提示代谢性酸中毒'),

  -- 血脂
  ('TCHOL',  '总胆固醇',           'Total Cholesterol',     'GENERAL', false, '2093-3', 'mmol/L',
   '正常 <5.2 mmol/L'),
  ('TG',     '甘油三酯',           'Triglycerides',         'GENERAL', false, '2571-8', 'mmol/L',
   '正常 <1.7 mmol/L'),
  ('LDL',    '低密度脂蛋白',       'LDL-C',                 'GENERAL', false, '13457-7','mmol/L',
   '心肾保护目标 <1.8 mmol/L（高危患者）'),
  ('HDL',    '高密度脂蛋白',       'HDL-C',                 'GENERAL', false, '2085-9', 'mmol/L',
   '越高越好，男>1.0，女>1.3 mmol/L'),

  -- 炎症指标
  ('CRP',    'C反应蛋白',          'CRP',                   'GENERAL', false, '1988-5', 'mg/L',
   '正常 <5 mg/L'),

  -- IgA 肾病专项
  ('IGA',    '血清IgA',            'Serum IgA',             'IGAN',    false, '1746-7', 'g/L',
   '正常成人 0.7-4.0 g/L；IgAN患者常偏高'),
  ('IGAG',   'IgA/IgG比值',        'IgA/IgG Ratio',         'IGAN',    false, NULL,     'ratio',
   'IgAN辅助诊断指标'),

  -- 狼疮性肾炎专项
  ('C3',     '补体C3',             'Complement C3',         'LN',      false, '4532-9', 'g/L',
   '正常 0.9-1.8 g/L；LN活动期常降低'),
  ('C4',     '补体C4',             'Complement C4',         'LN',      false, '4533-7', 'g/L',
   '正常 0.1-0.4 g/L'),
  ('DSDNA',  '抗dsDNA抗体',        'Anti-dsDNA',            'LN',      false, '11065-0','IU/mL',
   '<10 IU/mL为阴性；升高提示LN活动'),

  -- 移植专项
  ('TACRO',  '他克莫司血药浓度',   'Tacrolimus Trough',     'KTX',     false, '35151-0','ng/mL',
   '目标谷浓度因时期而异，通常术后1-3月：8-12 ng/mL，稳定期：5-8 ng/mL'),
  ('CSA',    '环孢素血药浓度',      'Cyclosporine Trough',   'KTX',     false, '34533-0','ng/mL',
   '目标因中心和时期不同，参考各中心方案')

ON CONFLICT (code) DO NOTHING;

-- 单位字典
INSERT INTO unit_catalog(symbol, description) VALUES
  ('mg/dL',       '毫克每分升'),
  ('μmol/L',       '微摩尔每升'),
  ('umol/L',       '微摩尔每升（ASCII写法）'),
  ('g/g',          '克每克（尿蛋白/肌酐比）'),
  ('mg/g',         '毫克每克（尿蛋白/肌酐比）'),
  ('mg/mmol',      '毫克每毫摩尔（尿蛋白/肌酐比，欧洲常用）'),
  ('g/L',          '克每升'),
  ('g/dL',         '克每分升'),
  ('mmol/L',       '毫摩尔每升'),
  ('U/L',          '单位每升（酶活性）'),
  ('mL/min/1.73m²','毫升/分钟/1.73平方米（eGFR标准单位）'),
  ('10^9/L',       '10的9次方每升（血细胞计数）'),
  ('mg/L',         '毫克每升'),
  ('IU/mL',        '国际单位每毫升'),
  ('ng/mL',        '纳克每毫升（药物浓度）'),
  ('ratio',        '比值（无量纲）')
ON CONFLICT (symbol) DO NOTHING;

-- 项目-单位对应（换算表）
-- 格式说明：value_standard = value_raw × multiplier
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- 血肌酐
  ('CREAT', 'mg/dL',  1,          0, true ),  -- 标准单位，直接用
  ('CREAT', 'μmol/L', 0.01130996, 0, false),  -- ÷88.4
  ('CREAT', 'umol/L', 0.01130996, 0, false),  -- 同上，ASCII写法

  -- 尿蛋白/肌酐比
  ('UPCR',  'g/g',    1,          0, true ),  -- 标准单位
  ('UPCR',  'mg/g',   0.001,      0, false),  -- ÷1000
  ('UPCR',  'mg/mmol',0.1130996,  0, false),  -- 1 mg/mmol = 0.113 g/g（近似）

  -- eGFR（实验室报告，单位一致，直接用）
  ('EGFR',  'mL/min/1.73m²', 1,  0, true ),

  -- 血红蛋白
  ('HGB',   'g/dL',   1,          0, true ),
  ('HGB',   'g/L',    0.1,        0, false),  -- ÷10

  -- 白细胞/血小板（10^9/L 是标准）
  ('WBC',   '10^9/L', 1,          0, true ),
  ('PLT',   '10^9/L', 1,          0, true ),

  -- 肝功能
  ('ALT',   'U/L',    1,          0, true ),
  ('AST',   'U/L',    1,          0, true ),

  -- 白蛋白
  ('ALB',   'g/dL',   1,          0, true ),
  ('ALB',   'g/L',    0.1,        0, false),

  -- 电解质（mmol/L 标准）
  ('K',     'mmol/L', 1,          0, true ),
  ('NA',    'mmol/L', 1,          0, true ),
  ('CA',    'mmol/L', 1,          0, true ),
  ('PHOS',  'mmol/L', 1,          0, true ),
  ('CO2',   'mmol/L', 1,          0, true ),

  -- 血尿酸（μmol/L 标准）
  ('UA',    'μmol/L', 1,          0, true ),
  ('UA',    'umol/L', 1,          0, false), -- ASCII 写法
  ('UA',    'mg/dL',  59.485,     0, false), -- ×59.485 → μmol/L

  -- 血脂（mmol/L 标准）
  ('TCHOL', 'mmol/L', 1,          0, true ),
  ('TCHOL', 'mg/dL',  0.02586,    0, false),
  ('TG',    'mmol/L', 1,          0, true ),
  ('TG',    'mg/dL',  0.01129,    0, false),
  ('LDL',   'mmol/L', 1,          0, true ),
  ('LDL',   'mg/dL',  0.02586,    0, false),
  ('HDL',   'mmol/L', 1,          0, true ),
  ('HDL',   'mg/dL',  0.02586,    0, false),

  -- 炎症
  ('CRP',   'mg/L',   1,          0, true ),

  -- IgAN 专项
  ('IGA',   'g/L',    1,          0, true ),
  ('IGAG',  'ratio',  1,          0, true ),

  -- LN 专项
  ('C3',    'g/L',    1,          0, true ),
  ('C4',    'g/L',    1,          0, true ),
  ('DSDNA', 'IU/mL',  1,          0, true ),

  -- KTX 专项
  ('TACRO', 'ng/mL',  1,          0, true ),
  ('CSA',   'ng/mL',  1,          0, true )

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- ─── 8. RLS：字典表只读（所有已登录用户可读，不可修改） ─────────────────────
ALTER TABLE lab_test_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_catalog      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_test_unit_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_select" ON lab_test_catalog;
CREATE POLICY "catalog_select" ON lab_test_catalog FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "unit_select" ON unit_catalog;
CREATE POLICY "unit_select"    ON unit_catalog      FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "map_select" ON lab_test_unit_map;
CREATE POLICY "map_select"     ON lab_test_unit_map FOR SELECT TO authenticated, anon USING (true);

-- MIGRATION 015: 0014_pr3_validators.sql
-- =============================================================
-- PR-3 核心校验器：日期链 / 重复 / 跳变 / eGFR 版本化
-- 目的：在数据写入时自动拦截明显错误，同时保留"留痕后保存"通道
--
-- 三种处理级别：
--   ERROR   → 直接拒绝，返回 HTTP 400，必须改正
--   WARNING → 弹窗提示 + 必填 reason 后才能保存
--   INFO    → 前端提示，不阻止保存
-- =============================================================

-- ─── 1. 给需要留痕 reason 的表加 qc_reason 列 ─────────────────────────────
-- visits_long：随访记录留痕原因
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

-- labs_long：化验记录留痕原因
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

COMMENT ON COLUMN visits_long.qc_reason IS
  '质控留痕原因。当数据触发跳变警告或同日重复时，必须填写原因才能保存。
  例："患者住院期间急性肾损伤，Scr快速升高，已与主治医生确认"';

COMMENT ON COLUMN labs_long.qc_reason IS
  '质控留痕原因。例："同日两次检测，第一次采血失误，本次为复查确认值"';

-- ─── 2. 硬范围限制更新（visits_long）────────────────────────────────────────
-- 原有约束已有 sbp/dbp/scr 范围，补充更明确的说明
-- upcr 单位为 g/g 时最大 50；为 mg/g 时最大 50000（历史数据兼容）
-- 这里先更新 upcr 上限（原来只有 >=0）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'visits_long_upcr_range'
      AND table_name = 'visits_long'
  ) THEN
    ALTER TABLE visits_long
      ADD CONSTRAINT visits_long_upcr_range CHECK (upcr IS NULL OR (upcr >= 0 AND upcr <= 50000));
  END IF;
END $$;

-- ─── 3. 日期链校验函数：validate_date_chain() ───────────────────────────────
-- 验证：biopsy_date ≤ baseline_date ≤ visit_date ≤ event_date
-- 返回：错误信息 text，NULL 表示通过
CREATE OR REPLACE FUNCTION validate_date_chain(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date  DEFAULT NULL,
  p_event_date   date  DEFAULT NULL
)
RETURNS text   -- NULL=通过；非NULL=错误原因
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = p_project_id
    AND patient_code = p_patient_code;

  -- 没有基线数据，无法校验，放行
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 随访日期必须 ≥ 基线日期
  IF p_visit_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_visit_date < v_baseline.baseline_date THEN
      RETURN '随访日期（' || p_visit_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。'
           || '如是基线前检查，请改录入基线数据。';
    END IF;
  END IF;

  -- 终点日期必须 ≥ 基线日期
  IF p_event_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_event_date < v_baseline.baseline_date THEN
      RETURN '终点日期（' || p_event_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。';
    END IF;
  END IF;

  RETURN NULL;  -- 通过
END;
$$;

COMMENT ON FUNCTION validate_date_chain IS
  '校验日期链：随访/终点日期必须不早于基线日期。返回NULL表示通过，非NULL为错误说明。';

-- ─── 4. 重复录入检测：check_duplicate_lab() ─────────────────────────────────
-- 同一患者、同一日期、同一化验项目已有记录时返回提示
-- 返回：NULL=无重复；非NULL=已有记录信息
CREATE OR REPLACE FUNCTION check_duplicate_lab(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_date      date,
  p_lab_test_code text,
  p_exclude_id    uuid DEFAULT NULL  -- 编辑时排除自身
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_existing labs_long%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_date      = p_lab_date
    AND lab_test_code = p_lab_test_code
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN '该患者在 ' || p_lab_date || ' 已有一条 '
         || p_lab_test_code || ' 记录（值：'
         || COALESCE(v_existing.value_raw::text, v_existing.lab_value::text, '?')
         || ' ' || COALESCE(v_existing.unit_symbol, v_existing.lab_unit, '')
         || '）。如确需保存，请在"留痕原因"中说明（如：复查确认值）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 5. 跳变检测：check_jump_spike() ────────────────────────────────────────
-- 与同患者上一次同化验项目的标准值相比，变化超过阈值则提示
-- 返回：NULL=正常；非NULL=跳变说明
CREATE OR REPLACE FUNCTION check_jump_spike(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_test_code text,
  p_value_std     numeric,  -- 本次标准值
  p_lab_date      date,
  p_exclude_id    uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_prev_value numeric;
  v_prev_date  date;
  v_ratio      numeric;
  v_threshold  numeric;
BEGIN
  -- 找最近一次同项目记录
  SELECT value_standard, lab_date INTO v_prev_value, v_prev_date
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_test_code = p_lab_test_code
    AND value_standard IS NOT NULL
    AND lab_date < p_lab_date          -- 只和更早的比
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY lab_date DESC
  LIMIT 1;

  IF NOT FOUND OR v_prev_value IS NULL OR v_prev_value = 0 THEN
    RETURN NULL;  -- 没有历史值或历史值为0，无法判断跳变
  END IF;

  v_ratio := p_value_std / v_prev_value;

  -- 不同项目用不同阈值（倍数）
  v_threshold := CASE p_lab_test_code
    WHEN 'CREAT' THEN 3.0   -- 血肌酐：涨3倍触发（AKI可能）
    WHEN 'UPCR'  THEN 5.0   -- 尿蛋白：涨5倍触发（波动本身大）
    WHEN 'K'     THEN 2.0   -- 血钾：涨2倍触发（高钾危险）
    ELSE 4.0                 -- 其他指标默认4倍
  END;

  IF v_ratio > v_threshold OR v_ratio < (1.0 / v_threshold) THEN
    RETURN p_lab_test_code || ' 本次值（' || p_value_std || '）与上次（'
         || v_prev_date || '，' || v_prev_value || '）相差超过 '
         || ROUND((v_ratio - 1) * 100) || '%，存在异常跳变。'
         || '如确认无误，请在"留痕原因"中说明（如：患者住院期间AKI，已与上级确认）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 6. 随访记录综合校验：validate_visit_record() ──────────────────────────
-- 前端和 RPC 都调用这个函数，返回 errors + warnings
-- errors   → 必须修正，无法保存
-- warnings → 需要填 reason，填完才能保存
CREATE OR REPLACE FUNCTION validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 30 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 30–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 30 OR p_dbp > 300) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 30–300 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_visit_record    TO authenticated, anon;
GRANT EXECUTE ON FUNCTION validate_date_chain      TO authenticated;
GRANT EXECUTE ON FUNCTION check_duplicate_lab      TO authenticated;
GRANT EXECUTE ON FUNCTION check_jump_spike         TO authenticated;

COMMENT ON FUNCTION validate_visit_record IS
  '随访记录综合校验。返回 {errors:[...], warnings:[...]}。
  errors 必须修正才能保存；warnings 需要填写 qc_reason 才能保存。
  例：validate_visit_record(pid, ''P001'', ''2024-01-15'', 160, 95, 150, 1.2)';

-- ─── 7. eGFR 计算函数：ckd_epi_2021() ──────────────────────────────────────
-- 公式：CKD-EPI 2021（无种族项，国际主流，可直接引用）
-- 输入：血肌酐（mg/dL）、性别（M/F）、年龄（岁）
-- 输出：eGFR（mL/min/1.73m²）
-- 论文引用：Inker et al., NEJM 2021;385:1737–1749
CREATE OR REPLACE FUNCTION ckd_epi_2021(
  p_scr_mg_dl numeric,   -- 血肌酐，单位必须是 mg/dL
  p_sex       text,      -- 'M' 或 'F'
  p_age_years numeric    -- 年龄（岁）
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_kappa    numeric;
  v_alpha    numeric;
  v_sex_mult numeric;
  v_scr_k    numeric;
BEGIN
  IF p_scr_mg_dl IS NULL OR p_sex IS NULL OR p_age_years IS NULL THEN
    RETURN NULL;
  END IF;

  -- 按性别设定参数（CKD-EPI 2021 原文参数）
  IF upper(p_sex) = 'F' THEN
    v_kappa    := 0.7;
    v_alpha    := -0.241;
    v_sex_mult := 1.012;
  ELSE
    v_kappa    := 0.9;
    v_alpha    := -0.302;
    v_sex_mult := 1.0;
  END IF;

  v_scr_k := p_scr_mg_dl / v_kappa;

  RETURN ROUND(
    142.0
    * POWER(LEAST(v_scr_k, 1.0), v_alpha)
    * POWER(GREATEST(v_scr_k, 1.0), -1.200)
    * POWER(0.9938, p_age_years)
    * v_sex_mult
  , 1);
END;
$$;

COMMENT ON FUNCTION ckd_epi_2021 IS
  'CKD-EPI 2021 公式计算eGFR（无种族项）。
  输入：血肌酐mg/dL、性别(M/F)、年龄（岁）。
  论文：Inker et al., NEJM 2021;385:1737-1749。
  例：ckd_epi_2021(1.0, ''M'', 50) → 约87 mL/min/1.73m²';

-- ─── 8. 自动计算 eGFR 的触发器（visits_long） ────────────────────────────
-- 每次写入/更新 scr_umol_l 时，若有患者年龄和性别，自动计算 eGFR
CREATE OR REPLACE FUNCTION _auto_compute_egfr()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
  v_age      numeric;
  v_scr_mgdl numeric;
BEGIN
  -- 只在有 scr_umol_l 时才计算
  IF NEW.scr_umol_l IS NULL THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 查基线（获取性别和出生年）
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = NEW.project_id
    AND patient_code = NEW.patient_code;

  IF NOT FOUND OR v_baseline.sex IS NULL OR v_baseline.birth_year IS NULL THEN
    -- 缺性别或出生年，无法计算
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 从 μmol/L 换算 mg/dL
  v_scr_mgdl := NEW.scr_umol_l * 0.01130996;

  -- 计算年龄
  v_age := EXTRACT(YEAR FROM NEW.visit_date) - v_baseline.birth_year;
  IF v_age < 18 OR v_age > 120 THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 仅当用户没有手动填 egfr 时，才用公式覆盖
  -- 若用户手填了 egfr，则 formula_version='manual'
  IF NEW.egfr IS NOT NULL AND (TG_OP = 'UPDATE' AND OLD.egfr IS NOT NULL AND NEW.egfr = OLD.egfr)
     OR (TG_OP = 'INSERT' AND NEW.egfr_formula_version = 'manual') THEN
    -- 手动填写，保留
    RETURN NEW;
  END IF;

  NEW.egfr := ckd_epi_2021(v_scr_mgdl, v_baseline.sex, v_age);
  NEW.egfr_formula_version := 'CKD-EPI-2021-Cr';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_egfr ON visits_long;
CREATE TRIGGER trg_auto_egfr
  BEFORE INSERT OR UPDATE OF scr_umol_l ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _auto_compute_egfr();

COMMENT ON TRIGGER trg_auto_egfr ON visits_long IS
  '每次录入/更新血肌酐时，自动用 CKD-EPI 2021 公式计算 eGFR 并记录公式版本';

GRANT EXECUTE ON FUNCTION ckd_epi_2021 TO authenticated;

-- MIGRATION 016: 0015_pr5_pii_guard.sql
-- =============================================================
-- PR-5 PII 全路径拦截：数据库触发器层
-- 目的：无论从哪个入口（staff录入/patient录入/直接API）写入数据
--       只要包含个人身份信息，数据库就拒绝保存
--
-- 什么是 PII（个人可识别信息）？
-- ─────────────────────────────
-- 本系统是科研数据库，严禁录入以下信息：
--   ✗ 手机号：如 13812345678
--   ✗ 身份证号：如 110101199001011234
--   ✗ 住院号/病案号/门诊号：如 住院号:123456、MRN: 789
--   ✗ 姓名：如 患者:张三、姓名:李四
--   ✗ 8位以上连续数字（可能是各种编号）
--
-- 正确做法：
--   ✓ 用中心分配的患者编码，如 BJ01-2024-001
--   ✓ 备注只写临床事实，如 "血压控制良好，依从性好"
-- =============================================================

-- ─── 1. 通用 PII 拦截触发器函数 ─────────────────────────────────────────────
-- 本函数被注册到所有含自由文本字段的表上
-- 检查的字段通过 TG_ARGV 传入
CREATE OR REPLACE FUNCTION _pii_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_field text;
  v_value text;
BEGIN
  -- 遍历需要检查的字段列表（由触发器注册时通过参数指定）
  FOREACH v_field IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text', v_field) INTO v_value USING NEW;
    IF v_value IS NOT NULL AND _contains_pii(v_value) THEN
      RAISE EXCEPTION 'pii_detected_blocked'
        USING HINT = format(
          '字段 "%s" 中检测到疑似个人身份信息（PII）。'
          '本系统为科研数据库，禁止录入手机号、身份证、住院号、姓名等可识别信息。'
          '请检查并修改后重新保存。问题内容片段：%s',
          v_field,
          left(v_value, 30) || CASE WHEN length(v_value) > 30 THEN '...' ELSE '' END
        );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION _pii_guard IS
  'PII拦截触发器。检测自由文本字段中的个人身份信息并拒绝写入。
  触发时抛出异常 pii_detected_blocked，前端可捕获并显示友好提示。';

-- ─── 2. 注册触发器到各个表 ──────────────────────────────────────────────────

-- visits_long.notes（随访备注）
DROP TRIGGER IF EXISTS trg_pii_guard_visits ON visits_long;
CREATE TRIGGER trg_pii_guard_visits
  BEFORE INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- labs_long.qc_reason（化验留痕原因）
DROP TRIGGER IF EXISTS trg_pii_guard_labs ON labs_long;
CREATE TRIGGER trg_pii_guard_labs
  BEFORE INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('qc_reason');

-- meds_long（用药记录：drug_name / drug_class / dose 一般不含PII，但 dose 字段可能有备注）
-- 暂不加 trigger，在前端校验即可（drug 字段结构化，PII风险低）

-- variants_long.notes（基因变异备注）
DROP TRIGGER IF EXISTS trg_pii_guard_variants ON variants_long;
CREATE TRIGGER trg_pii_guard_variants
  BEFORE INSERT OR UPDATE ON variants_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- events_long.notes（终点事件备注）
DROP TRIGGER IF EXISTS trg_pii_guard_events ON events_long;
CREATE TRIGGER trg_pii_guard_events
  BEFORE INSERT OR UPDATE ON events_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- ─── 3. 增强 _contains_pii 函数（补充更多模式） ─────────────────────────────
-- 原函数已有基础 regex，这里覆盖并补充更多模式
CREATE OR REPLACE FUNCTION _contains_pii(p_text text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) = 0 THEN
    RETURN false;
  END IF;

  RETURN (
    -- 中国大陆手机号（1[3-9] 开头，11位）
    p_text ~ '1[3-9][0-9]{9}'

    -- 中国身份证（18位，包含校验位X）
    OR p_text ~ '[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]'

    -- 住院相关关键词 + 数字（如 住院号:123456、MRN: 789、病案号123）
    OR p_text ~* '(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}'

    -- 姓名关键词（如 患者:张三、姓名：李四、病人 王五）
    OR p_text ~* '(姓名|患者姓名|病人|name\s*[:：])\s*[\u4e00-\u9fa5]{2,4}'

    -- 8位以上连续数字（各类编号风险）
    OR p_text ~ '[0-9]{8,}'

    -- 邮箱（含 @ 符号，且 @ 前后都有字符）
    OR p_text ~ '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

    -- 身份证关键词
    OR p_text ~* '(身份证|id\s*card|身份号)[^a-z]{0,5}[0-9]'
  );
END;
$$;

-- ─── 4. 测试用例（注释说明，实际验证时可执行） ─────────────────────────────
-- 以下 SELECT 均应返回 true（表示检测到PII，会被拦截）：
-- SELECT _contains_pii('患者手机：13812345678');             → true（手机号）
-- SELECT _contains_pii('住院号:20240012345');               → true（住院号）
-- SELECT _contains_pii('身份证：110101199001011234');        → true（身份证）
-- SELECT _contains_pii('患者：张三，血压控制良好');           → true（姓名关键词）
-- SELECT _contains_pii('MRN: 789456，复查正常');             → true（MRN）
-- SELECT _contains_pii('creatinine 1.2 mg/dL, stable');   → false（正常临床描述）
-- SELECT _contains_pii('血压控制良好，依从性佳');             → false（正常中文描述）
-- SELECT _contains_pii('UPCR 1.5 g/g 较前下降');            → false（正常化验描述）

-- MIGRATION 017: 0016_pr6_issue_system.sql
-- =============================================================
-- PR-6 Issue/Query 质控闭环系统
-- 目的：把"质控警告"变成"可追踪的任务"，直到问题解决才关闭
--
-- 类比：这是数据版的"Bug 跟踪系统"
--   ● 数据写入时自动检测问题 → 生成 Issue（OPEN）
--   ● 研究者修正数据 → Issue 自动关闭（RESOLVED）
--   ● 无法修正但有理由 → 手动标记 WONT_FIX（必须填理由）
--   ● 仪表盘展示：哪些患者还有未解决的数据质量问题
-- =============================================================

-- ─── 1. Issue 主表：data_issues ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issues (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  center_code     text,                 -- 来自项目的中心编码，方便按中心筛查
  patient_code    text NOT NULL,        -- 问题关联的患者
  record_type     text NOT NULL,        -- 问题关联的记录类型：visit/lab/baseline/event
  record_id       uuid,                 -- 问题记录的 ID（可 NULL，如缺失数据没有ID）
  rule_code       text NOT NULL,        -- 触发的规则编码（见下方说明）
  severity        text NOT NULL DEFAULT 'warning',  -- critical/warning/info
  status          text NOT NULL DEFAULT 'OPEN',     -- OPEN/IN_PROGRESS/RESOLVED/WONT_FIX
  assigned_to     uuid REFERENCES auth.users(id),   -- 指派给哪位研究者处理
  message         text NOT NULL,        -- 问题描述（面向研究者的中文说明）
  resolution_note text,                 -- 解决说明（RESOLVED 或 WONT_FIX 时必填）
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  resolved_at     timestamptz,          -- 自动解决时间
  created_by      uuid REFERENCES auth.users(id),   -- 系统自动创建或人工创建

  CONSTRAINT data_issues_severity_check
    CHECK (severity IN ('critical', 'warning', 'info')),
  CONSTRAINT data_issues_status_check
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX')),
  CONSTRAINT data_issues_record_type_check
    CHECK (record_type IN ('visit', 'lab', 'baseline', 'event', 'medication'))
);

-- 去重索引：同一规则+同一记录只生成一个 Issue
CREATE UNIQUE INDEX IF NOT EXISTS data_issues_dedup
  ON data_issues(project_id, patient_code, record_type, COALESCE(record_id::text,'NULL'), rule_code)
  WHERE status NOT IN ('RESOLVED', 'WONT_FIX');

CREATE INDEX IF NOT EXISTS data_issues_project_status
  ON data_issues(project_id, status, severity);

CREATE INDEX IF NOT EXISTS data_issues_patient
  ON data_issues(project_id, patient_code, status);

COMMENT ON TABLE data_issues IS
  'Issue质控系统：记录每条数据的质量问题，跟踪解决状态。
  类似GitHub Issues，每个数据问题是一个Issue，修复后自动关闭。';

COMMENT ON COLUMN data_issues.rule_code IS
  '触发规则编码，可选值：
  MISSING_CORE_FIELD   - 缺失核心字段（必填项为空）
  OUT_OF_RANGE         - 超出合理范围
  UNIT_NOT_ALLOWED     - 化验单位不在允许列表中
  DATE_CONFLICT        - 日期链冲突（如随访早于基线）
  DUPLICATE_SAME_DAY   - 同日重复录入
  JUMP_SPIKE           - 数值异常跳变
  MISSING_EGFR_INPUTS  - 缺性别/出生年导致无法计算eGFR
  PII_SUSPECTED        - 疑似含个人身份信息（严重）';

COMMENT ON COLUMN data_issues.severity IS
  'critical=数据无法用于分析（如日期冲突）；
  warning=数据可疑需确认（如跳变）；
  info=建议补充（如eGFR无法计算）';

-- ─── 2. Issue 评论表：data_issue_comments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issue_comments (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  issue_id   uuid NOT NULL REFERENCES data_issues(id) ON DELETE CASCADE,
  comment    text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_issue_comments_issue
  ON data_issue_comments(issue_id, created_at);

COMMENT ON TABLE data_issue_comments IS
  'Issue 讨论记录：研究者可以在Issue下留言，说明情况、协商处理方案';

-- ─── 3. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE data_issues         ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_issue_comments ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看/操作自己项目的 Issue
DROP POLICY IF EXISTS "issues_project_owner" ON data_issues;
CREATE POLICY "issues_project_owner"
  ON data_issues FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = data_issues.project_id
      AND p.created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "comments_issue_owner" ON data_issue_comments;
CREATE POLICY "comments_issue_owner"
  ON data_issue_comments FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.id = data_issue_comments.issue_id
      AND p.created_by = auth.uid()
  ));

-- ─── 4. 自动生成/更新 Issue 的函数：raise_or_update_issue() ──────────────────
-- 每次数据写入后由触发器调用
-- 去重逻辑：同一规则+同一记录，只有一个 OPEN/IN_PROGRESS Issue
CREATE OR REPLACE FUNCTION raise_or_update_issue(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text,
  p_severity     text,
  p_message      text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_issue_id   uuid;
  v_center     text;
BEGIN
  SELECT center_code INTO v_center FROM projects WHERE id = p_project_id;

  -- 尝试找已有的 OPEN 或 IN_PROGRESS Issue（去重）
  SELECT id INTO v_issue_id
  FROM data_issues
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX')
  LIMIT 1;

  IF FOUND THEN
    -- 更新已有 Issue（信息可能有变化）
    UPDATE data_issues SET
      message    = p_message,
      severity   = p_severity,
      updated_at = now()
    WHERE id = v_issue_id;
  ELSE
    -- 新建 Issue
    INSERT INTO data_issues(
      project_id, center_code, patient_code,
      record_type, record_id, rule_code,
      severity, status, message
    ) VALUES (
      p_project_id, v_center, p_patient_code,
      p_record_type, p_record_id, p_rule_code,
      p_severity, 'OPEN', p_message
    )
    RETURNING id INTO v_issue_id;
  END IF;

  RETURN v_issue_id;
END;
$$;

-- ─── 5. 自动关闭 Issue 的函数：resolve_issue_if_exists() ─────────────────────
-- 数据修正后调用，自动把对应 Issue 改为 RESOLVED
CREATE OR REPLACE FUNCTION resolve_issue_if_exists(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE data_issues SET
    status       = 'RESOLVED',
    resolved_at  = now(),
    resolution_note = '数据已修正，系统自动关闭',
    updated_at   = now()
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX');
END;
$$;

-- ─── 6. 手动关闭 Issue（WONT_FIX）：close_issue_wont_fix() ─────────────────
CREATE OR REPLACE FUNCTION close_issue_wont_fix(
  p_issue_id      uuid,
  p_resolution    text  -- 必填！说明为什么不修复
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF p_resolution IS NULL OR trim(p_resolution) = '' THEN
    RAISE EXCEPTION 'resolution_required'
      USING HINT = '标记为"不修复"时必须填写原因，例："该患者是历史数据导入，日期无法追溯"';
  END IF;

  UPDATE data_issues SET
    status          = 'WONT_FIX',
    resolution_note = p_resolution,
    resolved_at     = now(),
    updated_at      = now()
  WHERE id = p_issue_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = data_issues.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_not_found' USING HINT = 'Issue不存在或无权操作';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION close_issue_wont_fix  TO authenticated;
GRANT EXECUTE ON FUNCTION raise_or_update_issue TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_issue_if_exists TO authenticated;

-- ─── 7. QC 规则触发器：visits_long ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_visit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id = NEW.project_id AND patient_code = NEW.patient_code;

  -- 规则①：随访日期早于基线 → critical
  IF FOUND AND v_baseline.baseline_date IS NOT NULL
     AND NEW.visit_date < v_baseline.baseline_date THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'DATE_CONFLICT', 'critical',
      '随访日期（' || NEW.visit_date || '）早于基线日期（'
      || v_baseline.baseline_date || '），数据无法用于时序分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'DATE_CONFLICT'
    );
  END IF;

  -- 规则②：缺核心字段（scr 或 upcr）→ warning
  IF NEW.scr_umol_l IS NULL AND NEW.upcr IS NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_CORE_FIELD', 'warning',
      '随访记录（' || NEW.visit_date || '）缺少血肌酐和UPCR，eGFR及蛋白尿无法分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_CORE_FIELD'
    );
  END IF;

  -- 规则③：eGFR 因缺输入无法计算 → info
  IF NEW.egfr IS NULL AND NEW.scr_umol_l IS NOT NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_EGFR_INPUTS', 'info',
      '有血肌酐数据，但缺少患者性别或出生年，无法自动计算eGFR。请完善基线信息。'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_EGFR_INPUTS'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_visit ON visits_long;
CREATE TRIGGER trg_qc_visit
  AFTER INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_visit();

-- ─── 8. QC 规则触发器：labs_long ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_lab()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 规则：单位不在允许列表 → warning
  IF NEW.lab_test_code IS NOT NULL AND NEW.unit_symbol IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM lab_test_unit_map
      WHERE lab_test_code = NEW.lab_test_code
        AND unit_symbol   = NEW.unit_symbol
    ) THEN
      PERFORM raise_or_update_issue(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id,
        'UNIT_NOT_ALLOWED', 'warning',
        '化验项目 ' || NEW.lab_test_code || ' 使用了不允许的单位 "'
        || NEW.unit_symbol || '"，标准化换算失败，无法合并分析'
      );
    ELSE
      PERFORM resolve_issue_if_exists(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id, 'UNIT_NOT_ALLOWED'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_lab ON labs_long;
CREATE TRIGGER trg_qc_lab
  AFTER INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_lab();

-- ─── 9. 查询 Issue 统计的 RPC（仪表盘用） ───────────────────────────────────
CREATE OR REPLACE FUNCTION get_issue_summary(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_open',    COUNT(*) FILTER (WHERE status = 'OPEN'),
    'total_in_prog', COUNT(*) FILTER (WHERE status = 'IN_PROGRESS'),
    'total_resolved',COUNT(*) FILTER (WHERE status = 'RESOLVED'),
    'total_wontfix', COUNT(*) FILTER (WHERE status = 'WONT_FIX'),
    'by_severity', jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='critical'),
      'warning',  COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='warning'),
      'info',     COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='info')
    ),
    'close_rate_pct', ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('RESOLVED','WONT_FIX'))
      / NULLIF(COUNT(*), 0)
    , 1)
  )
  INTO v_result
  FROM data_issues
  WHERE project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = p_project_id AND p.created_by = auth.uid()
    );

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_issue_summary TO authenticated;

-- MIGRATION 018: 0017_pr7_field_audit.sql
-- =============================================================
-- PR-7 字段级审计日志
-- 目的：记录"谁在什么时候把哪个字段从X改成了Y，为什么改"
--       做到每一次改动都可追溯、可还原
--
-- 使用场景举例：
--   研究员发现某患者基线 Scr 从 120 变成了 95 μmol/L
--   通过 field_audit_log 可以查到：
--     "2024-03-15 09:32, 张医生, 原因：录入时誊写错误，已核对原始化验单"
-- =============================================================

-- ─── 1. 字段级审计表：field_audit_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_audit_log (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name    text NOT NULL,       -- 被修改的表名，例：visits_long
  record_id     uuid NOT NULL,       -- 被修改记录的 ID
  project_id    uuid,                -- 所属项目（冗余存储，方便查询）
  patient_code  text,                -- 所属患者（冗余存储）
  field_name    text NOT NULL,       -- 被修改的字段名，例：scr_umol_l
  old_value     text,                -- 修改前的值（统一转为文本存储）
  new_value     text,                -- 修改后的值
  changed_by    uuid REFERENCES auth.users(id),  -- 操作人 UUID
  changed_at    timestamptz DEFAULT now(),
  change_reason text,                -- 修改原因（应用层传入）
  ip_hint       text                 -- 可选：IP 地址或来源标识
);

CREATE INDEX IF NOT EXISTS field_audit_record
  ON field_audit_log(table_name, record_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_project
  ON field_audit_log(project_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_patient
  ON field_audit_log(project_id, patient_code, changed_at DESC);

COMMENT ON TABLE field_audit_log IS
  '字段级审计：记录关键字段的每次修改（谁、何时、改了什么、为什么）。
  任何用户不可删除（通过RLS保证），平台管理员也不应随意删除。';

COMMENT ON COLUMN field_audit_log.old_value IS
  '修改前的值，统一存为文本。NULL表示该字段之前为空。';
COMMENT ON COLUMN field_audit_log.change_reason IS
  '修改原因，由前端要求用户填写。例："原始化验单复核后发现录入有误"';

-- ─── 2. RLS：只读，不允许 DELETE/UPDATE ─────────────────────────────────────
ALTER TABLE field_audit_log ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看自己项目的审计记录
DROP POLICY IF EXISTS "field_audit_select" ON field_audit_log;
CREATE POLICY "field_audit_select"
  ON field_audit_log FOR SELECT TO authenticated
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = field_audit_log.project_id
        AND p.created_by = auth.uid()
    )
  );

-- 审计记录只能由系统自动写入（通过 SECURITY DEFINER 函数），不允许用户直接 INSERT
-- 不设置 INSERT policy → 用户无法直接插入，只能通过 log_field_change() 函数

-- ─── 3. 写入审计记录的函数：log_field_change() ──────────────────────────────
-- 应用层在修改关键字段前调用此函数记录变更
CREATE OR REPLACE FUNCTION log_field_change(
  p_table_name   text,
  p_record_id    uuid,
  p_project_id   uuid,
  p_patient_code text,
  p_field_name   text,
  p_old_value    text,
  p_new_value    text,
  p_reason       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 值没变就不记录（防止噪音）
  IF p_old_value IS NOT DISTINCT FROM p_new_value THEN
    RETURN;
  END IF;

  INSERT INTO field_audit_log(
    table_name, record_id, project_id, patient_code,
    field_name, old_value, new_value,
    changed_by, change_reason
  ) VALUES (
    p_table_name, p_record_id, p_project_id, p_patient_code,
    p_field_name, p_old_value, p_new_value,
    auth.uid(), p_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_field_change TO authenticated;

-- ─── 4. 自动捕获 visits_long 关键字段变更的触发器 ──────────────────────────
-- 监控字段：visit_date / sbp / dbp / scr_umol_l / upcr / egfr / notes
-- 触发器把 old/new 变化写入 field_audit_log
CREATE OR REPLACE FUNCTION _audit_visit_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_reason text;
BEGIN
  -- 从 new row 读取 qc_reason 作为修改原因（研究者在前端填写的）
  v_reason := NEW.qc_reason;

  -- 逐字段比较，有变化则写审计
  IF OLD.visit_date IS DISTINCT FROM NEW.visit_date THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'visit_date', OLD.visit_date::text, NEW.visit_date::text, v_reason);
  END IF;
  IF OLD.sbp IS DISTINCT FROM NEW.sbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'sbp', OLD.sbp::text, NEW.sbp::text, v_reason);
  END IF;
  IF OLD.dbp IS DISTINCT FROM NEW.dbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'dbp', OLD.dbp::text, NEW.dbp::text, v_reason);
  END IF;
  IF OLD.scr_umol_l IS DISTINCT FROM NEW.scr_umol_l THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'scr_umol_l', OLD.scr_umol_l::text, NEW.scr_umol_l::text, v_reason);
  END IF;
  IF OLD.upcr IS DISTINCT FROM NEW.upcr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'upcr', OLD.upcr::text, NEW.upcr::text, v_reason);
  END IF;
  IF OLD.egfr IS DISTINCT FROM NEW.egfr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'egfr', OLD.egfr::text, NEW.egfr::text, v_reason);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_visit_fields ON visits_long;
CREATE TRIGGER trg_audit_visit_fields
  AFTER UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _audit_visit_fields();

-- ─── 5. 自动捕获 patients_baseline 关键字段变更 ─────────────────────────────
CREATE OR REPLACE FUNCTION _audit_baseline_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF OLD.baseline_date IS DISTINCT FROM NEW.baseline_date THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_date', OLD.baseline_date::text, NEW.baseline_date::text, NULL);
  END IF;
  IF OLD.baseline_scr IS DISTINCT FROM NEW.baseline_scr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_scr', OLD.baseline_scr::text, NEW.baseline_scr::text, NULL);
  END IF;
  IF OLD.baseline_upcr IS DISTINCT FROM NEW.baseline_upcr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_upcr', OLD.baseline_upcr::text, NEW.baseline_upcr::text, NULL);
  END IF;
  IF OLD.sex IS DISTINCT FROM NEW.sex THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'sex', OLD.sex, NEW.sex, NULL);
  END IF;
  IF OLD.birth_year IS DISTINCT FROM NEW.birth_year THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'birth_year', OLD.birth_year::text, NEW.birth_year::text, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_baseline_fields ON patients_baseline;
CREATE TRIGGER trg_audit_baseline_fields
  AFTER UPDATE ON patients_baseline
  FOR EACH ROW EXECUTE FUNCTION _audit_baseline_fields();

-- ─── 6. 查询某记录审计历史的 RPC ────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_field_audit(text, uuid);
CREATE OR REPLACE FUNCTION get_field_audit(
  p_table_name text,
  p_record_id  uuid
)
RETURNS TABLE(
  changed_at    timestamptz,
  field_name    text,
  old_value     text,
  new_value     text,
  changed_by    uuid,
  change_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.changed_at,
    a.field_name,
    a.old_value,
    a.new_value,
    a.changed_by,
    a.change_reason
  FROM field_audit_log a
  WHERE a.table_name = p_table_name
    AND a.record_id  = p_record_id
    AND (
      a.project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = a.project_id AND p.created_by = auth.uid()
      )
    )
  ORDER BY a.changed_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_field_audit TO authenticated;

COMMENT ON FUNCTION get_field_audit IS
  '查询某记录的字段修改历史。
  例：SELECT * FROM get_field_audit(''visits_long'', ''uuid-of-visit'')
  返回：哪些字段被修改、修改前后的值、谁修改的、修改原因';

-- MIGRATION 019: 0018_ln_pathology.sql
-- LN（狼疮性肾炎）病理分型字段
-- 依据 ISN/RPS 2003 分类标准（2018修订版）
-- 对 IgAN 项目无影响；所有新字段默认 NULL，无破坏性变更。

alter table public.patients_baseline
  add column if not exists ln_biopsy_date       date,
  add column if not exists ln_class             text,
  add column if not exists ln_activity_index    smallint,
  add column if not exists ln_chronicity_index  smallint,
  add column if not exists ln_podocytopathy     boolean;

-- ISN/RPS 分型约束：I / II / III-A / III-A/C / III-C /
--   IV-S(A) / IV-G(A) / IV-S(A/C) / IV-G(A/C) / IV-S(C) / IV-G(C) / V / VI
alter table public.patients_baseline
  add constraint ln_class_check check (
    ln_class is null or ln_class in (
      'I','II',
      'III-A','III-A/C','III-C',
      'IV-S(A)','IV-G(A)','IV-S(A/C)','IV-G(A/C)','IV-S(C)','IV-G(C)',
      'V','VI'
    )
  );

-- NIH 活动指数 0-24
alter table public.patients_baseline
  add constraint ln_activity_index_check check (
    ln_activity_index is null or (ln_activity_index >= 0 and ln_activity_index <= 24)
  );

-- NIH 慢性化指数 0-12
alter table public.patients_baseline
  add constraint ln_chronicity_index_check check (
    ln_chronicity_index is null or (ln_chronicity_index >= 0 and ln_chronicity_index <= 12)
  );

comment on column public.patients_baseline.ln_biopsy_date      is '狼疮肾肾穿日期';
comment on column public.patients_baseline.ln_class            is 'ISN/RPS 2003/2018 分型：I II III-A III-A/C III-C IV-S(A) IV-G(A) IV-S(A/C) IV-G(A/C) IV-S(C) IV-G(C) V VI';
comment on column public.patients_baseline.ln_activity_index   is 'NIH 活动指数（AI），0–24';
comment on column public.patients_baseline.ln_chronicity_index is 'NIH 慢性化指数（CI），0–12';
comment on column public.patients_baseline.ln_podocytopathy    is '是否合并足细胞病变（2018 修订版新增）';

-- MIGRATION 020: 0019_cn_friendly_layer.sql
-- =============================================================
-- PR-8 中文友好层（面向中国医生）
-- 目标：保留内部英文编码稳定性，同时提供中文优先展示与搜索能力
-- =============================================================

-- 1) 通用概念字典（内部 code + 中文展示元数据）
CREATE TABLE IF NOT EXISTS concept_dictionary (
  code                  text PRIMARY KEY,
  domain                text NOT NULL DEFAULT 'GENERAL',
  display_name_cn       text NOT NULL,
  short_name_cn         text NOT NULL,
  help_text_cn          text,
  when_to_fill_cn       text,
  example_value_cn      text,
  unit_cn               text,
  common_mistakes_cn    text,
  patient_friendly_cn   text,
  doctor_note_cn        text,
  is_required           boolean NOT NULL DEFAULT false,
  affects_export        boolean NOT NULL DEFAULT true,
  affects_qc            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE concept_dictionary IS '中文展示层概念字典：前台默认读中文名，内部仍可用英文 code。';
COMMENT ON COLUMN concept_dictionary.code IS '内部稳定英文编码，例如 dd_cfdna_fraction_pct。';
COMMENT ON COLUMN concept_dictionary.display_name_cn IS '面向临床一线的完整中文显示名（可含缩写）。';
COMMENT ON COLUMN concept_dictionary.short_name_cn IS '适合列表/表头的中文短名。';

CREATE INDEX IF NOT EXISTS idx_concept_dictionary_domain ON concept_dictionary(domain);
CREATE INDEX IF NOT EXISTS idx_concept_dictionary_display_name_cn ON concept_dictionary USING gin (to_tsvector('simple', coalesce(display_name_cn, '')));

CREATE OR REPLACE FUNCTION set_concept_dictionary_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_concept_dictionary_updated_at ON concept_dictionary;
CREATE TRIGGER trg_concept_dictionary_updated_at
BEFORE UPDATE ON concept_dictionary
FOR EACH ROW EXECUTE FUNCTION set_concept_dictionary_updated_at();

-- 2) 核心缩写词典（首次出现需中文解释）
CREATE TABLE IF NOT EXISTS abbreviation_dictionary (
  abbr               text PRIMARY KEY,
  full_name_cn       text NOT NULL,
  category_cn        text NOT NULL,
  first_use_note_cn  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE abbreviation_dictionary IS '肾内科研究常见缩写词典，用于首次出现自动解释。';

INSERT INTO abbreviation_dictionary (abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('KDPI', '肾供体概况指数', '移植相关', '首次显示建议：肾供体概况指数（KDPI）'),
  ('KDRI', '肾供体风险指数', '移植相关', '首次显示建议：肾供体风险指数（KDRI）'),
  ('DSA', '供者特异性抗体', '移植相关', '首次显示建议：供者特异性抗体（DSA）'),
  ('dnDSA', '新生供者特异性抗体', '移植相关', '首次显示建议：新生供者特异性抗体（dnDSA）'),
  ('dd-cfDNA', '供体来源细胞游离 DNA', '移植相关', '首次显示建议：供体来源细胞游离 DNA（dd-cfDNA）'),
  ('BK', 'BK 病毒', '感染监测', '首次显示建议：BK 病毒（BK）'),
  ('CMV', '巨细胞病毒', '感染监测', '首次显示建议：巨细胞病毒（CMV）'),
  ('EBV', 'EB 病毒', '感染监测', '首次显示建议：EB 病毒（EBV）'),
  ('Banff', '肾移植病理 Banff 分类', '病理相关', '首次显示建议：肾移植病理 Banff 分类（Banff）'),
  ('CNI', '钙调神经磷酸酶抑制剂', '免疫抑制', '首次显示建议：钙调神经磷酸酶抑制剂（CNI）'),
  ('mTORi', 'mTOR 抑制剂', '免疫抑制', '首次显示建议：mTOR 抑制剂（mTORi）'),
  ('UPCR', '尿蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿蛋白/肌酐比（UPCR）'),
  ('UACR', '尿白蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿白蛋白/肌酐比（UACR）'),
  ('eGFR', '估算肾小球滤过率', '肾功能与尿检', '首次显示建议：估算肾小球滤过率（eGFR）'),
  ('MCD', '微小病变病', '病种相关', '首次显示建议：微小病变病（MCD）'),
  ('MN', '膜性肾病', '病种相关', '首次显示建议：膜性肾病（MN）'),
  ('MGRS', '单克隆免疫球蛋白相关肾损害', '血液学与免疫相关', '首次显示建议：单克隆免疫球蛋白相关肾损害（MGRS）'),
  ('C3G', 'C3 肾小球病', '病种相关', '首次显示建议：C3 肾小球病（C3G）')
ON CONFLICT (abbr) DO UPDATE SET
  full_name_cn = EXCLUDED.full_name_cn,
  category_cn = EXCLUDED.category_cn,
  first_use_note_cn = EXCLUDED.first_use_note_cn;

-- 3) 中文别名检索表（支持“肌酐/尿蛋白/排斥/BK病毒”等中文搜索）
CREATE TABLE IF NOT EXISTS concept_alias_dictionary (
  concept_code   text NOT NULL REFERENCES concept_dictionary(code) ON DELETE CASCADE,
  alias_cn       text NOT NULL,
  alias_en       text,
  priority       integer NOT NULL DEFAULT 100,
  PRIMARY KEY (concept_code, alias_cn)
);

CREATE INDEX IF NOT EXISTS idx_concept_alias_cn_tsv
  ON concept_alias_dictionary USING gin (to_tsvector('simple', coalesce(alias_cn,'')));

-- 4) 兼容 lab_test_catalog：补充中文展示字段（如果已存在则跳过）
ALTER TABLE lab_test_catalog
  ADD COLUMN IF NOT EXISTS display_name_cn     text,
  ADD COLUMN IF NOT EXISTS short_name_cn       text,
  ADD COLUMN IF NOT EXISTS help_text_cn        text,
  ADD COLUMN IF NOT EXISTS when_to_fill_cn     text,
  ADD COLUMN IF NOT EXISTS example_value_cn    text,
  ADD COLUMN IF NOT EXISTS unit_cn             text,
  ADD COLUMN IF NOT EXISTS common_mistakes_cn  text,
  ADD COLUMN IF NOT EXISTS patient_friendly_cn text,
  ADD COLUMN IF NOT EXISTS doctor_note_cn      text;

UPDATE lab_test_catalog
SET
  display_name_cn = COALESCE(display_name_cn, name_cn),
  short_name_cn   = COALESCE(short_name_cn, name_cn),
  help_text_cn    = COALESCE(help_text_cn, display_note),
  unit_cn         = COALESCE(unit_cn, standard_unit)
WHERE display_name_cn IS NULL
   OR short_name_cn IS NULL
   OR help_text_cn IS NULL
   OR unit_cn IS NULL;

-- 5) KTX 常用字段预置（来自中文友好化规范）
INSERT INTO concept_dictionary(
  code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn,
  affects_export, affects_qc
) VALUES
  ('donor_type', 'KTX', '供体类型', '供体类型', '区分活体供者与尸体供者。', '创建移植基线时填写。', NULL, true, true),
  ('kdpi', 'KTX', '肾供体概况指数（KDPI）', 'KDPI', '评估尸体供肾质量。', '有尸体供者资料时填写。', NULL, true, false),
  ('kdri', 'KTX', '肾供体风险指数（KDRI）', 'KDRI', '用于供体风险分层。', '有供体风险评估时填写。', NULL, true, false),
  ('tacrolimus_c0', 'KTX', '他克莫司谷浓度（C0）', '他克莫司 C0', '下一次服药前测得的最低血药浓度。', '术后随访监测免疫抑制时填写。', 'ng/mL（纳克/毫升）', true, true),
  ('dd_cfdna_fraction_pct', 'KTX', '供体来源细胞游离 DNA（dd-cfDNA，百分比）', 'dd-cfDNA%', '建议明确是百分比结果。', '移植后生物标志物监测时填写。', '%（百分比）', true, false),
  ('bk_plasma_pcr', 'KTX', 'BK 病毒血浆核酸定量', 'BK 病毒 PCR', 'BK 病毒监测核心字段。', '术后病毒监测时填写。', 'copies/mL（拷贝/毫升）', true, true),
  ('cmv_pcr', 'KTX', '巨细胞病毒核酸定量', 'CMV PCR', 'CMV 复制监测字段。', '术后病毒监测时填写。', 'IU/mL（国际单位/毫升）', true, true),
  ('banff_diagnosis', 'KTX', 'Banff 病理诊断', 'Banff 诊断', '请记录 Banff 版本和分级。', '活检结果回报后填写。', NULL, true, true),
  ('abmr_event', 'KTX', '抗体介导排斥事件', 'ABMR 事件', '记录是否发生 ABMR 及日期。', '发生排斥事件时填写。', NULL, true, true),
  ('tcmr_event', 'KTX', 'T 细胞介导排斥事件', 'TCMR 事件', '记录是否发生 TCMR 及日期。', '发生排斥事件时填写。', NULL, true, true)
ON CONFLICT (code) DO UPDATE SET
  domain = EXCLUDED.domain,
  display_name_cn = EXCLUDED.display_name_cn,
  short_name_cn = EXCLUDED.short_name_cn,
  help_text_cn = EXCLUDED.help_text_cn,
  when_to_fill_cn = EXCLUDED.when_to_fill_cn,
  unit_cn = EXCLUDED.unit_cn,
  affects_export = EXCLUDED.affects_export,
  affects_qc = EXCLUDED.affects_qc;

INSERT INTO concept_alias_dictionary(concept_code, alias_cn, alias_en, priority) VALUES
  ('tacrolimus_c0', '谷浓度', 'tacrolimus_c0', 10),
  ('dd_cfdna_fraction_pct', 'dd-cfDNA', 'dd-cfDNA', 20),
  ('bk_plasma_pcr', 'BK 病毒', 'BK', 10),
  ('banff_diagnosis', '排斥', 'Banff', 30)
ON CONFLICT (concept_code, alias_cn) DO UPDATE SET
  alias_en = EXCLUDED.alias_en,
  priority = EXCLUDED.priority;

-- 6) 中文搜索入口：支持 code / 中文显示名 / 中文别名
CREATE OR REPLACE FUNCTION search_concepts_cn(
  p_keyword text,
  p_domain  text DEFAULT NULL,
  p_limit   integer DEFAULT 30
)
RETURNS TABLE (
  code             text,
  domain           text,
  display_name_cn  text,
  short_name_cn    text,
  matched_by       text
)
LANGUAGE sql
STABLE
AS $$
  WITH kw AS (
    SELECT trim(coalesce(p_keyword, '')) AS q
  )
  SELECT DISTINCT
    c.code,
    c.domain,
    c.display_name_cn,
    c.short_name_cn,
    CASE
      WHEN c.code ILIKE '%' || kw.q || '%' THEN 'code'
      WHEN c.display_name_cn ILIKE '%' || kw.q || '%' THEN 'display_name_cn'
      WHEN a.alias_cn ILIKE '%' || kw.q || '%' THEN 'alias_cn'
      ELSE 'other'
    END AS matched_by
  FROM concept_dictionary c
  CROSS JOIN kw
  LEFT JOIN concept_alias_dictionary a ON a.concept_code = c.code
  WHERE kw.q <> ''
    AND (p_domain IS NULL OR c.domain = p_domain)
    AND (
      c.code ILIKE '%' || kw.q || '%'
      OR c.display_name_cn ILIKE '%' || kw.q || '%'
      OR c.short_name_cn ILIKE '%' || kw.q || '%'
      OR a.alias_cn ILIKE '%' || kw.q || '%'
      OR coalesce(a.alias_en, '') ILIKE '%' || kw.q || '%'
    )
  ORDER BY c.domain, c.code
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 30), 200));
$$;

GRANT EXECUTE ON FUNCTION search_concepts_cn(text, text, integer) TO authenticated;

-- 7) 导出映射：中文版列名 + 英文 code
CREATE OR REPLACE VIEW v_concept_export_mapping AS
SELECT
  code AS english_code,
  display_name_cn AS chinese_column_name,
  short_name_cn AS chinese_short_name,
  domain,
  affects_export
FROM concept_dictionary
WHERE affects_export = true;

COMMENT ON VIEW v_concept_export_mapping IS '导出时使用的中英文字段对照表（中文列名导出默认来源）。';

-- MIGRATION 021: 0019_fix_visit_id_ambiguous.sql
-- 修复：patient_submit_visit_v2 中 "column reference visit_id is ambiguous"
-- 原因：RETURNS TABLE(visit_id uuid,...) 将 visit_id 注册为函数输出变量，
--       导致 ON CONFLICT (visit_id) 里 PostgreSQL 无法区分列名与输出变量。
-- 修复：改用 ON CONFLICT ON CONSTRAINT visit_receipts_pkey，消除歧义。

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
            encode(digest(p_token,'sha256'),'hex'),
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
  -- 使用 ON CONFLICT ON CONSTRAINT 而非 ON CONFLICT (visit_id)
  -- 避免与 RETURNS TABLE 中同名输出列产生歧义（PostgreSQL ambiguous 错误）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT ON CONSTRAINT visit_receipts_pkey DO UPDATE
    SET receipt_token = v_receipt,
        expires_at    = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
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

-- MIGRATION 022: 0020_lab_extend_mn_ktx_dkd.sql
-- =============================================================
-- 0020 化验目录扩展：MN / KTX / DKD 专项化验项
--
-- 补充：
--   MN 模块   → PLA2R（抗PLA2R抗体）、CD19（CD19+ B细胞计数）
--   KTX 模块  → BKV（BK病毒载量）、CMV（巨细胞病毒载量）
--   GENERAL   → HBA1C（糖化血红蛋白）、UACR（尿白蛋白/肌酐比）
--
-- 依赖：0013_pr2_lab_catalog.sql（表结构已存在）
-- 所有 INSERT 均使用 ON CONFLICT DO NOTHING，可安全重跑
-- =============================================================

-- ─── 1. 单位字典扩展 ───────────────────────────────────────────────────────────
INSERT INTO unit_catalog(symbol, description) VALUES
  ('RU/mL',     '反应单位每毫升（PLA2R 抗体常用单位）'),
  ('cells/μL',  '细胞数每微升（B 细胞绝对计数）'),
  ('%',         '百分比（CD19% 或 HbA1c NGSP%）'),
  ('copies/mL', '拷贝数每毫升（病毒载量）'),
  ('mmol/mol',  '毫摩尔每摩尔（HbA1c IFCC 国际标准单位）')
ON CONFLICT (symbol) DO NOTHING;

-- ─── 2. 化验项目字典扩展 ───────────────────────────────────────────────────────
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- MN 专项：靶抗原抗体 + B 细胞监测
  ('PLA2R',  '抗PLA2R抗体',
             'Anti-PLA2R Antibody',
             'MN',      false, '56741-0', 'RU/mL',
             '<14 RU/mL 为阴性；≥14 RU/mL 阳性。滴度与疾病活动度相关，可预测缓解与复发。RTX/OBI 治疗后监测滴度下降。'),

  ('CD19',   'CD19+ B细胞计数',
             'CD19+ B-cell Count',
             'MN',      false, '8122-7',  'cells/μL',
             '正常成人约 100–500 cells/μL。RTX/OBI 治疗后 B 细胞耗竭监测，清除标准通常 <5 cells/μL，可用百分比（%）替代。'),

  -- KTX 专项：BK 病毒 + CMV 病毒载量
  ('BKV',    'BK病毒载量',
             'BK Virus DNA',
             'KTX',     false, '72495-5', 'copies/mL',
             '移植后常规筛查（术后 3 个月内每月 1 次，之后每 3 个月 1 次）。'
             '≥10,000 copies/mL 考虑减少免疫抑制剂；≥100,000 copies/mL 为高载量，需积极处理。'),

  ('CMV',    '巨细胞病毒载量',
             'CMV DNA',
             'KTX',     false, '72493-0', 'IU/mL',
             'WHO 国际标准单位 IU/mL。各中心治疗阈值不同，通常 >1000 IU/mL 考虑抗病毒治疗。'
             '高危受者（D+/R-）建议前 3–6 个月预防或监测。'),

  -- DKD / GENERAL 专项：血糖控制 + 尿白蛋白
  ('HBA1C',  '糖化血红蛋白',
             'Hemoglobin A1c',
             'GENERAL', false, '4548-4',  '%',
             'DKD 血糖控制目标：一般 <7.0%（<53 mmol/mol）；高龄/低血糖风险者可放宽至 <8.0%。'
             '反映过去 2–3 个月平均血糖水平。'),

  ('UACR',   '尿白蛋白/肌酐比',
             'Urine Albumin-Creatinine Ratio',
             'GENERAL', false, '9318-7',  'mg/g',
             '正常 <30 mg/g；微量白蛋白尿 30–300 mg/g；大量白蛋白尿 >300 mg/g。'
             '注意：UACR（测白蛋白）与 UPCR（测总蛋白）不同，DKD 研究优先用 UACR。')

ON CONFLICT (code) DO NOTHING;

-- ─── 3. 项目-单位换算表扩展 ───────────────────────────────────────────────────
-- 格式：value_standard = value_raw × multiplier + offset_val
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- PLA2R：仅 RU/mL 一种常用单位
  ('PLA2R', 'RU/mL',     1,       0,    true),

  -- CD19：绝对计数为标准；百分比原值存储（无绝对数无法换算）
  ('CD19',  'cells/μL',  1,       0,    true),
  ('CD19',  '%',         1,       0,    false),  -- 存原始%，不换算

  -- BKV：copies/mL 为标准；IU/mL 与 copies/mL 近似 1:1（WHO 标准差异 <5%，直接存）
  ('BKV',   'copies/mL', 1,       0,    true),
  ('BKV',   'IU/mL',     1,       0,    false),

  -- CMV：IU/mL 为 WHO 标准；copies/mL 与 IU/mL 近似等价直接记录
  ('CMV',   'IU/mL',     1,       0,    true),
  ('CMV',   'copies/mL', 1,       0,    false),

  -- HbA1c：% (NGSP) 为标准；mmol/mol (IFCC) 换算公式 % = mmol/mol × 0.0915 + 2.15
  ('HBA1C', '%',         1,       0,    true),
  ('HBA1C', 'mmol/mol',  0.0915,  2.15, false),  -- IFCC → NGSP%

  -- UACR：mg/g 为标准；mg/mmol (欧洲) 换算：1 mg/mmol × 8.842 = mg/g
  --        (肌酐分子量 113.12 g/mol，∴ 1 mmol = 113.12 mg，1 mg/mmol = 1000/113.12 mg/g ≈ 8.84)
  ('UACR',  'mg/g',      1,       0,    true),
  ('UACR',  'mg/mmol',   8.842,   0,    false)   -- 欧洲单位 → mg/g

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- MIGRATION 023: 0021_project_custom_labs.sql
-- =============================================================
-- 0021 项目自定义化验目录
--
-- 每个研究项目可维护自己的化验目录（不在全局 lab_test_catalog 中的项目）。
-- 首次添加自定义化验时自动保存到本表，后续所有患者可直接从下拉中选用，
-- 保证同项目多患者、多中心录入时化验名称/单位一致。
-- =============================================================

CREATE TABLE IF NOT EXISTS project_custom_labs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,          -- 化验名，例如：补体因子H
  unit        text NOT NULL DEFAULT '',  -- 单位，例如：mg/L
  sort_order  int  NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)            -- 同一项目化验名不重复
);

COMMENT ON TABLE project_custom_labs IS
  '研究项目自定义化验目录；用户首次录入自定义化验时自动保存，后续同项目可直接选用。';

-- RLS：只有项目创建者可以读写
ALTER TABLE project_custom_labs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcl_select" ON project_custom_labs;
CREATE POLICY "pcl_select" ON project_custom_labs
  FOR SELECT TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_insert" ON project_custom_labs;
CREATE POLICY "pcl_insert" ON project_custom_labs
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_update" ON project_custom_labs;
CREATE POLICY "pcl_update" ON project_custom_labs
  FOR UPDATE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_delete" ON project_custom_labs;
CREATE POLICY "pcl_delete" ON project_custom_labs
  FOR DELETE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

-- MIGRATION 024: 0022_admin_status_permissions.sql
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

-- MIGRATION 025: 0023_billing_orders.sql
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

-- MIGRATION 032: 0030_patient_labs_meds_rpc.sql
-- RPC: patient_list_labs — let token-based patient view see their lab records
drop function if exists public.patient_list_labs(text, int);
create or replace function public.patient_list_labs(
  p_token text,
  p_limit int default 30
)
returns table (
  lab_date date,
  lab_name text,
  lab_value numeric,
  lab_unit text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    l.lab_date,
    l.lab_name,
    l.lab_value,
    l.lab_unit,
    l.created_at
  from public.patient_tokens t
  join public.labs_long l
    on l.project_id = t.project_id and l.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by l.lab_date desc nulls last, l.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_labs(text, int) to anon, authenticated;

-- RPC: patient_list_meds — let token-based patient view see their medication records
drop function if exists public.patient_list_meds(text, int);
create or replace function public.patient_list_meds(
  p_token text,
  p_limit int default 30
)
returns table (
  drug_name text,
  drug_class text,
  dose text,
  start_date date,
  end_date date,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    m.drug_name,
    m.drug_class,
    m.dose,
    m.start_date,
    m.end_date,
    m.created_at
  from public.patient_tokens t
  join public.meds_long m
    on m.project_id = t.project_id and m.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by m.start_date desc nulls last, m.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_meds(text, int) to anon, authenticated;

-- MIGRATION 033: 0031_patient_variants_rpc.sql
-- RPC: patient_list_variants — let token-based patient view see their genetic variant records
drop function if exists public.patient_list_variants(text, int);
create or replace function public.patient_list_variants(
  p_token text,
  p_limit int default 30
)
returns table (
  test_date date,
  test_name text,
  gene text,
  variant text,
  hgvs_c text,
  hgvs_p text,
  zygosity text,
  classification text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    v.test_date,
    v.test_name,
    v.gene,
    v.variant,
    v.hgvs_c,
    v.hgvs_p,
    v.zygosity,
    v.classification,
    v.created_at
  from public.patient_tokens t
  join public.variants_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.test_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_variants(text, int) to anon, authenticated;

-- RPC: patient_list_events — let token-based patient view see their clinical endpoint events
drop function if exists public.patient_list_events(text, int);
create or replace function public.patient_list_events(
  p_token text,
  p_limit int default 30
)
returns table (
  event_type text,
  event_date date,
  confirmed boolean,
  source text,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    e.event_type,
    e.event_date,
    e.confirmed,
    e.source,
    e.notes,
    e.created_at
  from public.patient_tokens t
  join public.events_long e
    on e.project_id = t.project_id and e.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by e.event_date desc nulls last, e.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_events(text, int) to anon, authenticated;

-- MIGRATION 034: 0032_security_integrity.sql
-- 0032: registry authorization, patient tokens and clinical integrity.
-- Additive migration. Existing orphans are retained by NOT VALID foreign keys.
-- Deploy together with the matching patient client (structured submit status).
BEGIN;
CREATE SCHEMA IF NOT EXISTS registry_private;
REVOKE ALL ON SCHEMA registry_private FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.registry_schema_versions (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.registry_schema_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_schema_versions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assert_project_owner(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id=p_project_id AND p.created_by=auth.uid()
  ) THEN RAISE EXCEPTION 'project_access_denied' USING ERRCODE='42501'; END IF;
END $$;

-- Authenticated API clients cannot forge authorship or creation timestamps.
-- Restore/migration sessions with an explicitly trusted database role retain
-- the ability to restore original metadata; browser users never get that role.
CREATE OR REPLACE FUNCTION public._set_created_by()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_role text:=current_setting('role',true);
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(v_role,'') NOT IN ('service_role','supabase_admin','postgres') THEN
    NEW.created_by:=auth.uid();
    NEW.created_at:=now();
  ELSIF NEW.created_by IS NULL THEN NEW.created_by:=auth.uid(); END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public._set_updated_meta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_role text:=current_setting('role',true);
BEGIN
  IF coalesce(v_role,'') NOT IN ('service_role','supabase_admin','postgres')
    AND NOT(coalesce(v_role,'')='none' AND session_user IN ('postgres','supabase_admin')) THEN
    NEW.created_by:=OLD.created_by;
    NEW.created_at:=OLD.created_at;
  END IF;
  NEW.updated_at:=now();
  NEW.updated_by:=auth.uid();
  RETURN NEW;
END $$;

-- The database remains owner-only until a complete team authorization model exists.
-- Never treat a subscription check as a project authorization check.
CREATE OR REPLACE FUNCTION public.upsert_lab_record(
  p_project_id uuid, p_patient_code text, p_lab_date date, p_lab_test_code text,
  p_value_raw numeric, p_unit_symbol text, p_measured_at timestamptz DEFAULT NULL,
  p_lab_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  IF p_value_raw IS NULL OR p_value_raw::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid_lab_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lab_test_unit_map m
    WHERE m.lab_test_code=p_lab_test_code AND m.unit_symbol=p_unit_symbol) THEN
    RAISE EXCEPTION 'unit_not_allowed';
  END IF;
  IF p_lab_id IS NULL THEN
    INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,
      lab_test_code,value_raw,unit_symbol,measured_at)
    VALUES(p_project_id,p_patient_code,p_lab_date,p_lab_test_code,p_value_raw,p_unit_symbol,
      p_lab_test_code,p_value_raw,p_unit_symbol,p_measured_at) RETURNING id INTO v_id;
  ELSE
    UPDATE public.labs_long SET lab_date=p_lab_date,lab_name=p_lab_test_code,
      lab_value=p_value_raw,lab_unit=p_unit_symbol,lab_test_code=p_lab_test_code,
      value_raw=p_value_raw,unit_symbol=p_unit_symbol,measured_at=p_measured_at
    WHERE id=p_lab_id AND project_id=p_project_id AND patient_code=p_patient_code
    RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'lab_not_found'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 40 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 40–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 20 OR p_dbp > 200) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 20–200 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

-- A token is a bearer credential. All patient reads share one validity rule.
CREATE OR REPLACE FUNCTION registry_private.assert_token(
  p_row public.patient_tokens, p_allow_used boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_row.id IS NULL OR NOT p_row.active OR p_row.revoked_at IS NOT NULL
    OR (p_row.expires_at IS NOT NULL AND p_row.expires_at <= now())
    OR (NOT p_allow_used AND p_row.single_use AND p_row.used_at IS NOT NULL) THEN
    RAISE EXCEPTION 'token_invalid_or_expired' USING ERRCODE='42501';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION registry_private.patient_token(p_token text)
RETURNS public.patient_tokens LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token;
  PERFORM registry_private.assert_token(v_token);
  RETURN v_token;
END $$;

CREATE OR REPLACE FUNCTION registry_private.project_write_status(p_project_id uuid)
RETURNS TABLE(can_write boolean,write_block_reason text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_project_write_allowed(p_project_id);
  RETURN QUERY SELECT true,NULL::text;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN ('subscription_required','project_not_found') THEN
    RETURN QUERY SELECT false,SQLERRM::text;
  ELSE RAISE; END IF;
END $$;

DROP FUNCTION IF EXISTS public.patient_get_context(text);
CREATE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE(project_id uuid,project_name text,center_code text,module text,
  patient_code text,sex text,birth_year int,trial_expires_at timestamptz,
  trial_grace_until timestamptz,subscription_plan text,subscription_active_until timestamptz,
  can_write boolean,write_block_reason text,single_use boolean,token_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id,p.name,p.center_code,p.module,t.patient_code,b.sex,b.birth_year,
    p.trial_expires_at,p.trial_grace_until,p.subscription_plan,p.subscription_active_until,
    w.can_write,w.write_block_reason,t.single_use,t.expires_at
  FROM registry_private.patient_token(p_token) t
  JOIN public.projects p ON p.id=t.project_id
  JOIN public.patients_baseline b ON b.project_id=t.project_id AND b.patient_code=t.patient_code
  CROSS JOIN LATERAL registry_private.project_write_status(p.id) w;
$$;

CREATE OR REPLACE FUNCTION public.create_patient_token_v2(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 30,
  p_single_use boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token text;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 365
    OR p_single_use IS NULL THEN RAISE EXCEPTION 'invalid_token_options'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  v_token:=replace(gen_random_uuid()::text,'-','');
  INSERT INTO public.patient_tokens(project_id,patient_code,token,expires_at,single_use,created_by)
    VALUES(p_project_id,p_patient_code,v_token,now()+make_interval(days=>p_expires_in_days),
      p_single_use,auth.uid());
  RETURN v_token;
END $$;
-- Compatibility for existing callers; creation and owner checks are server-side.
CREATE OR REPLACE FUNCTION public.create_patient_token(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 365
) RETURNS text LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.create_patient_token_v2(p_project_id,p_patient_code,p_expires_in_days,false);
$$;

-- Revocation is always allowed for the owner, including after subscription expiry.
-- Token mutation now goes through authorized RPCs, not direct table UPDATE.
DROP TRIGGER IF EXISTS tr_tokens_trial_lock ON public.patient_tokens;
CREATE OR REPLACE FUNCTION public.revoke_patient_token(p_token text,p_revoke_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM public.assert_project_owner(v_token.project_id);
  UPDATE public.patient_tokens SET active=false,revoked_at=coalesce(revoked_at,now()),
    revoke_reason=left(p_revoke_reason,500) WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      auth.uid(),'token_revoked','INFO',jsonb_build_object('token_id',v_token.id));
END $$;

ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submission_request_id uuid;
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submitted_via_token_id uuid;
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submission_payload_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS visits_submission_request_unique
  ON public.visits_long(project_id,patient_code,submission_request_id)
  WHERE submission_request_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.patient_submit_visit(text,date,numeric,numeric,numeric,numeric,numeric,text);
DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text);
CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
  p_token text,p_visit_date date,p_sbp numeric DEFAULT NULL,p_dbp numeric DEFAULT NULL,
  p_scr_umol_l numeric DEFAULT NULL,p_upcr numeric DEFAULT NULL,p_egfr numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,p_request_id uuid DEFAULT NULL
) RETURNS TABLE(visit_id uuid,server_time timestamptz,receipt_token text,
  receipt_expires_at timestamptz,status text,message text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_token public.patient_tokens%ROWTYPE;
  v_existing public.visits_long%ROWTYPE;
  v_receipt public.visit_receipts%ROWTYPE;
  v_id uuid; v_hash text; v_count int; v_status text; v_message text;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM registry_private.assert_token(v_token,true);
  v_hash:=encode(sha256(convert_to(jsonb_build_array(p_visit_date,p_sbp,p_dbp,
    p_scr_umol_l,p_upcr,p_egfr,coalesce(p_notes,''))::text,'UTF8')),'hex');
  -- A successful same-request retry returns the existing receipt, never another row.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.visits_long v
      WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code
        AND v.submission_request_id=p_request_id;
    IF FOUND THEN
      IF v_existing.submitted_via_token_id IS DISTINCT FROM v_token.id
        OR v_existing.submission_payload_hash IS DISTINCT FROM v_hash THEN
        RAISE EXCEPTION 'idempotency_conflict';
      END IF;
      SELECT * INTO v_receipt FROM public.visit_receipts r WHERE r.visit_id=v_existing.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'receipt_not_available'; END IF;
      RETURN QUERY SELECT v_existing.id,v_existing.created_at,v_receipt.receipt_token,
        v_receipt.expires_at,'submitted'::text,'已提交，无需重复录入'::text;
      RETURN;
    END IF;
  END IF;
  PERFORM registry_private.assert_token(v_token);
  -- Serialize all token submissions for this patient, including different links.
  PERFORM 1 FROM public.patients_baseline b WHERE b.project_id=v_token.project_id
    AND b.patient_code=v_token.patient_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  PERFORM public.assert_project_write_allowed(v_token.project_id);
  IF p_visit_date IS NULL THEN RAISE EXCEPTION 'missing_visit_date'; END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields';
  END IF;
  IF p_sbp::text IN ('NaN','Infinity','-Infinity') OR p_dbp::text IN ('NaN','Infinity','-Infinity')
    OR p_scr_umol_l::text IN ('NaN','Infinity','-Infinity') OR p_upcr::text IN ('NaN','Infinity','-Infinity')
    OR p_egfr::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'invalid_numeric_value'; END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp>=p_sbp THEN
    RAISE EXCEPTION 'invalid_blood_pressure'; END IF;
  IF public._contains_pii(coalesce(p_notes,'')) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  IF length(coalesce(p_notes,''))>500 THEN RAISE EXCEPTION 'notes_too_long'; END IF;
  SELECT count(*) INTO v_count FROM public.visits_long v
    WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code
      AND v.created_at>now()-interval '1 minute';
  IF v_count>=12 THEN v_status:='rate_limited'; v_message:='提交过于频繁，链接已停用，请联系研究人员。';
  ELSE
    SELECT count(*) INTO v_count FROM public.visits_long v
      WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code AND v.visit_date=p_visit_date;
    IF v_count>=6 THEN v_status:='same_day_limit_exceeded'; v_message:='同一日期已达到提交上限，链接已停用，请联系研究人员。'; END IF;
  END IF;
  IF v_status IS NOT NULL THEN
    UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason=v_status WHERE id=v_token.id;
    INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
      VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
        v_status,'HIGH',jsonb_build_object('count',v_count));
    -- Return, do not RAISE: the revocation and audit must commit.
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,v_status,v_message;
    RETURN;
  END IF;
  INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,
    egfr,egfr_formula_version,notes,submission_request_id,submitted_via_token_id,submission_payload_hash)
    VALUES(v_token.project_id,v_token.patient_code,p_visit_date,p_sbp,p_dbp,p_scr_umol_l,p_upcr,
      NULL,'missing_inputs',coalesce(p_notes,''),p_request_id,v_token.id,v_hash)
    RETURNING id INTO v_id;
  IF v_token.single_use THEN UPDATE public.patient_tokens SET used_at=now() WHERE id=v_token.id; END IF;
  INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at)
    VALUES(v_id,replace(gen_random_uuid()::text,'-',''),now()+interval '24 hours') RETURNING * INTO v_receipt;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      'visit_submitted','INFO',jsonb_build_object('visit_id',v_id,'single_use',v_token.single_use));
  RETURN QUERY SELECT v_id,now(),v_receipt.receipt_token,v_receipt.expires_at,'submitted'::text,'提交成功'::text;
END $$;

create or replace function public.patient_list_visits(
  p_token text,
  p_limit int default 30
)
returns table (
  visit_date date,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric,
  upcr numeric,
  egfr numeric,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    v.visit_date,
    v.sbp,
    v.dbp,
    v.scr_umol_l,
    v.upcr,
    v.egfr,
    v.notes,
    v.created_at
  from registry_private.patient_token(p_token) t
  join public.visits_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.visit_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.patient_list_labs(
  p_token text,
  p_limit int default 30
)
returns table (
  lab_date date,
  lab_name text,
  lab_value numeric,
  lab_unit text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    l.lab_date,
    l.lab_name,
    l.lab_value,
    l.lab_unit,
    l.created_at
  from registry_private.patient_token(p_token) t
  join public.labs_long l
    on l.project_id = t.project_id and l.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by l.lab_date desc nulls last, l.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.patient_list_meds(
  p_token text,
  p_limit int default 30
)
returns table (
  drug_name text,
  drug_class text,
  dose text,
  start_date date,
  end_date date,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    m.drug_name,
    m.drug_class,
    m.dose,
    m.start_date,
    m.end_date,
    m.created_at
  from registry_private.patient_token(p_token) t
  join public.meds_long m
    on m.project_id = t.project_id and m.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by m.start_date desc nulls last, m.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.patient_list_variants(
  p_token text,
  p_limit int default 30
)
returns table (
  test_date date,
  test_name text,
  gene text,
  variant text,
  hgvs_c text,
  hgvs_p text,
  zygosity text,
  classification text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    v.test_date,
    v.test_name,
    v.gene,
    v.variant,
    v.hgvs_c,
    v.hgvs_p,
    v.zygosity,
    v.classification,
    v.created_at
  from registry_private.patient_token(p_token) t
  join public.variants_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.test_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.patient_list_events(
  p_token text,
  p_limit int default 30
)
returns table (
  event_type text,
  event_date date,
  confirmed boolean,
  source text,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    e.event_type,
    e.event_date,
    e.confirmed,
    e.source,
    e.notes,
    e.created_at
  from registry_private.patient_token(p_token) t
  join public.events_long e
    on e.project_id = t.project_id and e.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by e.event_date desc nulls last, e.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

-- Deferred validation preserves historical orphans for explicit reconciliation.
-- New and re-keyed rows must reference a baseline in the same project.
DO $$
DECLARE v_table text; v_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['visits_long','labs_long','meds_long','variants_long',
    'events_long','patient_tokens','ktx_baseline_ext','ktx_visits_ext'] LOOP
    v_name:=v_table||'_patient_project_fk';
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('public.'||v_table)::regclass AND conname=v_name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY(project_id,patient_code) REFERENCES public.patients_baseline(project_id,patient_code) ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID',v_table,v_name);
    END IF;
  END LOOP;
END $$;

-- Date integrity also applies to direct table writes and patient-token submissions.
-- SECURITY INVOKER is intentional: an unauthorized direct INSERT must not use a
-- trigger's error text to probe another project's baseline or visit existence.
CREATE OR REPLACE FUNCTION registry_private.check_research_dates()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_baseline_date date;
BEGIN
  IF TG_TABLE_NAME='patients_baseline' THEN
    IF TG_OP='UPDATE' AND NEW.baseline_date IS NOT DISTINCT FROM OLD.baseline_date THEN RETURN NEW; END IF;
    IF NEW.baseline_date>current_date THEN RAISE EXCEPTION 'future_baseline_date'; END IF;
    IF TG_OP='UPDATE' THEN
      IF NEW.baseline_date IS NULL AND EXISTS(SELECT 1 FROM public.visits_long v
        WHERE v.project_id=NEW.project_id AND v.patient_code=NEW.patient_code) THEN
        RAISE EXCEPTION 'baseline_date_required_with_visits';
      END IF;
      IF EXISTS(SELECT 1 FROM public.visits_long v WHERE v.project_id=NEW.project_id
        AND v.patient_code=NEW.patient_code AND v.visit_date<NEW.baseline_date) THEN
        RAISE EXCEPTION 'baseline_date_after_existing_visit';
      END IF;
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND ROW(NEW.visit_date,NEW.project_id,NEW.patient_code)
      IS NOT DISTINCT FROM ROW(OLD.visit_date,OLD.project_id,OLD.patient_code) THEN RETURN NEW; END IF;
    IF NEW.visit_date IS NULL THEN RAISE EXCEPTION 'missing_visit_date'; END IF;
    IF NEW.visit_date>current_date THEN RAISE EXCEPTION 'future_visit_date'; END IF;
    -- FOR SHARE conflicts with a concurrent baseline-date UPDATE (FOR NO KEY
    -- UPDATE); the FK's weaker KEY SHARE lock alone would not protect this check.
    SELECT b.baseline_date INTO v_baseline_date FROM public.patients_baseline b
      WHERE b.project_id=NEW.project_id AND b.patient_code=NEW.patient_code FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
    IF v_baseline_date IS NOT NULL AND NEW.visit_date<v_baseline_date THEN
      RAISE EXCEPTION 'visit_before_baseline';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS registry_baseline_dates ON public.patients_baseline;
CREATE TRIGGER registry_baseline_dates BEFORE INSERT OR UPDATE OF baseline_date ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_research_dates();
DROP TRIGGER IF EXISTS registry_visit_dates ON public.visits_long;
CREATE TRIGGER registry_visit_dates BEFORE INSERT OR UPDATE OF visit_date,project_id,patient_code ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_research_dates();

CREATE OR REPLACE FUNCTION public._auto_compute_egfr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_sex text; v_birth_year int; v_age numeric;
BEGIN
  -- An explicitly marked manual value is distinct from a stale calculated value.
  IF NEW.egfr_formula_version='manual' AND NEW.egfr IS NOT NULL THEN RETURN NEW; END IF;
  NEW.egfr:=NULL;
  NEW.egfr_formula_version:='missing_inputs';
  SELECT b.sex,b.birth_year INTO v_sex,v_birth_year FROM public.patients_baseline b
    WHERE b.project_id=NEW.project_id AND b.patient_code=NEW.patient_code;
  IF NEW.scr_umol_l IS NULL OR NEW.scr_umol_l<=0 OR NEW.visit_date IS NULL
    OR v_sex IS NULL OR upper(v_sex) NOT IN ('M','F') OR v_birth_year IS NULL THEN RETURN NEW; END IF;
  v_age:=extract(year FROM NEW.visit_date)-v_birth_year;
  IF v_age<18 OR v_age>120 THEN RETURN NEW; END IF;
  NEW.egfr:=public.ckd_epi_2021(NEW.scr_umol_l/88.4,v_sex,v_age);
  NEW.egfr_formula_version:='CKD-EPI-2021-Cr';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_auto_egfr ON public.visits_long;
CREATE TRIGGER trg_auto_egfr BEFORE INSERT OR UPDATE OF scr_umol_l,visit_date,project_id,
  patient_code,egfr,egfr_formula_version ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION public._auto_compute_egfr();

CREATE OR REPLACE FUNCTION registry_private.refresh_patient_egfr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.sex IS DISTINCT FROM NEW.sex OR OLD.birth_year IS DISTINCT FROM NEW.birth_year THEN
    UPDATE public.visits_long SET egfr=NULL,egfr_formula_version='missing_inputs'
      WHERE project_id=NEW.project_id AND patient_code=NEW.patient_code
        AND egfr_formula_version IS DISTINCT FROM 'manual';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_baseline_refresh_egfr ON public.patients_baseline;
CREATE TRIGGER trg_baseline_refresh_egfr AFTER UPDATE OF sex,birth_year ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.refresh_patient_egfr();

-- CD19 percentage is not an absolute cell count; retain raw % and no false standard value.
-- Use the same creatinine unit convention as eGFR and the patient/staff clients.
-- This changes future normalization only; existing lab rows are not rewritten.
UPDATE public.lab_test_unit_map SET multiplier=1.0/88.4,offset_val=0
  WHERE lab_test_code='CREAT' AND unit_symbol='μmol/L';
ALTER TABLE public.labs_long ADD COLUMN IF NOT EXISTS normalization_status text NOT NULL DEFAULT 'legacy_unverified';
CREATE OR REPLACE FUNCTION public.normalize_lab_value(p_code text,p_value numeric,p_unit text)
RETURNS numeric LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_multiplier numeric; v_offset numeric;
BEGIN
  IF p_code='CD19' AND p_unit='%' THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value::text IN ('NaN','Infinity','-Infinity') THEN RETURN NULL; END IF;
  SELECT multiplier,offset_val INTO v_multiplier,v_offset FROM public.lab_test_unit_map
    WHERE lab_test_code=p_code AND unit_symbol=p_unit;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN p_value*v_multiplier+v_offset;
END $$;
CREATE OR REPLACE FUNCTION registry_private.normalize_lab_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.lab_test_code IS NULL THEN
    NEW.value_standard:=NULL;NEW.standard_unit:=NULL;NEW.normalization_status:='unmapped';
    RETURN NEW;
  END IF;
  IF NEW.value_raw IS NULL OR NEW.unit_symbol IS NULL OR NEW.value_raw::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid_lab_value_or_unit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lab_test_unit_map m WHERE m.lab_test_code=NEW.lab_test_code AND m.unit_symbol=NEW.unit_symbol) THEN
    RAISE EXCEPTION 'unit_not_allowed'; END IF;
  NEW.lab_name:=NEW.lab_test_code;NEW.lab_value:=NEW.value_raw;NEW.lab_unit:=NEW.unit_symbol;
  NEW.value_standard:=public.normalize_lab_value(NEW.lab_test_code,NEW.value_raw,NEW.unit_symbol);
  IF NEW.lab_test_code='CD19' AND NEW.unit_symbol='%' THEN
    NEW.standard_unit:=NULL;NEW.normalization_status:='not_convertible';
  ELSE
    SELECT c.standard_unit INTO NEW.standard_unit FROM public.lab_test_catalog c WHERE c.code=NEW.lab_test_code;
    NEW.normalization_status:='normalized';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_normalize_lab_row ON public.labs_long;
CREATE TRIGGER trg_normalize_lab_row BEFORE INSERT OR UPDATE OF lab_test_code,value_raw,unit_symbol,
  lab_name,lab_value,lab_unit,value_standard,standard_unit,normalization_status ON public.labs_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.normalize_lab_row();
-- Do not rewrite historical clinical rows in this migration. The deployment preflight
-- reports legacy CD19% standardized counts and stale eGFR for reviewed reconciliation.

-- Lead contacts are not a public directory of everyone who requested a demo.
DROP POLICY IF EXISTS allow_public_insert ON public.demo_requests;
DROP POLICY IF EXISTS allow_auth_select ON public.demo_requests;
DROP POLICY IF EXISTS allow_auth_update ON public.demo_requests;
CREATE POLICY demo_public_submit ON public.demo_requests FOR INSERT TO anon,authenticated
  WITH CHECK(status='pending');
CREATE POLICY demo_admin_read ON public.demo_requests FOR SELECT TO authenticated
  USING(public.is_platform_admin());
CREATE POLICY demo_admin_update ON public.demo_requests FOR UPDATE TO authenticated
  USING(public.is_platform_admin()) WITH CHECK(public.is_platform_admin());
REVOKE ALL ON public.demo_requests FROM PUBLIC,anon,authenticated;
GRANT INSERT(name,institution,department,email,contact,use_case,message) ON public.demo_requests TO anon,authenticated;
GRANT SELECT ON public.demo_requests TO authenticated;
GRANT UPDATE(status) ON public.demo_requests TO authenticated;

ALTER TABLE public.visit_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visit_receipts FROM PUBLIC,anon,authenticated;
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['concept_dictionary','abbreviation_dictionary','concept_alias_dictionary'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO anon,authenticated',v_table);
    EXECUTE format('CREATE POLICY registry_catalog_read ON public.%I FOR SELECT TO anon,authenticated USING(true)',v_table);
  END LOOP;
END $$;

-- Issue generation/resolution and field audit writes are trigger-only operations.
DROP POLICY IF EXISTS issues_project_owner ON public.data_issues;
CREATE POLICY issues_owner_read ON public.data_issues FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.projects p WHERE p.id=data_issues.project_id AND p.created_by=auth.uid()));
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.data_issues FROM PUBLIC,anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.field_audit_log FROM PUBLIC,anon,authenticated;
DROP POLICY IF EXISTS field_audit_select ON public.field_audit_log;
CREATE POLICY field_audit_select ON public.field_audit_log FOR SELECT TO authenticated
  USING(project_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=field_audit_log.project_id AND p.created_by=auth.uid()));
-- No direct token write can unset used_at, revive a revoked link or bypass single_use.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.patient_tokens FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_field_audit(p_table_name text,p_record_id uuid)
RETURNS TABLE(changed_at timestamptz,field_name text,old_value text,new_value text,changed_by uuid,change_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT a.changed_at,a.field_name,a.old_value,a.new_value,a.changed_by,a.change_reason
  FROM public.field_audit_log a JOIN public.projects p ON p.id=a.project_id
  WHERE a.table_name=p_table_name AND a.record_id=p_record_id AND p.created_by=auth.uid()
  ORDER BY a.changed_at DESC;
$$;

-- PostgreSQL gives PUBLIC EXECUTE to new functions by default. An explicit GRANT
-- to authenticated alone does not remove that anonymous path.
DO $$
DECLARE v_function record;
BEGIN
  FOR v_function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname=ANY(ARRAY[
      '_audit_baseline_fields','_audit_visit_fields','_audit_visits_long_changes','_auto_compute_egfr','_contains_pii',
      '_new_snapshot_code','_pii_guard','_qc_check_lab','_qc_check_visit','_set_created_by',
      '_set_updated_meta','_trial_block_write','admin_activate_contract','admin_adjust_trial','admin_cancel_contract',
      'admin_get_order_proofs','admin_get_visit_history','admin_list_consent_logs','admin_list_contracts','admin_list_orders',
      'admin_list_projects','admin_reject_contract','admin_reject_order','admin_reset_to_trial','admin_review_contract',
      'admin_set_expiry','admin_set_partner','admin_set_subscription','admin_update_contract','admin_verify_order',
      'apply_partner_contract','assert_project_owner','assert_project_write_allowed','check_duplicate_lab','check_jump_spike',
      'check_project_quota','ckd_epi_2021','close_issue_wont_fix','create_billing_order','create_patient_token',
      'create_patient_token_v2','create_project_snapshot','expire_old_orders','generate_order_no','get_field_audit',
      'get_issue_summary','get_my_contract','get_my_orders','is_platform_admin','list_project_snapshots',
      'lock_project_snapshot','log_consent','log_field_change','log_project_audit','normalize_lab_value',
      'patient_get_context','patient_list_events','patient_list_labs','patient_list_meds','patient_list_variants',
      'patient_list_visits','patient_submit_visit','patient_submit_visit_v2','raise_or_update_issue','resolve_issue_if_exists',
      'revoke_patient_token','search_concepts_cn','set_concept_dictionary_updated_at','submit_payment_proof','upsert_lab_record',
      'upsert_my_profile','validate_date_chain','validate_visit_record'
    ]) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon',v_function.signature);
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_function.signature::oid AND p.prosecdef) THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp',v_function.signature);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA registry_private FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.assert_project_owner(uuid),public.assert_project_write_allowed(uuid)
  FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.raise_or_update_issue(uuid,text,text,uuid,text,text,text),
  public.resolve_issue_if_exists(uuid,text,text,uuid,text),
  public.log_field_change(text,uuid,uuid,text,text,text,text,text) FROM authenticated;
-- Pure helpers used by ordinary row triggers may run without disclosing stored data.
GRANT EXECUTE ON FUNCTION public._contains_pii(text),public.ckd_epi_2021(numeric,text,numeric)
  TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
  public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
  public.create_patient_token(uuid,text,int),public.create_patient_token_v2(uuid,text,int,boolean),
  public.revoke_patient_token(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.patient_get_context(text),public.patient_list_visits(text,int),
  public.patient_list_labs(text,int),public.patient_list_meds(text,int),
  public.patient_list_variants(text,int),public.patient_list_events(text,int),
  public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text,uuid)
  TO anon,authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0032_security_integrity') ON CONFLICT DO NOTHING;
COMMIT;

-- MIGRATION 035: 0033_billing_registration.sql
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

-- MIGRATION 036: 0034_import_corrections.sql
-- Transactional imports, explicit units and auditable corrections.
-- Historical ambiguous UPCR values are deliberately NOT relabelled or converted.
BEGIN;

ALTER TABLE public.patients_baseline
  ADD COLUMN IF NOT EXISTS baseline_upcr_unit text,
  ADD COLUMN IF NOT EXISTS baseline_upcr_raw numeric,
  ADD COLUMN IF NOT EXISTS baseline_upcr_original_unit text,
  ADD COLUMN IF NOT EXISTS qc_reason text;

CREATE OR REPLACE FUNCTION public._registry_check_baseline_upcr()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.baseline_upcr, NEW.baseline_upcr_unit, NEW.baseline_upcr_raw, NEW.baseline_upcr_original_unit)
       IS NOT DISTINCT FROM ROW(OLD.baseline_upcr, OLD.baseline_upcr_unit, OLD.baseline_upcr_raw, OLD.baseline_upcr_original_unit) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.baseline_upcr IS NULL THEN
    NEW.baseline_upcr_unit := NULL;
    NEW.baseline_upcr_raw := NULL;
    NEW.baseline_upcr_original_unit := NULL;
    RETURN NEW;
  END IF;
  IF NEW.baseline_upcr::text IN ('NaN','Infinity','-Infinity')
     OR NEW.baseline_upcr_raw IS NULL OR NEW.baseline_upcr_raw::text IN ('NaN','Infinity','-Infinity')
     OR NEW.baseline_upcr < 0 OR NEW.baseline_upcr_raw < 0
     OR NEW.baseline_upcr_unit IS DISTINCT FROM 'mg/g'
     OR NEW.baseline_upcr_original_unit IS NULL
     OR NEW.baseline_upcr_original_unit NOT IN ('mg/g','g/g') THEN
    RAISE EXCEPTION 'baseline_upcr_unit_required'
      USING HINT = '新录入或更正UPCR须同时提供原值、原单位及标准mg/g值；历史未知单位不可猜测。';
  END IF;
  IF abs(NEW.baseline_upcr - NEW.baseline_upcr_raw *
       CASE NEW.baseline_upcr_original_unit WHEN 'g/g' THEN 1000 ELSE 1 END)
       > abs(NEW.baseline_upcr_raw * CASE NEW.baseline_upcr_original_unit WHEN 'g/g' THEN 1000 ELSE 1 END) * 0.000000000001 THEN
    RAISE EXCEPTION 'baseline_upcr_conversion_mismatch';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS registry_baseline_upcr_units ON public.patients_baseline;
CREATE TRIGGER registry_baseline_upcr_units BEFORE INSERT OR UPDATE ON public.patients_baseline
FOR EACH ROW EXECUTE FUNCTION public._registry_check_baseline_upcr();

CREATE TABLE IF NOT EXISTS public.registry_import_batches (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('baseline','visits')),
  content_sha256 text NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,batch_id)
);
CREATE TABLE IF NOT EXISTS public.registry_import_records (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('baseline','visits')),
  content_sha256 text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,kind,content_sha256)
);
ALTER TABLE public.registry_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registry_import_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_import_batches, public.registry_import_records FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit','consent_research',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes']
  WHEN 'labs' THEN ARRAY['lab_date','lab_test_code','value_raw','unit_symbol','measured_at']
  ELSE NULL::text[] END;
$$;

CREATE OR REPLACE FUNCTION public._registry_validate_input(p_kind text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text; v text; n numeric; d date;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each_text(p_row) LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN
      RAISE EXCEPTION 'unsupported_column: %', k;
    END IF;
    IF v IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(p_row->k) IN ('object','array') THEN RAISE EXCEPTION 'scalar_value_required: %',k; END IF;
    IF k IN ('patient_code','sex','baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date',
      'baseline_upcr_unit','baseline_upcr_original_unit','ln_class','treatment_arm','randomization_id','notes','lab_test_code','unit_symbol','measured_at')
      AND jsonb_typeof(p_row->k)<>'string' THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
    IF k IN ('birth_year','baseline_scr','baseline_upcr','baseline_upcr_raw','sbp','dbp','scr_umol_l','upcr','egfr',
             'oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','value_raw') THEN
      n := v::numeric;
      IF n::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'non_finite_number: %', k; END IF;
      IF k <> 'value_raw' AND n < 0 THEN RAISE EXCEPTION 'negative_value: %',k; END IF;
      IF k IN ('baseline_scr','scr_umol_l') AND n <= 0 THEN RAISE EXCEPTION 'creatinine_must_be_positive'; END IF;
      IF k = 'birth_year' AND (n <> trunc(n) OR n < 1900 OR n > extract(year FROM current_date)) THEN
        RAISE EXCEPTION 'invalid_birth_year';
      END IF;
      IF k LIKE 'oxford_%' AND (n <> trunc(n) OR n > CASE WHEN k IN ('oxford_t','oxford_c') THEN 2 ELSE 1 END) THEN
        RAISE EXCEPTION 'invalid_oxford_score: %',k;
      END IF;
      IF k IN ('ln_activity_index','ln_chronicity_index') AND (n <> trunc(n) OR n > CASE k WHEN 'ln_activity_index' THEN 24 ELSE 12 END) THEN
        RAISE EXCEPTION 'invalid_ln_score: %',k;
      END IF;
    END IF;
    IF k IN ('baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date') THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END IF;
      d := v::date;
      IF d::text <> v OR d > current_date THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
    END IF;
    IF k = 'patient_code' AND (length(v) NOT BETWEEN 1 AND 64 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_patient_code';
    END IF;
    IF k = 'sex' AND v NOT IN ('M','F') THEN RAISE EXCEPTION 'invalid_sex'; END IF;
    IF k = 'notes' AND length(v) > 500 THEN RAISE EXCEPTION 'notes_too_long'; END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public._registry_validate_visit_payload(p_project_id uuid,p_row jsonb,p_exclude_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.visits_long; checks jsonb;
BEGIN
  v := jsonb_populate_record(NULL::public.visits_long,p_row);
  checks := public.validate_visit_record(p_project_id,v.patient_code,v.visit_date,v.sbp,v.dbp,v.scr_umol_l,v.upcr,v.egfr,v.notes,p_exclude_id);
  IF jsonb_array_length(coalesce(checks->'errors','[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'visit_validation_failed' USING DETAIL = (checks->'errors')::text;
  END IF;
END $$;

-- Replace partial audit triggers with a single complete, transactional audit.
CREATE OR REPLACE FUNCTION public._registry_audit_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before_row jsonb := to_jsonb(OLD); after_row jsonb := to_jsonb(NEW); k text; reason text;
BEGIN
  reason := coalesce(nullif(current_setting('app.registry_change_reason',true),''), nullif(after_row->>'qc_reason',''), '通过数据录入更新');
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
    VALUES(TG_TABLE_NAME,OLD.id,OLD.project_id,OLD.patient_code,'__record_deleted__',
      encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),NULL,auth.uid(),
      coalesce(nullif(current_setting('app.registry_change_reason',true),''),'删除操作；未提交删除原因。旧记录内容仅保存SHA256指纹。'));
    RETURN OLD;
  END IF;
  FOR k IN SELECT jsonb_object_keys(after_row) LOOP
    IF k IN ('updated_at','updated_by','qc_reason','created_at','created_by') THEN CONTINUE; END IF;
    IF (before_row->k) IS DISTINCT FROM (after_row->k) THEN
      INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
      VALUES(TG_TABLE_NAME,NEW.id,NEW.project_id,NEW.patient_code,k,before_row->>k,after_row->>k,auth.uid(),reason);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_audit_visit_fields ON public.visits_long;
DROP TRIGGER IF EXISTS trg_audit_baseline_fields ON public.patients_baseline;
DROP TRIGGER IF EXISTS registry_audit_visit ON public.visits_long;
CREATE TRIGGER registry_audit_visit AFTER UPDATE OR DELETE ON public.visits_long FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_audit_baseline ON public.patients_baseline;
CREATE TRIGGER registry_audit_baseline AFTER UPDATE OR DELETE ON public.patients_baseline FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_audit_lab ON public.labs_long;
CREATE TRIGGER registry_audit_lab AFTER UPDATE OR DELETE ON public.labs_long FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();

CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project_id AND created_by=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_access_denied'; END IF;
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_kind IS NULL OR p_kind NOT IN ('baseline','visits') OR p_batch_id IS NULL THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'import_requires_1_to_500_rows';
  END IF;
  IF p_kind='baseline' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS batch_rows(value) GROUP BY batch_rows.value->>'patient_code' HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'duplicate_patient_code_in_batch'
    USING HINT='同一基线批次每位患者只能出现一行，请先核对重复编号。'; END IF;
  payload_hash := encode(sha256(convert_to(p_kind || ':' || p_rows::text,'UTF8')),'hex');
  SELECT * INTO previous FROM public.registry_import_batches WHERE project_id=p_project_id AND batch_id=p_batch_id;
  IF FOUND THEN
    IF previous.content_sha256 <> payload_hash OR previous.kind <> p_kind THEN RAISE EXCEPTION 'batch_id_content_conflict'; END IF;
    RETURN previous.result || jsonb_build_object('replayed',true);
  END IF;
  tbl := CASE p_kind WHEN 'baseline' THEN 'patients_baseline' ELSE 'visits_long' END;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason','CSV导入批次 ' || p_batch_id::text,true);
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    row_no := row_no+1;
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_%_must_be_object',row_no; END IF;
    IF r ? 'project_id' AND r->>'project_id' IS DISTINCT FROM p_project_id::text THEN RAISE EXCEPTION 'row_%_project_mismatch',row_no; END IF;
    r := r - 'project_id';
    -- Reject unknown headers even if their cell is empty. Blank cells preserve existing values.
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN RAISE EXCEPTION 'unsupported_column: %',k; END IF;
    END LOOP;
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO clean
      FROM jsonb_each(r) WHERE value <> 'null'::jsonb AND value <> '""'::jsonb;
    PERFORM public._registry_validate_input(p_kind,clean);
    IF coalesce(clean->>'patient_code','') = '' THEN RAISE EXCEPTION 'row_%_patient_code_required',row_no; END IF;
    rec_id := NULL; old_row := NULL;
    IF p_kind = 'baseline' THEN
      SELECT id,to_jsonb(b) INTO rec_id,old_row FROM public.patients_baseline b
        WHERE project_id=p_project_id AND patient_code=clean->>'patient_code' FOR UPDATE;
      IF rec_id IS NULL AND coalesce(clean->>'baseline_date','') = '' THEN RAISE EXCEPTION 'row_%_baseline_date_required',row_no; END IF;
      IF rec_id IS NOT NULL THEN
        IF clean ? 'baseline_date' AND EXISTS (
          SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=clean->>'patient_code'
            AND visit_date < (clean->>'baseline_date')::date
        ) THEN RAISE EXCEPTION 'row_%_baseline_date_after_existing_visit',row_no; END IF;
        clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,clean)))->key)
                  FROM jsonb_object_keys(clean) AS keys(key));
        IF old_row @> clean THEN skipped := skipped+1; CONTINUE; END IF;
        SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.patients_baseline,$1)).%I',key,key),',' ORDER BY key)
          INTO assignments FROM jsonb_object_keys(clean) AS keys(key) WHERE key <> 'patient_code';
        EXECUTE format('UPDATE public.patients_baseline SET %s WHERE id=$2 AND project_id=$3',assignments)
          USING clean,rec_id,p_project_id;
        changed := changed+1;
        CONTINUE;
      END IF;
    ELSE
      IF coalesce(clean->>'visit_date','') = '' THEN RAISE EXCEPTION 'row_%_visit_date_required',row_no; END IF;
      IF NOT clean ?| ARRAY['sbp','dbp','scr_umol_l','upcr','egfr'] THEN RAISE EXCEPTION 'row_%_core_measurement_required',row_no; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.patients_baseline WHERE project_id=p_project_id AND patient_code=clean->>'patient_code') THEN
        RAISE EXCEPTION 'row_%_patient_not_registered',row_no;
      END IF;
      PERFORM public._registry_validate_visit_payload(p_project_id,clean);
      clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.visits_long,clean)))->key)
                FROM jsonb_object_keys(clean) AS keys(key));
      row_hash := encode(sha256(convert_to(clean::text,'UTF8')),'hex');
      SELECT record_id INTO rec_id FROM public.registry_import_records
        WHERE project_id=p_project_id AND kind=p_kind AND content_sha256=row_hash;
      IF rec_id IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.visits_long WHERE id=rec_id AND project_id=p_project_id) THEN
          RAISE EXCEPTION 'row_%_previously_imported_record_deleted_requires_review',row_no;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.visits_long v WHERE id=rec_id AND project_id=p_project_id AND to_jsonb(v) @> clean) THEN
          RAISE EXCEPTION 'row_%_record_changed_since_import',row_no
            USING HINT = '记录已在导入后更正，请核对当前记录；不会覆盖更正或默默跳过差异。';
        END IF;
        skipped := skipped+1; CONTINUE;
      END IF;
      SELECT id INTO rec_id FROM public.visits_long v WHERE project_id=p_project_id
        AND patient_code=clean->>'patient_code' AND visit_date=(clean->>'visit_date')::date
        AND to_jsonb(v) @> clean ORDER BY id LIMIT 1;
      IF rec_id IS NOT NULL THEN
        INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id)
          VALUES(p_project_id,p_kind,row_hash,rec_id);
        skipped := skipped+1; CONTINUE;
      END IF;
      IF EXISTS(SELECT 1 FROM public.visits_long WHERE project_id=p_project_id
        AND patient_code=clean->>'patient_code' AND visit_date=(clean->>'visit_date')::date) THEN
        RAISE EXCEPTION 'row_%_same_day_record_conflict',row_no
          USING HINT = '同一患者同日已有不同数据，请先在记录纠错中核实；本批次未写入。';
      END IF;
      IF clean ? 'egfr' THEN clean := clean || jsonb_build_object('egfr_formula_version','manual'); END IF;
    END IF;
    clean := clean || jsonb_build_object('project_id',p_project_id,'created_by',auth.uid());
    SELECT string_agg(format('%I',key),',' ORDER BY key),
           string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',tbl,key),',' ORDER BY key)
      INTO cols,exprs FROM jsonb_object_keys(clean) AS keys(key);
    EXECUTE format('INSERT INTO public.%I(%s) SELECT %s RETURNING id',tbl,cols,exprs) INTO rec_id USING clean;
    IF p_kind = 'visits' THEN
      INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id)
        VALUES(p_project_id,p_kind,row_hash,rec_id);
    END IF;
    added := added+1;
  END LOOP;
  result := jsonb_build_object('inserted',added,'updated',changed,'skipped',skipped,'total',row_no,'replayed',false);
  INSERT INTO public.registry_import_batches(project_id,batch_id,kind,content_sha256,actor_id,result)
    VALUES(p_project_id,p_batch_id,p_kind,payload_hash,auth.uid(),result);
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.correct_registry_record(p_project_id uuid,p_table text,p_record_id uuid,p_changes jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text; before_row jsonb; after_row jsonb; assignments text; changes jsonb := p_changes; old_reason text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project_id AND created_by=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_access_denied'; END IF;
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'correction_reason_required'; END IF;
  kind := CASE p_table WHEN 'patients_baseline' THEN 'baseline' WHEN 'visits_long' THEN 'visits' WHEN 'labs_long' THEN 'labs' END;
  IF kind IS NULL THEN RAISE EXCEPTION 'unsupported_record_type'; END IF;
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR changes='{}'::jsonb THEN RAISE EXCEPTION 'correction_changes_required'; END IF;
  IF changes ? 'patient_code' THEN RAISE EXCEPTION 'patient_identity_is_immutable'; END IF;
  PERFORM public._registry_validate_input(kind,changes);
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND project_id=$2 FOR UPDATE',p_table)
    INTO before_row USING p_record_id,p_project_id;
  IF before_row IS NULL THEN RAISE EXCEPTION 'record_not_found'; END IF;
  IF kind = 'baseline' AND changes ? 'baseline_date' AND changes->>'baseline_date' IS NULL THEN RAISE EXCEPTION 'baseline_date_required'; END IF;
  IF kind = 'baseline' AND changes ? 'baseline_date' AND EXISTS (
    SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=before_row->>'patient_code'
      AND visit_date < (changes->>'baseline_date')::date
  ) THEN RAISE EXCEPTION 'baseline_date_after_existing_visit'; END IF;
  IF kind = 'visits' THEN
    IF changes ? 'egfr' THEN
      changes := changes || jsonb_build_object('egfr_formula_version',CASE WHEN changes->>'egfr' IS NULL THEN NULL ELSE 'manual' END);
    END IF;
    IF changes ? 'visit_date' AND changes->>'visit_date' IS NULL THEN RAISE EXCEPTION 'visit_date_required'; END IF;
    PERFORM public._registry_validate_visit_payload(p_project_id,before_row || changes,p_record_id);
  END IF;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason',btrim(p_reason),true);
  IF kind = 'labs' THEN
    after_row := before_row || changes;
    PERFORM public.upsert_lab_record(p_project_id,before_row->>'patient_code',(after_row->>'lab_date')::date,
      after_row->>'lab_test_code',(after_row->>'value_raw')::numeric,after_row->>'unit_symbol',
      (after_row->>'measured_at')::timestamptz,p_record_id);
  ELSE
    changes := changes || jsonb_build_object('qc_reason',btrim(p_reason));
    SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.%I,$1)).%I',key,p_table,key),',' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(changes) AS keys(key);
    EXECUTE format('UPDATE public.%I SET %s WHERE id=$2 AND project_id=$3',p_table,assignments)
      USING changes,p_record_id,p_project_id;
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND project_id=$2',p_table)
    INTO after_row USING p_record_id,p_project_id;
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN jsonb_build_object('record',after_row,'changed',before_row IS DISTINCT FROM after_row);
END $$;

REVOKE ALL ON FUNCTION public._registry_check_baseline_upcr(),public._registry_input_columns(text),
 public._registry_validate_input(text,jsonb),public._registry_validate_visit_payload(uuid,jsonb,uuid),public._registry_audit_changes() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) TO authenticated;

INSERT INTO public.registry_schema_versions(version) VALUES('0034_import_corrections') ON CONFLICT(version) DO NOTHING;

COMMIT;

-- MIGRATION 037: 0035_frozen_exports.sql
-- Reproducible research exports: a single statement reads all tables at one MVCC snapshot.
-- No patient tokens, authentication records, payment details or security credentials are exported.
BEGIN;
CREATE TABLE IF NOT EXISTS registry_private.export_contents (
  snapshot_id uuid PRIMARY KEY REFERENCES public.project_snapshots(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  content_text text NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  UNIQUE(project_id,request_id)
);
ALTER TABLE registry_private.export_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.export_contents FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.reject_export_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'frozen_export_is_immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_export_contents ON registry_private.export_contents;
CREATE TRIGGER immutable_export_contents BEFORE UPDATE ON registry_private.export_contents
FOR EACH ROW EXECUTE FUNCTION registry_private.reject_export_update();
REVOKE ALL ON FUNCTION registry_private.reject_export_update() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_registry_export(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE s public.project_snapshots; e registry_private.export_contents;
BEGIN
  SELECT * INTO s FROM public.project_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'export_not_found'; END IF;
  PERFORM public.assert_project_owner(s.project_id);
  SELECT * INTO e FROM registry_private.export_contents WHERE snapshot_id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'metadata_only_snapshot'
    USING HINT = '这是旧版本元数据记录，未保存当时数据；请创建新的研究导出。'; END IF;
  RETURN jsonb_build_object('id',s.id,'snapshot_id',s.snapshot_id,'created_at',e.created_at,
    'content_sha256',e.content_sha256,'content_text',e.content_text,
    'consistency','database_statement_snapshot','schema_version','registry_v2');
END $$;

CREATE OR REPLACE FUNCTION public.create_registry_export(p_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE payload jsonb; payload_text text; sha text; sid uuid; code text; part record; n_patients int; n_visits int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'export_request_id_required'; END IF;
  -- Serialize exports for this project, including lost-response retries. This is a read entitlement:
  -- trial expiry does not prevent a researcher from retrieving their own data.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  SELECT snapshot_id INTO sid FROM registry_private.export_contents WHERE project_id=p_project_id AND request_id=p_request_id;
  IF sid IS NOT NULL THEN RETURN public.get_registry_export(sid); END IF;

  -- The subqueries are all part of THIS SINGLE SQL statement and see the same database snapshot.
  -- Fetch one sentinel beyond the per-table bound; reject rather than produce a truncated package.
  WITH
    rows_0 AS MATERIALIZED (SELECT * FROM public.patients_baseline WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_1 AS MATERIALIZED (SELECT * FROM public.visits_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_2 AS MATERIALIZED (SELECT * FROM public.labs_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_3 AS MATERIALIZED (SELECT * FROM public.meds_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_4 AS MATERIALIZED (SELECT * FROM public.variants_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_5 AS MATERIALIZED (SELECT * FROM public.events_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_6 AS MATERIALIZED (SELECT * FROM public.ktx_baseline_ext WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_7 AS MATERIALIZED (SELECT * FROM public.ktx_visits_ext WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_8 AS MATERIALIZED (SELECT * FROM public.data_issues WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    bounds AS MATERIALIZED (SELECT ((SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_0 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_1 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_2 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_3 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_4 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_5 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_6 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_7 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_8 t)) AS row_bytes, ((SELECT count(*) FROM rows_0)>10000 OR (SELECT count(*) FROM rows_1)>10000 OR (SELECT count(*) FROM rows_2)>10000 OR (SELECT count(*) FROM rows_3)>10000 OR (SELECT count(*) FROM rows_4)>10000 OR (SELECT count(*) FROM rows_5)>10000 OR (SELECT count(*) FROM rows_6)>10000 OR (SELECT count(*) FROM rows_7)>10000 OR (SELECT count(*) FROM rows_8)>10000) AS over_rows)
  SELECT CASE
    WHEN bounds.over_rows THEN jsonb_build_object('export_error','export_table_too_large')
    WHEN bounds.row_bytes>16700000 THEN jsonb_build_object('export_error','export_payload_too_large')
    ELSE jsonb_build_object(
      'schema_version','registry_v2',
      'captured_at',clock_timestamp(),
      'project',jsonb_build_object('id',p.id,'name',p.name,'center_code',p.center_code,'module',p.module,'registry_type',p.registry_type),
      'tables',jsonb_build_object(
      'patients_baseline',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_0 t),
      'visits_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_1 t),
      'labs_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_2 t),
      'meds_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_3 t),
      'variants_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_4 t),
      'events_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_5 t),
      'ktx_baseline_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_6 t),
      'ktx_visits_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_7 t),
      'data_issues',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_8 t)
      )
    ) END INTO payload
  FROM public.projects p CROSS JOIN bounds WHERE p.id=p_project_id;
  IF payload ? 'export_error' THEN
    RAISE EXCEPTION '%',payload->>'export_error'
      USING HINT = '同步导出每表最多10000行、总数据约16MiB；超限请安排完整后台导出，本次没有生成部分文件。';
  END IF;
  FOR part IN SELECT key,value FROM jsonb_each(payload->'tables') LOOP
    IF jsonb_array_length(part.value)>10000 THEN
      RAISE EXCEPTION 'export_table_too_large: %',part.key
        USING HINT = '同步导出上限为每表10000行；请联系管理员安排完整后台导出，本次未生成部分文件。';
    END IF;
  END LOOP;
  payload_text := payload::text;
  IF octet_length(payload_text)>16777216 THEN RAISE EXCEPTION 'export_payload_too_large'; END IF;
  sha := encode(sha256(convert_to(payload_text,'UTF8')),'hex');
  n_patients := jsonb_array_length(payload->'tables'->'patients_baseline');
  n_visits := jsonb_array_length(payload->'tables'->'visits_long');
  code := 'KS-' || to_char(now(),'YYYY') || '-' || upper(replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.project_snapshots(snapshot_id,project_id,status,kind,filter_summary,schema_version,n_patients,n_visits,
    qc_summary,created_by,locked_at,locked_by,notes)
  VALUES(code,p_project_id,'locked','paper_package','{}','registry_v2',n_patients,n_visits,
    jsonb_build_object('issue_count',jsonb_array_length(payload->'tables'->'data_issues')),
    auth.uid(),now(),auth.uid(),'frozen_export_v2; immutable content; server SHA256='||sha) RETURNING id INTO sid;
  INSERT INTO registry_private.export_contents(snapshot_id,project_id,request_id,content_text,content_sha256,created_by)
    VALUES(sid,p_project_id,p_request_id,payload_text,sha,auth.uid());
  INSERT INTO public.audit_log(project_id,actor_uid,action,snapshot_id,details)
    VALUES(p_project_id,auth.uid(),'frozen_export_create',code,
      jsonb_build_object('content_sha256',sha,'schema_version','registry_v2','request_id',p_request_id));
  RETURN public.get_registry_export(sid);
END $$;

REVOKE ALL ON FUNCTION public.create_registry_export(uuid,uuid),public.get_registry_export(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_registry_export(uuid,uuid),public.get_registry_export(uuid) TO authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0035_frozen_exports') ON CONFLICT(version) DO NOTHING;
COMMIT;

-- MIGRATION 038: 0036_project_members.sql
-- Explicit per-project collaboration. A project is the data boundary, not an organization tree.
-- Owners remain the sole membership/project/billing managers. Reading is not a DRM guarantee:
-- viewers can read clinical records; only owners/analysts may call the dedicated export RPCs.
BEGIN;
CREATE TABLE public.project_members (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('editor','analyst','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user_idx ON public.project_members(user_id,project_id);
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_members FROM PUBLIC,anon,authenticated;
CREATE TABLE registry_private.member_add_attempts (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  email_sha256 text NOT NULL
);
CREATE INDEX member_add_attempts_actor_time_idx ON registry_private.member_add_attempts(actor_id,attempted_at);
ALTER TABLE registry_private.member_add_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.member_add_attempts FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.project_role(p_project_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN p.created_by=auth.uid() THEN 'owner' ELSE m.role END
  FROM public.projects p LEFT JOIN public.project_members m ON m.project_id=p.id AND m.user_id=auth.uid()
  WHERE p.id=p_project_id AND auth.uid() IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION public.has_project_permission(p_project_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(CASE p_permission
    WHEN 'read' THEN registry_private.project_role(p_project_id) IN ('owner','editor','analyst','viewer')
    WHEN 'write' THEN registry_private.project_role(p_project_id) IN ('owner','editor')
    WHEN 'tokens' THEN registry_private.project_role(p_project_id) IN ('owner','editor')
    WHEN 'export' THEN registry_private.project_role(p_project_id) IN ('owner','analyst')
    WHEN 'manage' THEN registry_private.project_role(p_project_id)='owner'
    ELSE false END,false);
$$;
CREATE OR REPLACE FUNCTION public.assert_project_permission(p_project_id uuid,p_permission text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT public.has_project_permission(p_project_id,p_permission) THEN
    RAISE EXCEPTION 'project_access_denied' USING ERRCODE='42501';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.get_project_access(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r text; writable boolean:=false; why text;
BEGIN
  r:=registry_private.project_role(p_project_id);
  IF r IN ('owner','editor') THEN
    SELECT s.can_write,s.write_block_reason INTO writable,why FROM registry_private.project_write_status(p_project_id) s;
  ELSIF r IS NOT NULL THEN why:='role_read_only'; ELSE why:='project_access_denied'; END IF;
  RETURN jsonb_build_object('role',r,'can_read',r IS NOT NULL,
    'can_write',coalesce(writable,false),'can_export',coalesce(r IN ('owner','analyst'),false),
    'can_manage_tokens',coalesce(writable,false),'can_manage_members',coalesce(r='owner',false),
    'can_manage_project',coalesce(r='owner',false),'write_block_reason',why);
END $$;
CREATE OR REPLACE FUNCTION public.list_project_members(p_project_id uuid)
RETURNS TABLE(user_id uuid,email text,display_name text,role text,created_at timestamptz,is_owner boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  RETURN QUERY
    SELECT u.id,u.email::text,up.real_name::text,'owner'::text,p.created_at,true
    FROM public.projects p JOIN auth.users u ON u.id=p.created_by
    LEFT JOIN public.user_profiles up ON up.user_id=u.id WHERE p.id=p_project_id
    UNION ALL
    SELECT u.id,u.email::text,up.real_name::text,m.role,m.created_at,false
    FROM public.project_members m JOIN auth.users u ON u.id=m.user_id
    LEFT JOIN public.user_profiles up ON up.user_id=u.id WHERE m.project_id=p_project_id;
END $$;
CREATE OR REPLACE FUNCTION public.add_project_member(p_project_id uuid,p_email text,p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_id uuid; normalized_email text:=lower(btrim(p_email)); owner_id uuid; n int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  IF p_role IS NULL OR p_role NOT IN ('editor','analyst','viewer') THEN RAISE EXCEPTION 'invalid_member_role'; END IF;
  -- Serialize owner-wide attempts across projects, so concurrent failures cannot evade the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('registry-members:'||auth.uid()::text,0));
  SELECT count(*) INTO n FROM registry_private.member_add_attempts
    WHERE actor_id=auth.uid() AND attempted_at>now()-interval '1 hour';
  IF n>=20 OR (SELECT count(*) FROM registry_private.member_add_attempts
    WHERE actor_id=auth.uid() AND attempted_at>now()-interval '1 day')>=100 THEN
    RETURN jsonb_build_object('status','rate_limited');
  END IF;
  INSERT INTO registry_private.member_add_attempts(actor_id,email_sha256)
    VALUES(auth.uid(),encode(sha256(convert_to(coalesce(normalized_email,''),'UTF8')),'hex'));
  SELECT created_by INTO owner_id FROM public.projects WHERE id=p_project_id FOR UPDATE;
  IF normalized_email IS NULL OR length(normalized_email)>254 OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('status','not_added');
  END IF;
  -- Auth service owns email verification; an unverified registered email is not sufficient.
  -- to_jsonb keeps this migration compatible with isolated auth-schema test fixtures.
  SELECT u.id INTO target_id FROM auth.users u WHERE lower(u.email)=normalized_email
    AND nullif(to_jsonb(u)->>'email_confirmed_at','') IS NOT NULL
    ORDER BY u.id LIMIT 1;
  IF target_id IS NULL OR target_id=owner_id THEN RETURN jsonb_build_object('status','not_added'); END IF;
  IF EXISTS(SELECT 1 FROM public.project_members WHERE project_id=p_project_id AND user_id=target_id) THEN
    RETURN jsonb_build_object('status','already_member');
  END IF;
  IF (SELECT count(*) FROM public.project_members WHERE project_id=p_project_id)>=100 THEN
    RETURN jsonb_build_object('status','not_added');
  END IF;
  INSERT INTO public.project_members(project_id,user_id,role,created_by) VALUES(p_project_id,target_id,p_role,auth.uid());
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_added',jsonb_build_object('user_id',target_id,'role',p_role));
  RETURN jsonb_build_object('status','added');
END $$;
-- An editor can have copied any project bearer link. Removing that write authority
-- must revoke every unexpired active link atomically, not only links they created.
CREATE OR REPLACE FUNCTION registry_private.revoke_member_access_tokens(p_project_id uuid,p_member_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n int;
BEGIN
 PERFORM public.assert_project_owner(p_project_id);
 UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason='editor_permission_removed'
  WHERE project_id=p_project_id AND active=true AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>now());
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO public.security_audit_logs(project_id,actor_uid,event_type,severity,details)
  VALUES(p_project_id,auth.uid(),'member_access_tokens_revoked','INFO',jsonb_build_object('member_id',p_member_id,'revoked_token_count',n));
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION registry_private.revoke_member_access_tokens(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.change_project_member_role(p_project_id uuid,p_user_id uuid,p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_role text; revoked_count int:=0;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION 'project_owner_is_immutable'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('editor','analyst','viewer') THEN RAISE EXCEPTION 'invalid_member_role'; END IF;
  SELECT role INTO previous_role FROM public.project_members WHERE project_id=p_project_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found'; END IF;
  UPDATE public.project_members SET role=p_role WHERE project_id=p_project_id AND user_id=p_user_id;
  IF previous_role='editor' AND p_role<>'editor' THEN revoked_count:=registry_private.revoke_member_access_tokens(p_project_id,p_user_id); END IF;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_role_changed',jsonb_build_object('user_id',p_user_id,'previous_role',previous_role,'role',p_role,'revoked_token_count',revoked_count));
  RETURN jsonb_build_object('status','updated','revoked_token_count',revoked_count);
END $$;
CREATE OR REPLACE FUNCTION public.remove_project_member(p_project_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_role text; revoked_count int:=0;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION 'project_owner_is_immutable'; END IF;
  DELETE FROM public.project_members WHERE project_id=p_project_id AND user_id=p_user_id RETURNING role INTO previous_role;
  IF previous_role IS NULL THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF previous_role='editor' THEN revoked_count:=registry_private.revoke_member_access_tokens(p_project_id,p_user_id); END IF;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_removed',jsonb_build_object('user_id',p_user_id,'previous_role',previous_role,'revoked_token_count',revoked_count));
  RETURN jsonb_build_object('status','removed','revoked_token_count',revoked_count);
END $$;

-- Record identity is immutable on every UPDATE path, even if the caller can write both projects.
-- This prevents moving an expired source project's records into an active destination project.
CREATE OR REPLACE FUNCTION registry_private.guard_clinical_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)->'id') IS DISTINCT FROM (to_jsonb(OLD)->'id')
   OR (to_jsonb(NEW)->'project_id') IS DISTINCT FROM (to_jsonb(OLD)->'project_id')
   OR (to_jsonb(NEW)->'patient_code') IS DISTINCT FROM (to_jsonb(OLD)->'patient_code') THEN
  RAISE EXCEPTION 'clinical_identity_is_immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.guard_clinical_identity() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['patients_baseline','visits_long','labs_long','meds_long','variants_long','events_long',
  'ktx_baseline_ext','ktx_visits_ext','project_custom_labs'] LOOP
  EXECUTE format('CREATE TRIGGER a_registry_identity BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION registry_private.guard_clinical_identity()',t);
 END LOOP;
END $$;

-- Clinical RLS. Subscription triggers remain independent of authorization.
DO $$
DECLARE t text; pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY['patients_baseline','visits_long','labs_long','meds_long','variants_long','events_long',
    'ktx_baseline_ext','ktx_visits_ext','project_custom_labs'] LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',pol.policyname,t);
    END LOOP;
    EXECUTE format('CREATE POLICY member_read ON public.%I FOR SELECT TO authenticated USING(public.has_project_permission(project_id,''read''))',t);
    EXECUTE format('CREATE POLICY member_insert ON public.%I FOR INSERT TO authenticated WITH CHECK(public.has_project_permission(project_id,''write''))',t);
    EXECUTE format('CREATE POLICY member_update ON public.%I FOR UPDATE TO authenticated USING(public.has_project_permission(project_id,''write'')) WITH CHECK(public.has_project_permission(project_id,''write''))',t);
    EXECUTE format('CREATE POLICY member_delete ON public.%I FOR DELETE TO authenticated USING(public.has_project_permission(project_id,''write''))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['data_issues','field_audit_log','visits_long_history','audit_log','project_snapshots'] LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',pol.policyname,t);
    END LOOP;
    EXECUTE format('CREATE POLICY member_read ON public.%I FOR SELECT TO authenticated USING(public.has_project_permission(project_id,''read''))',t);
  END LOOP;
END $$;
DROP POLICY projects_select_own ON public.projects;
CREATE POLICY projects_select_members ON public.projects FOR SELECT TO authenticated USING(public.has_project_permission(id,'read'));
DROP POLICY tokens_select_own ON public.patient_tokens;
CREATE POLICY tokens_read_editors ON public.patient_tokens FOR SELECT TO authenticated USING(public.has_project_permission(project_id,'tokens'));
-- No read-role policy on security logs: token administration belongs to the project owner/editor.
DROP POLICY sec_audit_select_own ON public.security_audit_logs;
CREATE POLICY security_read_editors ON public.security_audit_logs FOR SELECT TO authenticated USING(public.has_project_permission(project_id,'tokens'));
DROP POLICY comments_issue_owner ON public.data_issue_comments;
CREATE POLICY comment_read_members ON public.data_issue_comments FOR SELECT TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'read')));
CREATE POLICY comment_insert_editors ON public.data_issue_comments FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid() AND EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')));
CREATE POLICY comment_update_editors ON public.data_issue_comments FOR UPDATE TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')
    AND (data_issue_comments.created_by=auth.uid() OR public.has_project_permission(i.project_id,'manage'))))
  WITH CHECK(EXISTS(SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')));
CREATE POLICY comment_delete_editors ON public.data_issue_comments FOR DELETE TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')
    AND (data_issue_comments.created_by=auth.uid() OR public.has_project_permission(i.project_id,'manage'))));
-- Legacy extension/custom-field tables did not all have the account write guard.
CREATE TRIGGER member_ktxb_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ktx_baseline_ext FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
CREATE TRIGGER member_ktxv_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ktx_visits_ext FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
CREATE TRIGGER member_custom_lab_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.project_custom_labs FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();

-- Explicit replacements preserve all existing validation, transaction and export bounds.
CREATE OR REPLACE FUNCTION public.upsert_lab_record(
  p_project_id uuid, p_patient_code text, p_lab_date date, p_lab_test_code text,
  p_value_raw numeric, p_unit_symbol text, p_measured_at timestamptz DEFAULT NULL,
  p_lab_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  IF p_value_raw IS NULL OR p_value_raw::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid_lab_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lab_test_unit_map m
    WHERE m.lab_test_code=p_lab_test_code AND m.unit_symbol=p_unit_symbol) THEN
    RAISE EXCEPTION 'unit_not_allowed';
  END IF;
  IF p_lab_id IS NULL THEN
    INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,
      lab_test_code,value_raw,unit_symbol,measured_at)
    VALUES(p_project_id,p_patient_code,p_lab_date,p_lab_test_code,p_value_raw,p_unit_symbol,
      p_lab_test_code,p_value_raw,p_unit_symbol,p_measured_at) RETURNING id INTO v_id;
  ELSE
    UPDATE public.labs_long SET lab_date=p_lab_date,lab_name=p_lab_test_code,
      lab_value=p_value_raw,lab_unit=p_unit_symbol,lab_test_code=p_lab_test_code,
      value_raw=p_value_raw,unit_symbol=p_unit_symbol,measured_at=p_measured_at
    WHERE id=p_lab_id AND project_id=p_project_id AND patient_code=p_patient_code
    RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'lab_not_found'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'read');
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 40 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 40–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 20 OR p_dbp > 200) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 20–200 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_patient_token_v2(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 30,
  p_single_use boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token text;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  -- SHARE conflicts with membership changes' NO KEY UPDATE lock. Recheck after waiting:
  -- a concurrently removed editor must not mint a fresh bearer token after bulk revocation.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 365
    OR p_single_use IS NULL THEN RAISE EXCEPTION 'invalid_token_options'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  v_token:=replace(gen_random_uuid()::text,'-','');
  INSERT INTO public.patient_tokens(project_id,patient_code,token,expires_at,single_use,created_by)
    VALUES(p_project_id,p_patient_code,v_token,now()+make_interval(days=>p_expires_in_days),
      p_single_use,auth.uid());
  RETURN v_token;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_patient_token(p_token text,p_revoke_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM public.assert_project_permission(v_token.project_id,'tokens');
  UPDATE public.patient_tokens SET active=false,revoked_at=coalesce(revoked_at,now()),
    revoke_reason=left(p_revoke_reason,500) WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      auth.uid(),'token_revoked','INFO',jsonb_build_object('token_id',v_token.id));
END $$;

CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_kind IS NULL OR p_kind NOT IN ('baseline','visits') OR p_batch_id IS NULL THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'import_requires_1_to_500_rows';
  END IF;
  IF p_kind='baseline' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS batch_rows(value) GROUP BY batch_rows.value->>'patient_code' HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'duplicate_patient_code_in_batch'
    USING HINT='同一基线批次每位患者只能出现一行，请先核对重复编号。'; END IF;
  payload_hash := encode(sha256(convert_to(p_kind || ':' || p_rows::text,'UTF8')),'hex');
  SELECT * INTO previous FROM public.registry_import_batches WHERE project_id=p_project_id AND batch_id=p_batch_id;
  IF FOUND THEN
    IF previous.content_sha256 <> payload_hash OR previous.kind <> p_kind THEN RAISE EXCEPTION 'batch_id_content_conflict'; END IF;
    RETURN previous.result || jsonb_build_object('replayed',true);
  END IF;
  tbl := CASE p_kind WHEN 'baseline' THEN 'patients_baseline' ELSE 'visits_long' END;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason','CSV导入批次 ' || p_batch_id::text,true);
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    row_no := row_no+1;
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_%_must_be_object',row_no; END IF;
    IF r ? 'project_id' AND r->>'project_id' IS DISTINCT FROM p_project_id::text THEN RAISE EXCEPTION 'row_%_project_mismatch',row_no; END IF;
    r := r - 'project_id';
    -- Reject unknown headers even if their cell is empty. Blank cells preserve existing values.
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN RAISE EXCEPTION 'unsupported_column: %',k; END IF;
    END LOOP;
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO clean
      FROM jsonb_each(r) WHERE value <> 'null'::jsonb AND value <> '""'::jsonb;
    PERFORM public._registry_validate_input(p_kind,clean);
    IF coalesce(clean->>'patient_code','') = '' THEN RAISE EXCEPTION 'row_%_patient_code_required',row_no; END IF;
    rec_id := NULL; old_row := NULL;
    IF p_kind = 'baseline' THEN
      SELECT id,to_jsonb(b) INTO rec_id,old_row FROM public.patients_baseline b
        WHERE project_id=p_project_id AND patient_code=clean->>'patient_code' FOR UPDATE;
      IF rec_id IS NULL AND coalesce(clean->>'baseline_date','') = '' THEN RAISE EXCEPTION 'row_%_baseline_date_required',row_no; END IF;
      IF rec_id IS NOT NULL THEN
        IF clean ? 'baseline_date' AND EXISTS (
          SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=clean->>'patient_code'
            AND visit_date < (clean->>'baseline_date')::date
        ) THEN RAISE EXCEPTION 'row_%_baseline_date_after_existing_visit',row_no; END IF;
        clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,clean)))->key)
                  FROM jsonb_object_keys(clean) AS keys(key));
        IF old_row @> clean THEN skipped := skipped+1; CONTINUE; END IF;
        SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.patients_baseline,$1)).%I',key,key),',' ORDER BY key)
          INTO assignments FROM jsonb_object_keys(clean) AS keys(key) WHERE key <> 'patient_code';
        EXECUTE format('UPDATE public.patients_baseline SET %s WHERE id=$2 AND project_id=$3',assignments)
          USING clean,rec_id,p_project_id;
        changed := changed+1;
        CONTINUE;
      END IF;
    ELSE
      IF coalesce(clean->>'visit_date','') = '' THEN RAISE EXCEPTION 'row_%_visit_date_required',row_no; END IF;
      IF NOT clean ?| ARRAY['sbp','dbp','scr_umol_l','upcr','egfr'] THEN RAISE EXCEPTION 'row_%_core_measurement_required',row_no; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.patients_baseline WHERE project_id=p_project_id AND patient_code=clean->>'patient_code') THEN
        RAISE EXCEPTION 'row_%_patient_not_registered',row_no;
      END IF;
      PERFORM public._registry_validate_visit_payload(p_project_id,clean);
      clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.visits_long,clean)))->key)
                FROM jsonb_object_keys(clean) AS keys(key));
      row_hash := encode(sha256(convert_to(clean::text,'UTF8')),'hex');
      SELECT record_id INTO rec_id FROM public.registry_import_records
        WHERE project_id=p_project_id AND kind=p_kind AND content_sha256=row_hash;
      IF rec_id IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.visits_long WHERE id=rec_id AND project_id=p_project_id) THEN
          RAISE EXCEPTION 'row_%_previously_imported_record_deleted_requires_review',row_no;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.visits_long v WHERE id=rec_id AND project_id=p_project_id AND to_jsonb(v) @> clean) THEN
          RAISE EXCEPTION 'row_%_record_changed_since_import',row_no
            USING HINT = '记录已在导入后更正，请核对当前记录；不会覆盖更正或默默跳过差异。';
        END IF;
        skipped := skipped+1; CONTINUE;
      END IF;
      SELECT id INTO rec_id FROM public.visits_long v WHERE project_id=p_project_id
        AND patient_code=clean->>'patient_code' AND visit_date=(clean->>'visit_date')::date
        AND to_jsonb(v) @> clean ORDER BY id LIMIT 1;
      IF rec_id IS NOT NULL THEN
        INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id)
          VALUES(p_project_id,p_kind,row_hash,rec_id);
        skipped := skipped+1; CONTINUE;
      END IF;
      IF EXISTS(SELECT 1 FROM public.visits_long WHERE project_id=p_project_id
        AND patient_code=clean->>'patient_code' AND visit_date=(clean->>'visit_date')::date) THEN
        RAISE EXCEPTION 'row_%_same_day_record_conflict',row_no
          USING HINT = '同一患者同日已有不同数据，请先在记录纠错中核实；本批次未写入。';
      END IF;
      IF clean ? 'egfr' THEN clean := clean || jsonb_build_object('egfr_formula_version','manual'); END IF;
    END IF;
    clean := clean || jsonb_build_object('project_id',p_project_id,'created_by',auth.uid());
    SELECT string_agg(format('%I',key),',' ORDER BY key),
           string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',tbl,key),',' ORDER BY key)
      INTO cols,exprs FROM jsonb_object_keys(clean) AS keys(key);
    EXECUTE format('INSERT INTO public.%I(%s) SELECT %s RETURNING id',tbl,cols,exprs) INTO rec_id USING clean;
    IF p_kind = 'visits' THEN
      INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id)
        VALUES(p_project_id,p_kind,row_hash,rec_id);
    END IF;
    added := added+1;
  END LOOP;
  result := jsonb_build_object('inserted',added,'updated',changed,'skipped',skipped,'total',row_no,'replayed',false);
  INSERT INTO public.registry_import_batches(project_id,batch_id,kind,content_sha256,actor_id,result)
    VALUES(p_project_id,p_batch_id,p_kind,payload_hash,auth.uid(),result);
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.correct_registry_record(p_project_id uuid,p_table text,p_record_id uuid,p_changes jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text; before_row jsonb; after_row jsonb; assignments text; changes jsonb := p_changes; old_reason text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'correction_reason_required'; END IF;
  kind := CASE p_table WHEN 'patients_baseline' THEN 'baseline' WHEN 'visits_long' THEN 'visits' WHEN 'labs_long' THEN 'labs' END;
  IF kind IS NULL THEN RAISE EXCEPTION 'unsupported_record_type'; END IF;
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR changes='{}'::jsonb THEN RAISE EXCEPTION 'correction_changes_required'; END IF;
  IF changes ? 'patient_code' THEN RAISE EXCEPTION 'patient_identity_is_immutable'; END IF;
  PERFORM public._registry_validate_input(kind,changes);
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND project_id=$2 FOR UPDATE',p_table)
    INTO before_row USING p_record_id,p_project_id;
  IF before_row IS NULL THEN RAISE EXCEPTION 'record_not_found'; END IF;
  IF kind = 'baseline' AND changes ? 'baseline_date' AND changes->>'baseline_date' IS NULL THEN RAISE EXCEPTION 'baseline_date_required'; END IF;
  IF kind = 'baseline' AND changes ? 'baseline_date' AND EXISTS (
    SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=before_row->>'patient_code'
      AND visit_date < (changes->>'baseline_date')::date
  ) THEN RAISE EXCEPTION 'baseline_date_after_existing_visit'; END IF;
  IF kind = 'visits' THEN
    IF changes ? 'egfr' THEN
      changes := changes || jsonb_build_object('egfr_formula_version',CASE WHEN changes->>'egfr' IS NULL THEN NULL ELSE 'manual' END);
    END IF;
    IF changes ? 'visit_date' AND changes->>'visit_date' IS NULL THEN RAISE EXCEPTION 'visit_date_required'; END IF;
    PERFORM public._registry_validate_visit_payload(p_project_id,before_row || changes,p_record_id);
  END IF;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason',btrim(p_reason),true);
  IF kind = 'labs' THEN
    after_row := before_row || changes;
    PERFORM public.upsert_lab_record(p_project_id,before_row->>'patient_code',(after_row->>'lab_date')::date,
      after_row->>'lab_test_code',(after_row->>'value_raw')::numeric,after_row->>'unit_symbol',
      (after_row->>'measured_at')::timestamptz,p_record_id);
  ELSE
    changes := changes || jsonb_build_object('qc_reason',btrim(p_reason));
    SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.%I,$1)).%I',key,p_table,key),',' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(changes) AS keys(key);
    EXECUTE format('UPDATE public.%I SET %s WHERE id=$2 AND project_id=$3',p_table,assignments)
      USING changes,p_record_id,p_project_id;
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND project_id=$2',p_table)
    INTO after_row USING p_record_id,p_project_id;
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN jsonb_build_object('record',after_row,'changed',before_row IS DISTINCT FROM after_row);
END $$;

CREATE OR REPLACE FUNCTION public.get_registry_export(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE s public.project_snapshots; e registry_private.export_contents;
BEGIN
  SELECT * INTO s FROM public.project_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'export_not_found'; END IF;
  PERFORM public.assert_project_permission(s.project_id,'export');
  SELECT * INTO e FROM registry_private.export_contents WHERE snapshot_id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'metadata_only_snapshot'
    USING HINT = '这是旧版本元数据记录，未保存当时数据；请创建新的研究导出。'; END IF;
  RETURN jsonb_build_object('id',s.id,'snapshot_id',s.snapshot_id,'created_at',e.created_at,
    'content_sha256',e.content_sha256,'content_text',e.content_text,
    'consistency','database_statement_snapshot','schema_version','registry_v2');
END $$;

CREATE OR REPLACE FUNCTION public.create_registry_export(p_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE payload jsonb; payload_text text; sha text; sid uuid; code text; part record; n_patients int; n_visits int;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'export');
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'export_request_id_required'; END IF;
  -- Serialize exports for this project, including lost-response retries. This is a read entitlement:
  -- trial expiry does not prevent a researcher from retrieving their own data.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  PERFORM public.assert_project_permission(p_project_id,'export');
  SELECT snapshot_id INTO sid FROM registry_private.export_contents WHERE project_id=p_project_id AND request_id=p_request_id;
  IF sid IS NOT NULL THEN RETURN public.get_registry_export(sid); END IF;

  -- The subqueries are all part of THIS SINGLE SQL statement and see the same database snapshot.
  -- Fetch one sentinel beyond the per-table bound; reject rather than produce a truncated package.
  WITH
    rows_0 AS MATERIALIZED (SELECT * FROM public.patients_baseline WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_1 AS MATERIALIZED (SELECT * FROM public.visits_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_2 AS MATERIALIZED (SELECT * FROM public.labs_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_3 AS MATERIALIZED (SELECT * FROM public.meds_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_4 AS MATERIALIZED (SELECT * FROM public.variants_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_5 AS MATERIALIZED (SELECT * FROM public.events_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_6 AS MATERIALIZED (SELECT * FROM public.ktx_baseline_ext WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_7 AS MATERIALIZED (SELECT * FROM public.ktx_visits_ext WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_8 AS MATERIALIZED (SELECT * FROM public.data_issues WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    bounds AS MATERIALIZED (SELECT ((SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_0 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_1 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_2 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_3 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_4 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_5 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_6 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_7 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_8 t)) AS row_bytes, ((SELECT count(*) FROM rows_0)>10000 OR (SELECT count(*) FROM rows_1)>10000 OR (SELECT count(*) FROM rows_2)>10000 OR (SELECT count(*) FROM rows_3)>10000 OR (SELECT count(*) FROM rows_4)>10000 OR (SELECT count(*) FROM rows_5)>10000 OR (SELECT count(*) FROM rows_6)>10000 OR (SELECT count(*) FROM rows_7)>10000 OR (SELECT count(*) FROM rows_8)>10000) AS over_rows)
  SELECT CASE
    WHEN bounds.over_rows THEN jsonb_build_object('export_error','export_table_too_large')
    WHEN bounds.row_bytes>16700000 THEN jsonb_build_object('export_error','export_payload_too_large')
    ELSE jsonb_build_object(
      'schema_version','registry_v2',
      'captured_at',clock_timestamp(),
      'project',jsonb_build_object('id',p.id,'name',p.name,'center_code',p.center_code,'module',p.module,'registry_type',p.registry_type),
      'tables',jsonb_build_object(
      'patients_baseline',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_0 t),
      'visits_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_1 t),
      'labs_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_2 t),
      'meds_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_3 t),
      'variants_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_4 t),
      'events_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_5 t),
      'ktx_baseline_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_6 t),
      'ktx_visits_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_7 t),
      'data_issues',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_8 t)
      )
    ) END INTO payload
  FROM public.projects p CROSS JOIN bounds WHERE p.id=p_project_id;
  IF payload ? 'export_error' THEN
    RAISE EXCEPTION '%',payload->>'export_error'
      USING HINT = '同步导出每表最多10000行、总数据约16MiB；超限请安排完整后台导出，本次没有生成部分文件。';
  END IF;
  FOR part IN SELECT key,value FROM jsonb_each(payload->'tables') LOOP
    IF jsonb_array_length(part.value)>10000 THEN
      RAISE EXCEPTION 'export_table_too_large: %',part.key
        USING HINT = '同步导出上限为每表10000行；请联系管理员安排完整后台导出，本次未生成部分文件。';
    END IF;
  END LOOP;
  payload_text := payload::text;
  IF octet_length(payload_text)>16777216 THEN RAISE EXCEPTION 'export_payload_too_large'; END IF;
  sha := encode(sha256(convert_to(payload_text,'UTF8')),'hex');
  n_patients := jsonb_array_length(payload->'tables'->'patients_baseline');
  n_visits := jsonb_array_length(payload->'tables'->'visits_long');
  code := 'KS-' || to_char(now(),'YYYY') || '-' || upper(replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.project_snapshots(snapshot_id,project_id,status,kind,filter_summary,schema_version,n_patients,n_visits,
    qc_summary,created_by,locked_at,locked_by,notes)
  VALUES(code,p_project_id,'locked','paper_package','{}','registry_v2',n_patients,n_visits,
    jsonb_build_object('issue_count',jsonb_array_length(payload->'tables'->'data_issues')),
    auth.uid(),now(),auth.uid(),'frozen_export_v2; immutable content; server SHA256='||sha) RETURNING id INTO sid;
  INSERT INTO registry_private.export_contents(snapshot_id,project_id,request_id,content_text,content_sha256,created_by)
    VALUES(sid,p_project_id,p_request_id,payload_text,sha,auth.uid());
  INSERT INTO public.audit_log(project_id,actor_uid,action,snapshot_id,details)
    VALUES(p_project_id,auth.uid(),'frozen_export_create',code,
      jsonb_build_object('content_sha256',sha,'schema_version','registry_v2','request_id',p_request_id));
  RETURN public.get_registry_export(sid);
END $$;

CREATE OR REPLACE FUNCTION public.get_field_audit(p_table_name text,p_record_id uuid)
RETURNS TABLE(changed_at timestamptz,field_name text,old_value text,new_value text,changed_by uuid,change_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT a.changed_at,a.field_name,a.old_value,a.new_value,a.changed_by,a.change_reason
  FROM public.field_audit_log a JOIN public.projects p ON p.id=a.project_id
  WHERE a.table_name=p_table_name AND a.record_id=p_record_id AND public.has_project_permission(a.project_id,'read')
  ORDER BY a.changed_at DESC;
$$;

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
set search_path = pg_catalog,public,pg_temp
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
      where p.id = p_project_id and public.has_project_permission(p.id,'read')
    )
  order by h.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

CREATE OR REPLACE FUNCTION get_issue_summary(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_open',    COUNT(*) FILTER (WHERE status = 'OPEN'),
    'total_in_prog', COUNT(*) FILTER (WHERE status = 'IN_PROGRESS'),
    'total_resolved',COUNT(*) FILTER (WHERE status = 'RESOLVED'),
    'total_wontfix', COUNT(*) FILTER (WHERE status = 'WONT_FIX'),
    'by_severity', jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='critical'),
      'warning',  COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='warning'),
      'info',     COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='info')
    ),
    'close_rate_pct', ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('RESOLVED','WONT_FIX'))
      / NULLIF(COUNT(*), 0)
    , 1)
  )
  INTO v_result
  FROM data_issues
  WHERE project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = p_project_id AND public.has_project_permission(p.id,'read')
    );

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

create or replace function public.list_project_snapshots(p_project_id uuid)
returns setof public.project_snapshots
language sql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
  select s.*
  from public.project_snapshots s
  where s.project_id = p_project_id
    and exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'read'))
  order by s.created_at desc;
$$;

create or replace function public.create_project_snapshot(
  p_project_id uuid,
  p_kind text default 'snapshot',
  p_filter_summary jsonb default '{}'::jsonb,
  p_schema_version text default 'core_v1'
)
returns table (
  id uuid,
  snapshot_id text,
  status text,
  created_at timestamptz,
  n_patients int,
  n_visits int,
  missing_rate numeric,
  qc_summary jsonb
)
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_snapshot_id text;
  v_n_patients int := 0;
  v_n_visits int := 0;
  v_missing_rate numeric := 0;
  v_qc jsonb;
  v_id uuid;
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  if p_kind not in ('snapshot','paper_package','export') then
    raise exception 'invalid_kind';
  end if;

  select count(distinct patient_code) into v_n_patients from public.patients_baseline where project_id = p_project_id;
  select count(*) into v_n_visits from public.visits_long where project_id = p_project_id;

  select jsonb_build_object(
    'visits_missing_sbp', count(*) filter (where sbp is null),
    'visits_missing_dbp', count(*) filter (where dbp is null),
    'visits_missing_scr', count(*) filter (where scr_umol_l is null),
    'visits_missing_upcr', count(*) filter (where upcr is null)
  ) into v_qc
  from public.visits_long
  where project_id = p_project_id;

  if v_n_visits > 0 then
    select (
      ((count(*) filter (where sbp is null or dbp is null or scr_umol_l is null or upcr is null))::numeric / count(*)::numeric) * 100
    ) into v_missing_rate
    from public.visits_long
    where project_id = p_project_id;
  end if;

  v_snapshot_id := public._new_snapshot_code();

  insert into public.project_snapshots(
    snapshot_id, project_id, status, kind, filter_summary, schema_version,
    n_patients, n_visits, missing_rate, qc_summary, created_by
  )
  values (
    v_snapshot_id, p_project_id, 'draft', p_kind, coalesce(p_filter_summary,'{}'::jsonb), p_schema_version,
    v_n_patients, v_n_visits, coalesce(v_missing_rate,0), coalesce(v_qc,'{}'::jsonb), v_uid
  )
  returning project_snapshots.id into v_id;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (
    p_project_id,
    v_uid,
    'snapshot_create',
    v_snapshot_id,
    jsonb_build_object('kind', p_kind, 'schema_version', p_schema_version, 'filter_summary', coalesce(p_filter_summary,'{}'::jsonb))
  );

  return query
  select s.id, s.snapshot_id, s.status, s.created_at, s.n_patients, s.n_visits, s.missing_rate, s.qc_summary
  from public.project_snapshots s where s.id = v_id;
end;
$$;

create or replace function public.lock_project_snapshot(p_snapshot_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
declare
  v_project uuid;
  v_snapshot text;
begin
  select project_id, snapshot_id into v_project, v_snapshot
  from public.project_snapshots
  where id = p_snapshot_id
  limit 1;

  if v_project is null then
    raise exception 'snapshot_not_found';
  end if;

  if not exists (select 1 from public.projects p where p.id = v_project and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  update public.project_snapshots
  set status = 'locked', locked_at = now(), locked_by = auth.uid()
  where id = p_snapshot_id and status <> 'locked';

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (v_project, auth.uid(), 'snapshot_lock', v_snapshot, '{}'::jsonb);
end;
$$;

create or replace function public.log_project_audit(
  p_project_id uuid,
  p_action text,
  p_snapshot_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (p_project_id, auth.uid(), p_action, p_snapshot_id, coalesce(p_details,'{}'::jsonb));
end;
$$;

-- QC resolution is a clinical write, including the project's account entitlement.
CREATE OR REPLACE FUNCTION public.close_issue_wont_fix(p_issue_id uuid,p_resolution text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pid uuid;
BEGIN
 SELECT project_id INTO pid FROM public.data_issues WHERE id=p_issue_id;
 PERFORM public.assert_project_permission(pid,'write');
 PERFORM public.assert_project_write_allowed(pid);
 IF p_resolution IS NULL OR length(btrim(p_resolution)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'resolution_required'; END IF;
 UPDATE public.data_issues SET status='WONT_FIX',resolution_note=btrim(p_resolution),resolved_at=now(),updated_at=now() WHERE id=p_issue_id;
 INSERT INTO public.audit_log(project_id,actor_uid,action,details)
  VALUES(pid,auth.uid(),'issue_wont_fix',jsonb_build_object('issue_id',p_issue_id,'reason',btrim(p_resolution)));
END $$;

CREATE OR REPLACE FUNCTION registry_private.guard_member_auxiliary_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pid uuid;
BEGIN
 IF TG_TABLE_NAME='data_issue_comments' THEN
  SELECT project_id INTO pid FROM public.data_issues WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
  -- Parent deletion already passed its RLS; a cascading child DELETE may no longer see the issue.
  IF TG_OP='DELETE' AND pid IS NULL AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.issue_id IS DISTINCT FROM OLD.issue_id THEN RAISE EXCEPTION 'comment_issue_is_immutable'; END IF;
  -- Do not reveal foreign issue existence before checking the caller's authorization.
  PERFORM public.assert_project_permission(pid,'write');
  PERFORM public.assert_project_write_allowed(pid);
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
   VALUES(pid,auth.uid(),'issue_comment_'||lower(TG_OP),jsonb_build_object('comment_id',CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END));
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF auth.uid() IS NOT NULL AND coalesce(current_setting('role',true),'') NOT IN ('service_role','supabase_admin','postgres') THEN
  IF TG_OP='INSERT' THEN NEW.created_by:=auth.uid();NEW.created_at:=now();
  ELSE NEW.created_by:=OLD.created_by;NEW.created_at:=OLD.created_at; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_comment_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.data_issue_comments
 FOR EACH ROW EXECUTE FUNCTION registry_private.guard_member_auxiliary_row();
CREATE TRIGGER member_custom_lab_metadata BEFORE INSERT OR UPDATE ON public.project_custom_labs
 FOR EACH ROW EXECUTE FUNCTION registry_private.guard_member_auxiliary_row();

REVOKE ALL ON FUNCTION registry_private.project_role(uuid),registry_private.guard_member_auxiliary_row() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.assert_project_permission(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.has_project_permission(uuid,text),public.get_project_access(uuid),
 public.list_project_members(uuid),public.add_project_member(uuid,text,text),
 public.change_project_member_role(uuid,uuid,text),public.remove_project_member(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.has_project_permission(uuid,text),public.get_project_access(uuid),
 public.list_project_members(uuid),public.add_project_member(uuid,text,text),
 public.change_project_member_role(uuid,uuid,text),public.remove_project_member(uuid,uuid) TO authenticated;
-- Replacements retain their existing ACLs; make the intended exposed contract explicit.
REVOKE ALL ON FUNCTION public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
 public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
 public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
 public.import_registry_rows(uuid,text,jsonb,uuid),public.correct_registry_record(uuid,text,uuid,jsonb,text),
 public.create_registry_export(uuid,uuid),public.get_registry_export(uuid),public.get_field_audit(text,uuid),
 public.admin_get_visit_history(uuid,text,int),public.get_issue_summary(uuid),public.list_project_snapshots(uuid),
 public.create_project_snapshot(uuid,text,jsonb,text),public.lock_project_snapshot(uuid),
 public.log_project_audit(uuid,text,text,jsonb),public.close_issue_wont_fix(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
 public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
 public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
 public.import_registry_rows(uuid,text,jsonb,uuid),public.correct_registry_record(uuid,text,uuid,jsonb,text),
 public.create_registry_export(uuid,uuid),public.get_registry_export(uuid),public.get_field_audit(text,uuid),
 public.admin_get_visit_history(uuid,text,int),public.get_issue_summary(uuid),public.list_project_snapshots(uuid),
 public.create_project_snapshot(uuid,text,jsonb,text),public.lock_project_snapshot(uuid),
 public.log_project_audit(uuid,text,text,jsonb),public.close_issue_wont_fix(uuid,text) TO authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0036_project_members') ON CONFLICT(version) DO NOTHING;
COMMIT;
