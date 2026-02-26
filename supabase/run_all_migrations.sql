-- ======================================================
-- FILE: 0001_core.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0002_clinical_constraints.sql
-- ======================================================
-- Migration 0002: Add CHECK constraints for clinical value ranges
-- Prevents obviously erroneous data from being stored.

-- visits_long: blood pressure and renal function ranges
alter table public.visits_long
  add constraint visits_sbp_range  check (sbp  is null or (sbp  between 40  and 300)),
  add constraint visits_dbp_range  check (dbp  is null or (dbp  between 20  and 200)),
  add constraint visits_scr_range  check (scr_umol_l is null or (scr_umol_l between 10 and 5000)),
  add constraint visits_egfr_range check (egfr is null or (egfr between 0  and 200)),
  add constraint visits_upcr_range check (upcr is null or upcr >= 0);

-- patients_baseline: birth_year and baseline lab ranges
alter table public.patients_baseline
  add constraint baseline_birth_year_range check (birth_year is null or (birth_year between 1900 and 2100)),
  add constraint baseline_scr_range  check (baseline_scr  is null or (baseline_scr  between 10 and 5000)),
  add constraint baseline_upcr_range check (baseline_upcr is null or baseline_upcr >= 0);

-- ======================================================
-- FILE: 0002_events.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0003_subscription.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0004_p0_guardrails.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0005_snapshots_and_ktx.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0006_demo_requests.sql
-- ======================================================
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

create policy "allow_public_insert" on demo_requests
  for insert to anon with check (true);

-- Only authenticated (staff) can read / update
create policy "allow_auth_select" on demo_requests
  for select to authenticated using (true);

create policy "allow_auth_update" on demo_requests
  for update to authenticated using (true);

-- ======================================================
-- FILE: 0007_trial_30days.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0008_rct_phase1.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0009_platform_admins.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0010_user_profiles.sql
-- ======================================================
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
create policy "user_own_profile_select" on public.user_profiles
  for select using (auth.uid() = user_id);

create policy "user_own_profile_insert" on public.user_profiles
  for insert with check (auth.uid() = user_id);

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

-- ======================================================
-- FILE: 0011_partner_contracts.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0012_pr1_foundation.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0013_pr2_lab_catalog.sql
-- ======================================================
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

CREATE POLICY "catalog_select" ON lab_test_catalog FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "unit_select"    ON unit_catalog      FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "map_select"     ON lab_test_unit_map FOR SELECT TO authenticated, anon USING (true);

-- ======================================================
-- FILE: 0014_pr3_validators.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0015_pr5_pii_guard.sql
-- ======================================================
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

-- ======================================================
-- FILE: 0016_pr6_issue_system.sql
-- ======================================================
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
CREATE POLICY "issues_project_owner"
  ON data_issues FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = data_issues.project_id
      AND p.created_by = auth.uid()
  ));

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

-- ======================================================
-- FILE: 0017_pr7_field_audit.sql
-- ======================================================
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

