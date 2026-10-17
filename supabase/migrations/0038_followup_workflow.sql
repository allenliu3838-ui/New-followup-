-- 0038: follow-up workflow for the workbench and the patient follow-up page.
-- Additive, transactional and safe to re-run on existing production data.
--  * Research consent becomes an explicit five-state field. The legacy boolean
--    consent_research only ever held its schema default (true): no screen let anyone
--    fill it in. It is cleared to NULL (= unconfirmed, field-audited with a reason) and
--    from now on derived from consent_status; conflicting direct writes are refused.
--    The clearing refuses to run if any row or audit entry shows a value that may have
--    been entered by a person: that needs a manual review first.
--  * Follow-up status per patient. Declined/withdrawn consent or a withdrawn/deceased
--    follow-up status ("left the study") revokes that patient's usable links and is
--    allowed after the account trial ends (a compliance action).
--  * Entering or leaving "left the study", and any change to the study status fields of a
--    participant who left, happens only through set_patient_study_status, with a stated
--    reason (at least 2 characters, no identifying information). CSV import, audited
--    correction and plain table writes are refused (study_status_requires_dedicated_action).
--    The function marks the one row it updates in a private table for the duration of
--    its own UPDATE; no session setting can stand in for that mark. Other status values
--    (unconfirmed/consented/waiver, active/lost/transferred/kidney_failure) may still be
--    imported. Study status given when a patient row is created is field-audited too.
--  * After the trial ends, the exemption covers only a move from "not left" to "left"
--    (consent declined/withdrawn, follow-up stopped) and the first entry of the matching
--    date; never a move between exit statuses or a change to a recorded exit date.
--  * Design choice, deliberately unchanged: after a participant leaves the study, staff may
--    still enter that participant's clinical data (visit import, direct medication, event
--    and variant writes, the lab RPC, corrections), and the data dates are not compared
--    with the exit date. Data collected before the exit is often entered later; only the
--    participant's own link-based collection stops.
--  * "Today" for research dates is the Beijing calendar date (registry_private.local_today),
--    independent of the database or session time zone.
--  * Per-project follow-up interval and the study details shown to patients
--    (title, institution, ethics approval number, research team contact).
--  * Caller-privilege (security_invoker) views for "who is due / who has not
--    submitted", relying on the base tables' RLS. No clinical threshold is defined
--    here: the interval is a project setting the study team confirms.
--  * Row-level security asks "which projects may this user read / write / manage links
--    of" once per query (registry_private.project_ids_with_permission) instead of calling
--    has_project_permission for every row; the answers are the same.
-- Lock order on every write path for one patient: projects row, then the patient's
-- baseline row, then that patient's link rows (patient submissions use the same order).
-- A direct visit insert takes the project row (KEY SHARE) before the baseline row as well.
BEGIN;

-- No consent value can be written between the precondition check below and the clearing
-- step: writers to the baseline table wait for this transaction; plain reads continue.
LOCK TABLE public.patients_baseline IN EXCLUSIVE MODE;

-- Preconditions. Nothing below runs unless the objects it relies on are present and
-- the never-entered consent default is the only consent information in the database.
DO $$
DECLARE missing text; n_rows bigint; n_audit bigint;
BEGIN
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['tr_patients_trial_lock','tr_patients_updated_meta','registry_audit_baseline']) AS t
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.patients_baseline'::regclass
      AND tgname=t AND NOT tgisinternal);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0038 已中止：患者基线表缺少本迁移依赖的触发器（%）。请先确认数据库已按 0001–0037 完整升级，需人工核对后再迁移。',missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0038_followup_workflow') THEN
    SELECT count(*) INTO n_rows FROM public.patients_baseline WHERE consent_research IS DISTINCT FROM true;
    SELECT count(*) INTO n_audit FROM public.field_audit_log
      WHERE table_name='patients_baseline' AND field_name='consent_research';
    IF n_rows > 0 OR n_audit > 0 THEN
      RAISE EXCEPTION '迁移 0038 已中止：有 % 位患者的“研究同意”不是系统默认值“是”，审计记录中有 % 条该字段的修改记录。这些可能是人工填写或导入的同意信息，迁移不会自动清空。需人工核对后再迁移：按知情同意原始记录逐一确认，再决定如何处理。',n_rows,n_audit;
    END IF;
  END IF;
END $$;

