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
