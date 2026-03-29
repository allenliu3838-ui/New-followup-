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
