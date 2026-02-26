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