ALTER TABLE public.patients_baseline
  ADD COLUMN IF NOT EXISTS consent_status text NOT NULL DEFAULT 'unconfirmed'
    CONSTRAINT patients_baseline_consent_status_check
    CHECK (consent_status IN ('unconfirmed','consented','waiver','declined','withdrawn')),
  ADD COLUMN IF NOT EXISTS consent_date date,
  ADD COLUMN IF NOT EXISTS consent_version text
    CONSTRAINT patients_baseline_consent_version_length
    CHECK (char_length(consent_version) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS followup_status text NOT NULL DEFAULT 'active'
    CONSTRAINT patients_baseline_followup_status_check
    CHECK (followup_status IN ('active','lost','withdrawn','deceased','kidney_failure','transferred')),
  ADD COLUMN IF NOT EXISTS followup_status_date date;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS followup_interval_days int NOT NULL DEFAULT 90
    CONSTRAINT projects_followup_interval_days_range CHECK (followup_interval_days BETWEEN 7 AND 730),
  ADD COLUMN IF NOT EXISTS public_title text
    CONSTRAINT projects_public_title_length CHECK (char_length(public_title) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS institution_name text
    CONSTRAINT projects_institution_name_length CHECK (char_length(institution_name) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS ethics_approval_no text
    CONSTRAINT projects_ethics_approval_no_length CHECK (char_length(ethics_approval_no) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS contact_display text
    CONSTRAINT projects_contact_display_length CHECK (char_length(contact_display) BETWEEN 1 AND 120);

-- The legacy default must never again stand in for a research consent decision.
ALTER TABLE public.patients_baseline ALTER COLUMN consent_research DROP DEFAULT;
ALTER TABLE public.patients_baseline ALTER COLUMN consent_research DROP NOT NULL;
-- Clear the never-entered default exactly once (a re-run must not erase derived values).
-- The account write guard and metadata trigger are bypassed only for this statement:
-- expired trials must not block the migration, and updated_at/updated_by stay the
-- record's real last edit. The field audit trigger stays enabled and records each row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0038_followup_workflow') THEN
    PERFORM set_config('app.registry_change_reason',
      '系统升级（0038）：原“研究同意”只是系统默认值，从未由人工填写，现统一改为“未确认”；请按知情同意记录核实后更新。',true);
    ALTER TABLE public.patients_baseline DISABLE TRIGGER tr_patients_trial_lock;
    ALTER TABLE public.patients_baseline DISABLE TRIGGER tr_patients_updated_meta;
    UPDATE public.patients_baseline SET consent_research=NULL WHERE consent_research IS NOT NULL;
    ALTER TABLE public.patients_baseline ENABLE TRIGGER tr_patients_updated_meta;
    ALTER TABLE public.patients_baseline ENABLE TRIGGER tr_patients_trial_lock;
    PERFORM set_config('app.registry_change_reason','',true);
  END IF;
END $$;

-- The registry's "today": the Beijing calendar date, whatever the server or session
-- time zone is. Every "not after today" rule and every due/overdue calculation uses it.
-- Callable by signed-in users only so that the caller-privilege views below can use it.
CREATE OR REPLACE FUNCTION registry_private.local_today()
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date;
$$;
REVOKE ALL ON FUNCTION registry_private.local_today() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION registry_private.local_today() TO authenticated;
COMMENT ON FUNCTION registry_private.local_today() IS
  '登记系统的“今天”：按北京时间（Asia/Shanghai）计算的日历日期，不受数据库或会话时区设置影响。';

-- consented/waiver -> true, declined/withdrawn -> false, unconfirmed -> NULL.
-- A conflicting explicit value is refused rather than silently replaced.
CREATE OR REPLACE FUNCTION registry_private.derive_consent_research()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE derived boolean := CASE NEW.consent_status
  WHEN 'consented' THEN true WHEN 'waiver' THEN true
  WHEN 'declined' THEN false WHEN 'withdrawn' THEN false ELSE NULL END;
BEGIN
  IF NEW.consent_research IS DISTINCT FROM derived AND (CASE WHEN TG_OP='INSERT'
      THEN NEW.consent_research IS NOT NULL
      ELSE NEW.consent_research IS DISTINCT FROM OLD.consent_research END) THEN
    RAISE EXCEPTION 'consent_research_is_derived'
      USING HINT='研究同意请按“同意状态”记录（未确认、已同意、豁免知情同意、拒绝、撤回），原是/否字段由系统自动生成。';
  END IF;
  NEW.consent_research := derived;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.derive_consent_research() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_consent_research_derived ON public.patients_baseline;
CREATE TRIGGER registry_consent_research_derived
  BEFORE INSERT OR UPDATE OF consent_status,consent_research ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.derive_consent_research();

-- The one baseline row set_patient_study_status is updating, for the duration of that
-- UPDATE only (inserted and deleted by the function inside the same transaction; empty
-- otherwise). The study status trigger and the account write guard accept an exit-related
-- change only for a row marked here in the current transaction. Nobody but the function
-- owner can write it, so no session setting or direct write can imitate the function.
CREATE TABLE IF NOT EXISTS registry_private.study_status_rpc_rows (
  xact_id xid8 NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (xact_id,record_id)
);
ALTER TABLE registry_private.study_status_rpc_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.study_status_rpc_rows FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE registry_private.study_status_rpc_rows IS
  '仅在 set_patient_study_status 执行其 UPDATE 期间存在一行（同一事务内写入并删除），平时为空。研究状态触发器与账户写入检查据此确认修改来自专用入口。';

-- True for a baseline row marked by set_patient_study_status in the current transaction.
CREATE OR REPLACE FUNCTION registry_private.study_status_rpc_active(p_record_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM registry_private.study_status_rpc_rows r
    WHERE r.xact_id = pg_current_xact_id() AND r.record_id = p_record_id);
$$;
REVOKE ALL ON FUNCTION registry_private.study_status_rpc_active(uuid) FROM PUBLIC,anon,authenticated;

-- True when the only change between two baseline rows records that the participant
-- left the study, which the account write guard allows after the trial ends:
--  * consent moves from not declined/withdrawn to declined/withdrawn;
--  * follow-up moves from active to a stopped status (lost, withdrawn, deceased,
--    kidney failure, transferred);
--  * a status date changes together with that move, or is entered for the first time
--    (empty before) for a status that already records the exit.
-- A move between exit statuses (deceased -> lost) or a change to a recorded exit date is
-- not covered. Derived and metadata columns are ignored.
CREATE OR REPLACE FUNCTION registry_private.study_exit_only_change(p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT (p_old - k) = (p_new - k)
    AND (p_new->'consent_status' IS NOT DISTINCT FROM p_old->'consent_status'
      OR (p_old->>'consent_status' NOT IN ('declined','withdrawn')
        AND p_new->>'consent_status' IN ('declined','withdrawn')))
    AND (p_new->'followup_status' IS NOT DISTINCT FROM p_old->'followup_status'
      OR (p_old->>'followup_status' = 'active'
        AND p_new->>'followup_status' IN ('lost','withdrawn','deceased','kidney_failure','transferred')))
    AND (p_new->'consent_date' IS NOT DISTINCT FROM p_old->'consent_date'
      OR p_new->'consent_status' IS DISTINCT FROM p_old->'consent_status'
      OR (p_old->>'consent_date' IS NULL AND p_new->>'consent_status' IN ('declined','withdrawn')))
    AND (p_new->'followup_status_date' IS NOT DISTINCT FROM p_old->'followup_status_date'
      OR p_new->'followup_status' IS DISTINCT FROM p_old->'followup_status'
      OR (p_old->>'followup_status_date' IS NULL AND p_new->>'followup_status' <> 'active'))
    AND (p_new->'consent_status' IS DISTINCT FROM p_old->'consent_status'
      OR p_new->'followup_status' IS DISTINCT FROM p_old->'followup_status'
      OR p_new->'consent_date' IS DISTINCT FROM p_old->'consent_date'
      OR p_new->'followup_status_date' IS DISTINCT FROM p_old->'followup_status_date')
  FROM (SELECT ARRAY['consent_status','consent_date','followup_status','followup_status_date',
    'consent_research','updated_at','updated_by']::text[] AS k) AS keys;
$$;
REVOKE ALL ON FUNCTION registry_private.study_exit_only_change(jsonb,jsonb) FROM PUBLIC,anon,authenticated;

-- Account write guard. Recording that a participant left the study is a compliance
-- action and, like revoking a link, must not depend on the account entitlement. The
-- exemption applies only to the row set_patient_study_status is updating (marked in
-- registry_private.study_status_rpc_rows), and the guard itself re-checks that the
-- change is an exit as defined by study_exit_only_change.
CREATE OR REPLACE FUNCTION public._trial_block_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN pid := OLD.project_id; ELSE pid := NEW.project_id; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'patients_baseline' THEN
    IF registry_private.study_status_rpc_active(NEW.id)
      AND registry_private.study_exit_only_change(to_jsonb(OLD),to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM public.assert_project_write_allowed(pid);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._trial_block_write() FROM PUBLIC,anon,authenticated;

-- Study status rules on every write path (RPC, CSV import, correction, direct table write):
-- dates not after today (Beijing) and a trimmed non-empty consent form version. A change
-- that enters or leaves "left the study" (consent declined/withdrawn, follow-up withdrawn/
-- deceased), or changes these fields while the participant has left, is accepted only from
-- set_patient_study_status, which requires and records the reason. Creating a patient row
-- that has already left is refused: create the patient, then record the exit.
CREATE OR REPLACE FUNCTION registry_private.check_study_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE is_insert boolean := TG_OP = 'INSERT'; today date := registry_private.local_today();
  left_before boolean := false; left_after boolean; changed boolean := true;
BEGIN
  IF NEW.consent_date > today AND (is_insert OR NEW.consent_date IS DISTINCT FROM OLD.consent_date) THEN
    RAISE EXCEPTION 'invalid_or_future_date: consent_date';
  END IF;
  IF NEW.followup_status_date > today
    AND (is_insert OR NEW.followup_status_date IS DISTINCT FROM OLD.followup_status_date) THEN
    RAISE EXCEPTION 'invalid_or_future_date: followup_status_date';
  END IF;
  IF NEW.consent_version IS NOT NULL AND (is_insert OR NEW.consent_version IS DISTINCT FROM OLD.consent_version)
    AND (NEW.consent_version <> btrim(NEW.consent_version) OR btrim(NEW.consent_version) = ''
      OR char_length(NEW.consent_version) > 100 OR NEW.consent_version ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_consent_version';
  END IF;
  left_after := NEW.consent_status IN ('declined','withdrawn') OR NEW.followup_status IN ('withdrawn','deceased');
  IF NOT is_insert THEN
    left_before := OLD.consent_status IN ('declined','withdrawn') OR OLD.followup_status IN ('withdrawn','deceased');
    changed := ROW(NEW.consent_status,NEW.consent_date,NEW.consent_version,NEW.followup_status,NEW.followup_status_date)
      IS DISTINCT FROM ROW(OLD.consent_status,OLD.consent_date,OLD.consent_version,OLD.followup_status,OLD.followup_status_date);
  END IF;
  IF changed AND (left_before OR left_after)
    AND (is_insert OR NOT registry_private.study_status_rpc_active(NEW.id)) THEN
    RAISE EXCEPTION 'study_status_requires_dedicated_action'
      USING HINT='登记或撤销拒绝/撤回同意、退出研究、死亡，以及修改已退出患者的研究状态，只能在工作台该患者的“研究状态”中操作并填写原因；导入、更正或直接写表不能修改。新患者请先建档，再登记研究状态。';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.check_study_status() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_study_status_checks ON public.patients_baseline;
CREATE TRIGGER registry_study_status_checks
  BEFORE INSERT OR UPDATE OF consent_status,consent_date,consent_version,followup_status,followup_status_date
  ON public.patients_baseline FOR EACH ROW EXECUTE FUNCTION registry_private.check_study_status();

-- Updates are field-audited by _registry_audit_changes (0034), which does not run on
-- INSERT. Study status given when the patient row is created (CSV import of a new
-- patient, direct insert) is audited here, field by field, with the transaction's reason.
CREATE OR REPLACE FUNCTION registry_private.audit_study_status_on_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb := to_jsonb(NEW);
  reason text := coalesce(nullif(btrim(current_setting('app.registry_change_reason',true)),''),
    '新建患者时登记的研究状态（未填写原因）');
BEGIN
  INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
    SELECT 'patients_baseline',NEW.id,NEW.project_id,NEW.patient_code,f.k,NULL,r->>f.k,auth.uid(),reason
    FROM unnest(ARRAY['consent_status','consent_date','consent_version','consent_research',
      'followup_status','followup_status_date']) WITH ORDINALITY AS f(k,n)
    WHERE CASE f.k WHEN 'consent_status' THEN r->>f.k <> 'unconfirmed'
      WHEN 'followup_status' THEN r->>f.k <> 'active' ELSE r->>f.k IS NOT NULL END
    ORDER BY f.n;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION registry_private.audit_study_status_on_insert() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_study_status_insert_audit ON public.patients_baseline;
CREATE TRIGGER registry_study_status_insert_audit AFTER INSERT ON public.patients_baseline
  FOR EACH ROW WHEN (NEW.consent_status <> 'unconfirmed' OR NEW.followup_status <> 'active'
    OR NEW.consent_date IS NOT NULL OR NEW.consent_version IS NOT NULL OR NEW.followup_status_date IS NOT NULL)
  EXECUTE FUNCTION registry_private.audit_study_status_on_insert();

-- Leaving the study stops link-based data collection on every write path: consent
-- declined/withdrawn or follow-up withdrawn/deceased revokes the patient's usable links.
-- Lost to follow-up, transfer and kidney failure keep links (the protocol may continue).
-- The baseline row is already locked here, so link rows are locked after it: the same
-- order patient_submit_visit_v2 uses. The audit lists the revoked link ids, never links.
CREATE OR REPLACE FUNCTION registry_private.revoke_links_on_study_exit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE why text; ids uuid[];
BEGIN
  IF NEW.consent_status IS DISTINCT FROM OLD.consent_status AND NEW.consent_status IN ('declined','withdrawn') THEN
    why := 'consent_' || NEW.consent_status;
  ELSIF NEW.followup_status IS DISTINCT FROM OLD.followup_status AND NEW.followup_status IN ('withdrawn','deceased') THEN
    why := 'followup_' || NEW.followup_status;
  ELSE RETURN NULL; END IF;
  WITH revoked AS (
    UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason=why
      WHERE project_id=NEW.project_id AND patient_code=NEW.patient_code AND active AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now())
      RETURNING id)
  SELECT array_agg(id ORDER BY id) INTO ids FROM revoked;
  IF ids IS NOT NULL THEN
    INSERT INTO public.security_audit_logs(project_id,patient_code,actor_uid,event_type,severity,details)
      VALUES(NEW.project_id,NEW.patient_code,auth.uid(),'study_exit_tokens_revoked','INFO',
        jsonb_build_object('reason',why,'revoked_token_count',cardinality(ids),'revoked_token_ids',to_jsonb(ids)));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION registry_private.revoke_links_on_study_exit() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_study_exit_links ON public.patients_baseline;
CREATE TRIGGER registry_study_exit_links
  AFTER UPDATE OF consent_status,followup_status ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.revoke_links_on_study_exit();

-- Baseline and visit dates may not be after today (Beijing date). This replaces the UTC
-- current_date comparison of 0032, which refused a visit dated "today" between 00:00 and
-- 08:00 Beijing time. It reads no table, so it may run with definer rights; the baseline
-- lookups stay in the caller-privilege check_research_dates (it fires after this one).
CREATE OR REPLACE FUNCTION registry_private.reject_future_research_dates()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'patients_baseline' THEN
    IF NEW.baseline_date > registry_private.local_today()
      AND (TG_OP = 'INSERT' OR NEW.baseline_date IS DISTINCT FROM OLD.baseline_date) THEN
      RAISE EXCEPTION 'future_baseline_date';
    END IF;
  ELSIF NEW.visit_date > registry_private.local_today()
    AND (TG_OP = 'INSERT' OR NEW.visit_date IS DISTINCT FROM OLD.visit_date) THEN
    RAISE EXCEPTION 'future_visit_date';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.reject_future_research_dates() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_baseline_date_future ON public.patients_baseline;
CREATE TRIGGER registry_baseline_date_future BEFORE INSERT OR UPDATE OF baseline_date ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.reject_future_research_dates();
DROP TRIGGER IF EXISTS registry_visit_date_future ON public.visits_long;
CREATE TRIGGER registry_visit_date_future BEFORE INSERT OR UPDATE OF visit_date ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.reject_future_research_dates();

-- The server calculates eGFR from creatinine, birth year and sex (trg_auto_egfr, and
-- trg_baseline_refresh_egfr when birth year or sex is corrected). A result outside the
-- visit table's 0–200 range means one of those inputs is wrong; say so instead of the
-- bare CHECK violation, on every path (CSV import, correction, direct write). The error
-- code is unchanged; it keeps SQLSTATE 23514 and names scr_umol_l, so
-- patient_submit_visit_v2 reports it as invalid_values. Fires after trg_auto_egfr
-- (trigger names run in alphabetical order).
CREATE OR REPLACE FUNCTION registry_private.check_calculated_egfr()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.egfr_formula_version = 'CKD-EPI-2021-Cr' AND NEW.egfr NOT BETWEEN 0 AND 200 THEN
    RAISE EXCEPTION 'egfr_out_of_range_check_scr' USING ERRCODE = 'check_violation', COLUMN = 'scr_umol_l',
      HINT ='由血肌酐、出生年份和性别计算的 eGFR 超出范围，请核对这几项（血肌酐数值与单位 μmol/L 或 mg/dL、出生年份、性别）。';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.check_calculated_egfr() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_auto_egfr_range ON public.visits_long;
CREATE TRIGGER trg_auto_egfr_range BEFORE INSERT OR UPDATE OF scr_umol_l,visit_date,project_id,
  patient_code,egfr,egfr_formula_version ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_calculated_egfr();

-- 0032's date integrity check without its UTC "future" comparison (now above).
-- SECURITY INVOKER is intentional: an unauthorized direct INSERT must not use a
-- trigger's error text to probe another project's baseline or visit existence.
CREATE OR REPLACE FUNCTION registry_private.check_research_dates()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_baseline_date date;
BEGIN
  IF TG_TABLE_NAME='patients_baseline' THEN
    IF TG_OP='UPDATE' AND NEW.baseline_date IS NOT DISTINCT FROM OLD.baseline_date THEN RETURN NEW; END IF;
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
REVOKE ALL ON FUNCTION registry_private.check_research_dates() FROM PUBLIC,anon,authenticated;

-- A direct visit insert locks the patient's baseline row (registry_visit_dates, FOR SHARE)
-- and later, in the foreign key check, the project row (KEY SHARE). CSV import and
-- correction lock the project row first (FOR UPDATE) and then the baseline row, so a
-- multi-row insert could deadlock with them. Taking the project row first here gives
-- every path the same order: project, then baseline. Runs before the other visit
-- triggers (alphabetical order) and only for a caller who may write to the project (or a
-- server-side caller without a user), so a refused insert never holds another project's row.
CREATE OR REPLACE FUNCTION registry_private.lock_visit_project()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_project_permission(NEW.project_id,'write') THEN
    PERFORM 1 FROM public.projects WHERE id=NEW.project_id FOR KEY SHARE;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.lock_visit_project() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS a_registry_project_lock ON public.visits_long;
CREATE TRIGGER a_registry_project_lock BEFORE INSERT ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.lock_visit_project();

COMMENT ON COLUMN public.patients_baseline.consent_status IS
  '研究同意状态：unconfirmed 未确认；consented 已签署知情同意；waiver 伦理委员会批准免除知情同意；declined 拒绝；withdrawn 撤回同意。';
COMMENT ON COLUMN public.patients_baseline.consent_date IS
  '当前同意状态对应的日期：已同意或豁免为签署或伦理批准日期，拒绝或撤回为拒绝或撤回日期；不晚于今天（北京时间）。历次变更见字段审计记录。';
COMMENT ON COLUMN public.patients_baseline.consent_research IS
  '由 consent_status 自动生成，不可单独填写：consented/waiver 为 true，declined/withdrawn 为 false，unconfirmed 为空值（空值表示未确认，不表示否）。';
COMMENT ON COLUMN public.patients_baseline.followup_status IS
  '随访状态：active 随访中；lost 失访；withdrawn 退出研究；deceased 死亡；kidney_failure 进入肾衰竭（判定标准以研究方案为准）；transferred 转至其他机构。';
COMMENT ON COLUMN public.patients_baseline.followup_status_date IS
  '当前随访状态的变更日期，不晚于今天（北京时间）。历次变更见字段审计记录。';
COMMENT ON COLUMN public.projects.followup_interval_days IS
  '计划随访间隔（天，7–730）。默认 90 天仅用于提醒排程，应由研究负责人按研究方案确认。';
COMMENT ON COLUMN public.projects.contact_display IS
  '随访页向患者显示的研究团队联系方式，例如“研究护士 王老师”。';

-- CSV import and audited corrections may carry the explicit study status fields.
-- The derived legacy boolean is no longer an accepted input column.
CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit',
    'consent_status','consent_date','consent_version','followup_status','followup_status_date',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes']
  WHEN 'labs' THEN ARRAY['lab_date','lab_test_code','value_raw','unit_symbol','measured_at']
  ELSE NULL::text[] END;
$$;

-- "Today" and the current year are the Beijing calendar date (registry_private.local_today).
CREATE OR REPLACE FUNCTION public._registry_validate_input(p_kind text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text; v text; n numeric; d date; today date := registry_private.local_today();
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each_text(p_row) LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN
      RAISE EXCEPTION 'unsupported_column: %', k;
    END IF;
    -- Study states are explicit; "unknown" is the 'unconfirmed' state, never NULL.
    IF v IS NULL AND k = 'consent_status' THEN RAISE EXCEPTION 'invalid_consent_status'; END IF;
    IF v IS NULL AND k = 'followup_status' THEN RAISE EXCEPTION 'invalid_followup_status'; END IF;
    IF v IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(p_row->k) IN ('object','array') THEN RAISE EXCEPTION 'scalar_value_required: %',k; END IF;
    IF k IN ('patient_code','sex','baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date',
      'baseline_upcr_unit','baseline_upcr_original_unit','ln_class','treatment_arm','randomization_id','notes','lab_test_code','unit_symbol','measured_at',
      'consent_status','consent_date','consent_version','followup_status','followup_status_date')
      AND jsonb_typeof(p_row->k)<>'string' THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
    IF k IN ('birth_year','baseline_scr','baseline_upcr','baseline_upcr_raw','sbp','dbp','scr_umol_l','upcr','egfr',
             'oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','value_raw') THEN
      n := v::numeric;
      IF n::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'non_finite_number: %', k; END IF;
      IF k <> 'value_raw' AND n < 0 THEN RAISE EXCEPTION 'negative_value: %',k; END IF;
      IF k IN ('baseline_scr','scr_umol_l') AND n <= 0 THEN RAISE EXCEPTION 'creatinine_must_be_positive'; END IF;
      IF k = 'birth_year' AND (n <> trunc(n) OR n < 1900 OR n > extract(year FROM today)) THEN
        RAISE EXCEPTION 'invalid_birth_year';
      END IF;
      IF k LIKE 'oxford_%' AND (n <> trunc(n) OR n > CASE WHEN k IN ('oxford_t','oxford_c') THEN 2 ELSE 1 END) THEN
        RAISE EXCEPTION 'invalid_oxford_score: %',k;
      END IF;
      IF k IN ('ln_activity_index','ln_chronicity_index') AND (n <> trunc(n) OR n > CASE k WHEN 'ln_activity_index' THEN 24 ELSE 12 END) THEN
        RAISE EXCEPTION 'invalid_ln_score: %',k;
      END IF;
    END IF;
    IF k IN ('baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date','consent_date','followup_status_date') THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END IF;
      -- An impossible calendar date (e.g. 2025-02-30) is an input error, not a server error.
      BEGIN d := v::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END;
      IF d::text <> v OR d > today THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
    END IF;
    IF k = 'patient_code' AND (length(v) NOT BETWEEN 1 AND 64 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_patient_code';
    END IF;
    IF k = 'sex' AND v NOT IN ('M','F') THEN RAISE EXCEPTION 'invalid_sex'; END IF;
    IF k = 'notes' AND length(v) > 500 THEN RAISE EXCEPTION 'notes_too_long'; END IF;
    IF k = 'consent_status' AND v NOT IN ('unconfirmed','consented','waiver','declined','withdrawn') THEN
      RAISE EXCEPTION 'invalid_consent_status';
    END IF;
    IF k = 'followup_status' AND v NOT IN ('active','lost','withdrawn','deceased','kidney_failure','transferred') THEN
      RAISE EXCEPTION 'invalid_followup_status';
    END IF;
    IF k = 'consent_version' AND (length(v) NOT BETWEEN 1 AND 100 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_consent_version';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._registry_input_columns(text),public._registry_validate_input(text,jsonb)
  FROM PUBLIC,anon,authenticated;

-- 0036's CSV import, unchanged except for study status. A row may create a patient with,
-- or move a patient to, unconfirmed/consented/waiver consent and an active/lost/
-- transferred/kidney_failure follow-up status. It may not create a patient who has left
-- the study (declined/withdrawn consent, withdrawn/deceased follow-up), move a patient
-- into or out of that state, or change the study status fields of a patient who has
-- left: those need set_patient_study_status and a stated reason. The whole batch is
-- refused (row_<n>_study_status_requires_dedicated_action: <field>); identical values are
-- not a change. Other columns of a patient who has left may still be imported.
CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
  study_keys text[] := ARRAY['consent_status','followup_status','consent_date','consent_version','followup_status_date'];
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
      IF rec_id IS NULL THEN
        k := CASE WHEN clean->>'consent_status' IN ('declined','withdrawn') THEN 'consent_status'
          WHEN clean->>'followup_status' IN ('withdrawn','deceased') THEN 'followup_status' END;
        IF k IS NOT NULL THEN
          RAISE EXCEPTION 'row_%_study_status_requires_dedicated_action: %',row_no,k
            USING HINT='新患者不能通过导入直接登记为拒绝/撤回同意、退出研究或死亡。请先导入或建立患者，再在该患者的“研究状态”中登记并填写原因；本批次未写入。';
        END IF;
      END IF;
      IF rec_id IS NOT NULL THEN
        IF clean ? 'baseline_date' AND EXISTS (
          SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=clean->>'patient_code'
            AND visit_date < (clean->>'baseline_date')::date
        ) THEN RAISE EXCEPTION 'row_%_baseline_date_after_existing_visit',row_no; END IF;
        clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,clean)))->key)
                  FROM jsonb_object_keys(clean) AS keys(key));
        SELECT s.key INTO k FROM unnest(study_keys) WITH ORDINALITY AS s(key,n)
          WHERE clean ? s.key AND clean->s.key IS DISTINCT FROM old_row->s.key ORDER BY s.n LIMIT 1;
        IF k IS NOT NULL AND (old_row->>'consent_status' IN ('declined','withdrawn')
            OR old_row->>'followup_status' IN ('withdrawn','deceased')
            OR (old_row || clean)->>'consent_status' IN ('declined','withdrawn')
            OR (old_row || clean)->>'followup_status' IN ('withdrawn','deceased')) THEN
          RAISE EXCEPTION 'row_%_study_status_requires_dedicated_action: %',row_no,k
            USING HINT='登记或撤销拒绝/撤回同意、退出研究、死亡，以及修改已退出患者的研究状态，只能在该患者的“研究状态”中操作并填写原因；本批次未写入。';
        END IF;
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

-- 0036's audited correction, unchanged except that the study status fields (consent
-- status, date and form version, follow-up status and date) are refused for every
-- patient: they are changed in set_patient_study_status. Other baseline fields of a
-- patient who has left the study may still be corrected.
CREATE OR REPLACE FUNCTION public.correct_registry_record(p_project_id uuid,p_table text,p_record_id uuid,p_changes jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE kind text; before_row jsonb; after_row jsonb; assignments text; changes jsonb := p_changes; old_reason text; k text;
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
  IF kind = 'baseline' THEN
    SELECT s.key INTO k FROM unnest(ARRAY['consent_status','followup_status','consent_date','consent_version',
      'followup_status_date']) WITH ORDINALITY AS s(key,n) WHERE changes ? s.key ORDER BY s.n LIMIT 1;
    IF k IS NOT NULL THEN
      RAISE EXCEPTION 'study_status_requires_dedicated_action: %',k
        USING HINT='研究状态（知情同意、随访状态及其日期、同意书版本）请在该患者的“研究状态”中修改，不能通过更正修改。';
    END IF;
  END IF;
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
REVOKE ALL ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) TO authenticated;

-- Consent and follow-up status changes for one patient: the only way to record that a
-- participant left the study (consent declined/withdrawn, follow-up withdrawn/deceased),
-- to undo it (e.g. consent given again) or to change the status fields of a participant
-- who has left. Those changes need a reason of at least 2 characters without identifying
-- information. Every changed field is written to field_audit_log by _registry_audit_changes.
-- Recording an exit is allowed after the account trial ends (study_exit_only_change);
-- every other change needs write entitlement.
CREATE OR REPLACE FUNCTION public.set_patient_study_status(
  p_project_id uuid,p_patient_code text,p_changes jsonb,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; changes jsonb := p_changes; clean jsonb; before_row jsonb; rec_id uuid; assignments text;
  reason text := nullif(btrim(p_reason),''); old_reason text; changed boolean := false;
  left_before boolean; left_after boolean; exit_only boolean;
  after_row public.patients_baseline%ROWTYPE;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
  -- SHARE conflicts with membership changes (NO KEY UPDATE); recheck after waiting.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR changes='{}'::jsonb THEN
    RAISE EXCEPTION 'study_status_changes_required';
  END IF;
  FOR k IN SELECT jsonb_object_keys(changes) LOOP
    IF NOT k = ANY(ARRAY['consent_status','consent_date','consent_version','followup_status','followup_status_date']) THEN
      RAISE EXCEPTION 'unsupported_column: %',k;
    END IF;
  END LOOP;
  IF changes ? 'consent_status' AND jsonb_typeof(changes->'consent_status') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_consent_status';
  END IF;
  IF changes ? 'followup_status' AND jsonb_typeof(changes->'followup_status') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_followup_status';
  END IF;
  -- An empty form field clears an optional value; it is never stored as blank text.
  FOR k IN SELECT unnest(ARRAY['consent_date','consent_version','followup_status_date']) LOOP
    IF jsonb_typeof(changes->k) = 'string' THEN
      changes := jsonb_set(changes,ARRAY[k],coalesce(to_jsonb(nullif(btrim(changes->>k),'')),'null'::jsonb));
    END IF;
  END LOOP;
  PERFORM public._registry_validate_input('baseline',changes);
  IF length(reason) > 500 THEN RAISE EXCEPTION 'reason_too_long'; END IF;
  IF public._contains_pii(coalesce(reason,'')) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  -- Baseline row first; leaving the study then locks and revokes the link rows through
  -- registry_study_exit_links, the same order a patient submission uses.
  SELECT b.id,to_jsonb(b) INTO rec_id,before_row FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code FOR UPDATE;
  IF rec_id IS NULL THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,changes)))->key)
            FROM jsonb_object_keys(changes) AS keys(key));
  left_before := before_row->>'consent_status' IN ('declined','withdrawn')
    OR before_row->>'followup_status' IN ('withdrawn','deceased');
  left_after := (before_row || clean)->>'consent_status' IN ('declined','withdrawn')
    OR (before_row || clean)->>'followup_status' IN ('withdrawn','deceased');
  IF NOT (before_row @> clean) AND (left_before OR left_after) AND coalesce(char_length(reason),0) < 2 THEN
    RAISE EXCEPTION 'study_exit_reason_required'
      USING HINT='登记或撤销拒绝/撤回同意、退出研究、死亡，以及修改已退出患者的研究状态，须说明原因（至少 2 个字，不含身份信息）。';
  END IF;
  exit_only := registry_private.study_exit_only_change(before_row,before_row || clean);
  IF NOT exit_only THEN PERFORM public.assert_project_write_allowed(p_project_id); END IF;
  IF NOT (before_row @> clean) THEN
    SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.patients_baseline,$1)).%I',key,key),',' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(clean) AS keys(key);
    old_reason := current_setting('app.registry_change_reason',true);
    PERFORM set_config('app.registry_change_reason',coalesce(reason,'研究同意或随访状态更新（未填写原因）'),true);
    -- The mark lives only for this UPDATE; the status trigger and the account write guard
    -- accept an exit-related change for this row because of it.
    INSERT INTO registry_private.study_status_rpc_rows(xact_id,record_id) VALUES(pg_current_xact_id(),rec_id);
    EXECUTE format('UPDATE public.patients_baseline SET %s WHERE id=$2 AND project_id=$3',assignments)
      USING clean,rec_id,p_project_id;
    DELETE FROM registry_private.study_status_rpc_rows WHERE xact_id=pg_current_xact_id() AND record_id=rec_id;
    PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
    changed := true;
  END IF;
  SELECT * INTO after_row FROM public.patients_baseline WHERE id=rec_id;
  RETURN jsonb_build_object('patient_code',after_row.patient_code,
    'consent_status',after_row.consent_status,'consent_date',after_row.consent_date,
    'consent_version',after_row.consent_version,'followup_status',after_row.followup_status,
    'followup_status_date',after_row.followup_status_date,'changed',changed);
