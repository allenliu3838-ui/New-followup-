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
