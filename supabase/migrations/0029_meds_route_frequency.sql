-- Add route and frequency columns to meds_long for structured medication dosing
alter table public.meds_long add column if not exists route text;
alter table public.meds_long add column if not exists frequency text;

comment on column public.meds_long.route is 'Administration route: PO, IV, SC, IM, topical, other';
comment on column public.meds_long.frequency is 'Dosing frequency: qd, bid, tid, qod, qw, biw, q2w, qm, prn, other';