END $$;

-- Project follow-up settings and patient-facing study details: owner only.
CREATE OR REPLACE FUNCTION public.set_project_settings(p_project_id uuid,p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb; t text; n numeric; clean jsonb := '{}'::jsonb;
  before_row jsonb; after_row jsonb; changed boolean := false;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'manage');
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'settings_must_be_object'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each(p_settings) LOOP
    IF k = 'followup_interval_days' THEN
      IF jsonb_typeof(v) = 'number' THEN n := (v #>> '{}')::numeric;
      ELSIF jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') ~ '^[0-9]{1,4}$' THEN n := btrim(v #>> '{}')::numeric;
      ELSE RAISE EXCEPTION 'invalid_followup_interval'; END IF;
      IF n <> trunc(n) OR n NOT BETWEEN 7 AND 730 THEN RAISE EXCEPTION 'invalid_followup_interval'; END IF;
      clean := clean || jsonb_build_object(k,n::int);
    ELSIF k IN ('public_title','institution_name','ethics_approval_no','contact_display') THEN
      IF jsonb_typeof(v) = 'null' THEN t := NULL;
      ELSIF jsonb_typeof(v) = 'string' THEN t := nullif(btrim(v #>> '{}'),'');
      ELSE RAISE EXCEPTION 'setting_text_required: %',k; END IF;
      IF t ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_setting_text: %',k; END IF;
      IF char_length(t) > (CASE k WHEN 'ethics_approval_no' THEN 80 ELSE 120 END) THEN
        RAISE EXCEPTION 'setting_too_long: %',k;
      END IF;
      clean := clean || jsonb_build_object(k,t);
    ELSE RAISE EXCEPTION 'unsupported_setting: %',k;
    END IF;
  END LOOP;
  SELECT jsonb_build_object('followup_interval_days',p.followup_interval_days,'public_title',p.public_title,
      'institution_name',p.institution_name,'ethics_approval_no',p.ethics_approval_no,'contact_display',p.contact_display)
    INTO before_row FROM public.projects p WHERE p.id=p_project_id FOR UPDATE;
  IF before_row IS NULL THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF NOT (before_row @> clean) THEN
    UPDATE public.projects p SET
      followup_interval_days=CASE WHEN clean ? 'followup_interval_days' THEN (clean->>'followup_interval_days')::int ELSE p.followup_interval_days END,
      public_title=CASE WHEN clean ? 'public_title' THEN clean->>'public_title' ELSE p.public_title END,
      institution_name=CASE WHEN clean ? 'institution_name' THEN clean->>'institution_name' ELSE p.institution_name END,
      ethics_approval_no=CASE WHEN clean ? 'ethics_approval_no' THEN clean->>'ethics_approval_no' ELSE p.ethics_approval_no END,
      contact_display=CASE WHEN clean ? 'contact_display' THEN clean->>'contact_display' ELSE p.contact_display END
    WHERE p.id=p_project_id;
    changed := true;
  END IF;
  SELECT jsonb_build_object('followup_interval_days',p.followup_interval_days,'public_title',p.public_title,
      'institution_name',p.institution_name,'ethics_approval_no',p.ethics_approval_no,'contact_display',p.contact_display)
    INTO after_row FROM public.projects p WHERE p.id=p_project_id;
  IF changed THEN
    INSERT INTO public.audit_log(project_id,actor_uid,action,details)
      VALUES(p_project_id,auth.uid(),'project_settings_updated',jsonb_build_object('before',before_row,'after',after_row));
  END IF;
  RETURN after_row || jsonb_build_object('changed',changed);
END $$;

REVOKE ALL ON FUNCTION public.set_patient_study_status(uuid,text,jsonb,text),
  public.set_project_settings(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_patient_study_status(uuid,text,jsonb,text),
  public.set_project_settings(uuid,jsonb) TO authenticated;

-- The projects in which the signed-in user holds a permission, computed once per query.
-- Exactly has_project_permission (0036): the project creator is 'owner' (every
-- permission); otherwise the project_members role decides: read = editor/analyst/viewer,
-- write and tokens = editor, export = analyst, manage = owner only; anything else and an
-- anonymous caller get no project. Executable by signed-in users only, like local_today:
-- policies and views reference it, but without USAGE on registry_private it cannot be
-- called by name or through the API.
CREATE OR REPLACE FUNCTION registry_private.project_ids_with_permission(p_permission text)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER ROWS 10
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id FROM public.projects p
   WHERE p.created_by = auth.uid() AND p_permission IN ('read','write','tokens','export','manage')
  UNION
  SELECT m.project_id FROM public.project_members m
   WHERE m.user_id = auth.uid()
     AND m.role = ANY (CASE p_permission
       WHEN 'read' THEN ARRAY['editor','analyst','viewer']
       WHEN 'write' THEN ARRAY['editor']
       WHEN 'tokens' THEN ARRAY['editor']
       WHEN 'export' THEN ARRAY['analyst']
       ELSE ARRAY[]::text[] END);
$$;
REVOKE ALL ON FUNCTION registry_private.project_ids_with_permission(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION registry_private.project_ids_with_permission(text) TO authenticated;
COMMENT ON FUNCTION registry_private.project_ids_with_permission(text) IS
  '当前登录用户具有某项权限（read/write/tokens/export/manage）的项目集合，与 has_project_permission 判断完全一致；供行级安全策略每次查询只计算一次。';

-- 0036's policies, with the same permission per command, now set-based. Each policy asked
-- has_project_permission(project_id, ...) for every row, so a board of 5,000 patients and
-- 50,000 visits exceeded the API statement timeout; a set lookup is evaluated once per query.
DO $$
DECLARE t text; rd text := 'project_id IN (SELECT registry_private.project_ids_with_permission(''read''))';
  wr text := 'project_id IN (SELECT registry_private.project_ids_with_permission(''write''))';
BEGIN
  FOREACH t IN ARRAY ARRAY['patients_baseline','visits_long','labs_long','meds_long','variants_long','events_long',
    'ktx_baseline_ext','ktx_visits_ext','project_custom_labs'] LOOP
    EXECUTE format('ALTER POLICY member_read ON public.%I USING (%s)',t,rd);
    EXECUTE format('ALTER POLICY member_insert ON public.%I WITH CHECK (%s)',t,wr);
    EXECUTE format('ALTER POLICY member_update ON public.%I USING (%s) WITH CHECK (%s)',t,wr,wr);
    EXECUTE format('ALTER POLICY member_delete ON public.%I USING (%s)',t,wr);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['data_issues','field_audit_log','visits_long_history','audit_log','project_snapshots'] LOOP
    EXECUTE format('ALTER POLICY member_read ON public.%I USING (%s)',t,rd);
  END LOOP;
END $$;
ALTER POLICY projects_select_members ON public.projects
  USING (id IN (SELECT registry_private.project_ids_with_permission('read')));
ALTER POLICY tokens_read_editors ON public.patient_tokens
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('tokens')));
ALTER POLICY security_read_editors ON public.security_audit_logs
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('tokens')));
ALTER POLICY comment_read_members ON public.data_issue_comments
  USING (EXISTS (SELECT 1 FROM public.data_issues i WHERE i.id = data_issue_comments.issue_id
    AND i.project_id IN (SELECT registry_private.project_ids_with_permission('read'))));
ALTER POLICY comment_insert_editors ON public.data_issue_comments
  WITH CHECK (created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.data_issues i
    WHERE i.id = data_issue_comments.issue_id
      AND i.project_id IN (SELECT registry_private.project_ids_with_permission('write'))));
