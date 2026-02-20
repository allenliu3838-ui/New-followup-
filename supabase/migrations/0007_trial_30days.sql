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
