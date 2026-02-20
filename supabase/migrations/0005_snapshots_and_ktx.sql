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