ALTER POLICY comment_update_editors ON public.data_issue_comments
  USING (EXISTS (SELECT 1 FROM public.data_issues i WHERE i.id = data_issue_comments.issue_id
    AND i.project_id IN (SELECT registry_private.project_ids_with_permission('write'))
    AND (data_issue_comments.created_by = auth.uid()
      OR i.project_id IN (SELECT registry_private.project_ids_with_permission('manage')))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.data_issues i WHERE i.id = data_issue_comments.issue_id
    AND i.project_id IN (SELECT registry_private.project_ids_with_permission('write'))));
ALTER POLICY comment_delete_editors ON public.data_issue_comments
  USING (EXISTS (SELECT 1 FROM public.data_issues i WHERE i.id = data_issue_comments.issue_id
    AND i.project_id IN (SELECT registry_private.project_ids_with_permission('write'))
    AND (data_issue_comments.created_by = auth.uid()
      OR i.project_id IN (SELECT registry_private.project_ids_with_permission('manage')))));

-- Workbench views. security_invoker: every base table is read with the caller's
-- privileges and RLS, so another project's rows never appear and link columns are
-- empty (0/NULL) for members without link-management permission. "Today" is the
-- Beijing date. A participant who declined or withdrew consent, or whose follow-up
-- status is not active, is never due. A participant without any visit is due at
-- baseline date + interval, like everyone else.
CREATE OR REPLACE VIEW public.v_patient_followup_status WITH (security_invoker = true) AS
SELECT b.project_id,
  b.id AS patient_id,
  p.center_code,
  b.patient_code,
  b.baseline_date,
  b.consent_status,
  b.followup_status,
  coalesce(v.visit_count,0)::int AS visit_count,
  v.first_visit_date,
  v.last_visit_date,
  c.today - v.last_visit_date AS days_since_last_visit,
  d.next_due_date,
  CASE WHEN b.followup_status <> 'active' OR b.consent_status IN ('declined','withdrawn') THEN 'inactive'
    WHEN d.next_due_date IS NULL THEN 'no_visit'
    WHEN c.today > d.next_due_date THEN 'overdue'
    WHEN d.next_due_date - c.today BETWEEN 0 AND 14 THEN 'due_soon'
    WHEN coalesce(v.visit_count,0) = 0 THEN 'no_visit'
    ELSE 'ok' END AS followup_state,
  coalesce(l.active_link_count,0)::int AS active_link_count,
  r.created_at AS last_link_created_at,
  r.expires_at AS last_link_expires_at,
  v.last_patient_submission_at
