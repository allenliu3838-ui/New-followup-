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