FROM public.patients_baseline b
JOIN public.projects p ON p.id = b.project_id
CROSS JOIN (SELECT registry_private.local_today() AS today) c
LEFT JOIN LATERAL (
  SELECT count(*) AS visit_count, min(x.visit_date) AS first_visit_date, max(x.visit_date) AS last_visit_date,
    max(x.created_at) FILTER (WHERE x.submitted_via_token_id IS NOT NULL) AS last_patient_submission_at
  FROM public.visits_long x WHERE x.project_id = b.project_id AND x.patient_code = b.patient_code
) v ON true
CROSS JOIN LATERAL (
  SELECT coalesce(v.last_visit_date,b.baseline_date) + p.followup_interval_days AS next_due_date
) d
LEFT JOIN LATERAL (
  SELECT count(*) AS active_link_count FROM public.patient_tokens t
  WHERE t.project_id = b.project_id AND t.patient_code = b.patient_code
    AND t.active AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
    AND NOT (t.single_use AND t.used_at IS NOT NULL)
) l ON true
LEFT JOIN LATERAL (
  SELECT t.created_at, t.expires_at FROM public.patient_tokens t
  WHERE t.project_id = b.project_id AND t.patient_code = b.patient_code
  ORDER BY t.created_at DESC, t.id DESC LIMIT 1
) r ON true;

-- n_active and the due counts follow followup_state exactly: a participant who left the
-- study (consent or follow-up status) is neither active nor due.
CREATE OR REPLACE VIEW public.v_project_overview WITH (security_invoker = true) AS
SELECT p.id AS project_id,
  p.followup_interval_days,
  coalesce(f.n_patients,0)::int AS n_patients,
  coalesce(f.n_active,0)::int AS n_active,
  coalesce(v.n_visits,0)::int AS n_visits,
  coalesce(v.n_visits_30d,0)::int AS n_visits_30d,
  coalesce(v.n_core_complete_visits,0)::int AS n_core_complete_visits,
  CASE WHEN coalesce(v.n_visits,0) = 0 THEN NULL
    ELSE round(v.n_core_complete_visits::numeric / v.n_visits, 4) END AS core_completeness,
  coalesce(f.n_overdue,0)::int AS n_overdue,
  coalesce(f.n_due_soon,0)::int AS n_due_soon,
  coalesce(f.n_no_visit,0)::int AS n_no_visit,
  v.last_visit_date,
  coalesce(f.n_consent_confirmed,0)::int AS n_consent_confirmed,
  coalesce(f.n_consent_unconfirmed,0)::int AS n_consent_unconfirmed,
  coalesce(i.n_open_issues,0)::int AS n_open_issues
FROM public.projects p
CROSS JOIN (SELECT registry_private.local_today() AS today) c
LEFT JOIN LATERAL (
  SELECT count(*) AS n_patients,
    count(*) FILTER (WHERE s.followup_state <> 'inactive') AS n_active,
    count(*) FILTER (WHERE s.followup_state = 'overdue') AS n_overdue,
    count(*) FILTER (WHERE s.followup_state = 'due_soon') AS n_due_soon,
    count(*) FILTER (WHERE s.followup_state = 'no_visit') AS n_no_visit,
    count(*) FILTER (WHERE s.consent_status IN ('consented','waiver')) AS n_consent_confirmed,
    count(*) FILTER (WHERE s.consent_status = 'unconfirmed') AS n_consent_unconfirmed
  FROM public.v_patient_followup_status s WHERE s.project_id = p.id
) f ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n_visits,
    count(*) FILTER (WHERE x.visit_date >= c.today - 30) AS n_visits_30d,
    count(*) FILTER (WHERE x.visit_date IS NOT NULL AND x.sbp IS NOT NULL AND x.dbp IS NOT NULL
      AND x.scr_umol_l IS NOT NULL AND x.upcr IS NOT NULL) AS n_core_complete_visits,
    max(x.visit_date) AS last_visit_date
  FROM public.visits_long x WHERE x.project_id = p.id
) v ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n_open_issues FROM public.data_issues di
  WHERE di.project_id = p.id AND di.status NOT IN ('RESOLVED','WONT_FIX')
) i ON true;

REVOKE ALL ON public.v_patient_followup_status,public.v_project_overview FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_patient_followup_status,public.v_project_overview TO authenticated;
COMMENT ON VIEW public.v_patient_followup_status IS
  '工作台随访视图（按调用者权限，日期按北京时间）。next_due_date = 最近随访日期（无随访时为基线日期）+ 项目随访间隔；followup_state：inactive 不再提醒（随访状态不是“随访中”，或已拒绝/撤回知情同意）、overdue 已逾期、due_soon 14 天内到期、no_visit 尚无随访且未到首次应随访日期（或无基线日期）、ok。尚无随访的患者逾期或 14 天内到期时同样计为 overdue/due_soon，可用 visit_count = 0 区分。last_link_* 为最近生成的一条随访链接（含已撤销）；active_link_count 只计未过期、未撤销、未用完的链接。';
COMMENT ON VIEW public.v_project_overview IS
  '项目概览（按调用者权限，日期按北京时间）。n_active：仍在随访提醒范围内（随访中且未拒绝/撤回同意）；n_overdue/n_due_soon/n_no_visit 与 v_patient_followup_status.followup_state 一致；n_visits_30d：随访日期在最近 30 天内；core_completeness：随访日期、收缩压、舒张压、血肌酐、UPCR 均已填写的随访占比（无随访时为空）；n_open_issues：未解决的数据质控问题。';

-- Patient page context: only what the page shows or needs to decide whether it can
-- accept a submission. No project id, module, trial or subscription details are
-- returned to an anonymous link holder.
DROP FUNCTION IF EXISTS public.patient_get_context(text);
CREATE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE(project_name text,center_code text,patient_code text,sex text,birth_year int,
  can_write boolean,single_use boolean,token_expires_at timestamptz,
  public_title text,institution_name text,ethics_approval_no text,contact_display text)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.name,p.center_code,t.patient_code,b.sex,b.birth_year,
    w.can_write,t.single_use,t.expires_at,
    p.public_title,p.institution_name,p.ethics_approval_no,p.contact_display
  FROM registry_private.patient_token(p_token) t
  JOIN public.projects p ON p.id=t.project_id
  JOIN public.patients_baseline b ON b.project_id=t.project_id AND b.patient_code=t.patient_code
  CROSS JOIN LATERAL registry_private.project_write_status(p.id) w;
$$;
REVOKE ALL ON FUNCTION public.patient_get_context(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patient_get_context(text) TO anon,authenticated;

-- Frozen exports are SELECT * and already carry the new columns. Add the reviewed
-- project settings and the consent/follow-up semantics to the immutable package.
CREATE OR REPLACE FUNCTION public.create_registry_export(p_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
      'project',jsonb_build_object('id',p.id,'name',p.name,'center_code',p.center_code,'module',p.module,'registry_type',p.registry_type,
        'followup_interval_days',p.followup_interval_days,'public_title',p.public_title,
        'institution_name',p.institution_name,'ethics_approval_no',p.ethics_approval_no),
      'field_notes',jsonb_build_object(
        'consent_status','研究同意状态：unconfirmed 未确认；consented 已签署知情同意；waiver 伦理委员会批准免除知情同意；declined 拒绝；withdrawn 撤回同意。',
        'consent_research','由 consent_status 自动生成，不单独填写：consented 或 waiver 为 true，declined 或 withdrawn 为 false，unconfirmed 为空值。空值表示尚未确认，不表示“否”。数据库升级 0038 之前该列只是系统默认值 true，从未由人工填写，升级时已全部改为未确认。',
        'consent_date','当前同意状态对应的日期：已同意或豁免为签署或伦理批准日期，拒绝或撤回为拒绝或撤回日期；可为空。同一患者历次状态与日期变更见系统字段审计记录。',
        'consent_version','知情同意书版本，可为空。',
        'followup_status','随访状态：active 随访中；lost 失访；withdrawn 退出研究；deceased 死亡；kidney_failure 进入肾衰竭（判定标准以研究方案为准）；transferred 转至其他机构。',
        'followup_status_date','当前随访状态的变更日期，可为空。历次变更见系统字段审计记录。',
        'followup_interval_days','项目设置的计划随访间隔（天），用于提醒排程，不是临床判定标准。'),
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
REVOKE ALL ON FUNCTION public.create_registry_export(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_registry_export(uuid,uuid) TO authenticated;

INSERT INTO public.registry_schema_versions(version) VALUES('0038_followup_workflow') ON CONFLICT(version) DO NOTHING;
COMMIT;
