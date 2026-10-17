-- 0041: follow-up board — reminder start date for retrospective patients, bulk consent
-- confirmation. Additive, transactional and safe to re-run on existing production data.
--  * patients_baseline.followup_start_date (提醒起算日), empty for every existing patient.
--    Historical (retrospectively entered) patients were shown as overdue by thousands of
--    days because the next due date counted from a baseline date years ago. The board now
--    counts from the later of the latest visit and this date; without this date it is
--    unchanged (latest visit, otherwise baseline date). No stored value is rewritten.
--  * The date is changed only through set_followup_start_date (write permission, account
--    write entitlement, 1–500 patients per call, all or none, a stated reason of 2–500
--    characters without identifying information, not after today (Beijing), not before the
--    patient's baseline date). Import, audited correction and plain table writes are refused
--    (followup_start_date_requires_dedicated_action): the function marks the rows it updates
--    in a private table for the duration of its own UPDATE, like set_patient_study_status.
--    Every change is field-audited by _registry_audit_changes with the reason.
--  * set_consent_bulk records the same consent status, form version and date for 1–500
--    patients at once, all or none, with a stated basis (2–500 characters). Each patient goes
--    through set_patient_study_status itself, so validation, exit rules, link revocation,
--    trial exemption and field audit are exactly those of the single-patient path.
-- Lock order: projects row (FOR SHARE) first; then every requested baseline row, locked in
-- one statement in id order by both functions before anything is changed, so two bulk calls
-- on overlapping patients wait for each other instead of deadlocking; then, through the exit
-- trigger of set_patient_study_status, that patient's link rows (as every write path since 0038).
-- A reason may span several lines (tab, newline and carriage return are accepted, other
-- control characters are refused), as in the single-patient paths.
BEGIN;

-- Preconditions. Nothing below runs unless 0040 is in place and the objects this migration
-- relies on exist.
DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0040_batch_import') THEN
    RAISE EXCEPTION '迁移 0041 已中止：尚未执行迁移 0040。请先按顺序执行 0032–0040，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.v_patient_followup_status','public.v_project_overview',
      'registry_private.study_status_rpc_rows']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['public.set_patient_study_status(uuid,text,jsonb,text)',
        'registry_private.local_today()','public._contains_pii(text)']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['registry_audit_baseline','tr_patients_trial_lock','registry_study_status_checks']) AS t
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.patients_baseline'::regclass
        AND tgname=t AND NOT tgisinternal);
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0041 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0040 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Reminder start date ---------------------------------------------------------------
ALTER TABLE public.patients_baseline ADD COLUMN IF NOT EXISTS followup_start_date date;
COMMENT ON COLUMN public.patients_baseline.followup_start_date IS
  '提醒起算日：历史补录的患者从这一天开始计算下次随访（取它与最近随访日期中较晚者），不再按多年前的基线日期显示逾期。为空时按最近随访日期，无随访时按基线日期。只能经 set_followup_start_date 修改，不晚于今天（北京时间）、不早于基线日期；历次变更见字段审计记录。';

-- The baseline rows set_followup_start_date is updating, for the duration of that UPDATE
-- only (inserted and deleted inside the same transaction; empty otherwise).
CREATE TABLE IF NOT EXISTS registry_private.followup_start_rpc_rows (
  xact_id xid8 NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (xact_id,record_id)
);
ALTER TABLE registry_private.followup_start_rpc_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.followup_start_rpc_rows FROM PUBLIC,anon,authenticated;
COMMENT ON TABLE registry_private.followup_start_rpc_rows IS
  '仅在 set_followup_start_date 执行其 UPDATE 期间存在（同一事务内写入并删除），平时为空。提醒起算日检查据此确认修改来自专用入口。';

CREATE OR REPLACE FUNCTION registry_private.followup_start_rpc_active(p_record_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM registry_private.followup_start_rpc_rows r
    WHERE r.xact_id = pg_current_xact_id() AND r.record_id = p_record_id);
$$;
REVOKE ALL ON FUNCTION registry_private.followup_start_rpc_active(uuid) FROM PUBLIC,anon,authenticated;

-- Every write path (import, correction, direct table write): a new patient row carries no
-- reminder start date, and an existing one changes only from set_followup_start_date.
CREATE OR REPLACE FUNCTION registry_private.check_followup_start_date()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.followup_start_date IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.followup_start_date IS NOT DISTINCT FROM OLD.followup_start_date
    OR registry_private.followup_start_rpc_active(NEW.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'followup_start_date_requires_dedicated_action'
    USING HINT='提醒起算日只能在工作台随访看板中勾选患者后，用“设置提醒起算日”修改并填写原因；导入、更正或直接写表不能修改。';
END $$;
REVOKE ALL ON FUNCTION registry_private.check_followup_start_date() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_followup_start_checks ON public.patients_baseline;
CREATE TRIGGER registry_followup_start_checks BEFORE INSERT OR UPDATE ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_followup_start_date();

-- ---- set_followup_start_date -------------------------------------------------------------
-- Sets (or, with p_start_date NULL, clears) the reminder start date of 1–500 patients in one
-- transaction. Patients whose date already equals p_start_date are counted as unchanged.
CREATE OR REPLACE FUNCTION public.set_followup_start_date(
  p_project_id uuid,p_patient_codes text[],p_start_date date,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE reason text := btrim(p_reason); n_codes int; n_found int; n_changed int := 0; ids uuid[];
  old_reason text; today date := registry_private.local_today();
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
  -- SHARE conflicts with membership changes (NO KEY UPDATE); recheck after waiting.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  n_codes := coalesce(cardinality(p_patient_codes),0);
  IF n_codes = 0 THEN RAISE EXCEPTION 'patient_codes_required'; END IF;
  IF n_codes > 500 THEN RAISE EXCEPTION 'too_many_patients'
    USING HINT='每次最多 500 位患者，请分批操作。'; END IF;
  IF array_position(p_patient_codes,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT c) FROM unnest(p_patient_codes) AS c) <> n_codes THEN
    RAISE EXCEPTION 'invalid_patient_code_list';
  END IF;
  IF p_start_date > today THEN RAISE EXCEPTION 'invalid_or_future_date: followup_start_date'; END IF;
  IF p_start_date < DATE '1900-01-01' THEN RAISE EXCEPTION 'date_before_1900: followup_start_date'; END IF;
  IF reason IS NULL OR char_length(reason) NOT BETWEEN 2 AND 500
    OR regexp_replace(reason,'[\n\r\t]','','g') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'bulk_reason_required';
  END IF;
  IF public._contains_pii(reason) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  -- Lock every requested row (id order) before checking it.
  WITH locked AS (
    SELECT b.id,b.baseline_date,b.followup_start_date FROM public.patients_baseline b
     WHERE b.project_id=p_project_id AND b.patient_code = ANY(p_patient_codes)
     ORDER BY b.id FOR UPDATE)
  SELECT count(*),
    array_agg(id ORDER BY id) FILTER (WHERE followup_start_date IS DISTINCT FROM p_start_date)
    INTO n_found,ids FROM locked;
  IF n_found <> n_codes THEN
    RAISE EXCEPTION 'patient_not_found'
      USING HINT=format('有 %s 个研究编号未在本项目找到，请刷新看板后重试；本次没有修改。',n_codes-n_found);
  END IF;
  IF p_start_date IS NOT NULL AND EXISTS (SELECT 1 FROM public.patients_baseline b
      WHERE b.project_id=p_project_id AND b.patient_code = ANY(p_patient_codes) AND b.baseline_date > p_start_date) THEN
    RAISE EXCEPTION 'followup_start_before_baseline';
  END IF;
  IF ids IS NOT NULL THEN
    old_reason := current_setting('app.registry_change_reason',true);
    PERFORM set_config('app.registry_change_reason',reason,true);
    INSERT INTO registry_private.followup_start_rpc_rows(xact_id,record_id)
      SELECT pg_current_xact_id(),i FROM unnest(ids) AS i;
    UPDATE public.patients_baseline SET followup_start_date=p_start_date
      WHERE project_id=p_project_id AND id = ANY(ids);
    GET DIAGNOSTICS n_changed = ROW_COUNT;
    DELETE FROM registry_private.followup_start_rpc_rows WHERE xact_id=pg_current_xact_id();
    PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
    INSERT INTO public.audit_log(project_id,actor_uid,action,details)
      VALUES(p_project_id,auth.uid(),'followup_start_date_set',jsonb_build_object('followup_start_date',p_start_date,
        'reason',reason,'requested',n_codes,'changed',n_changed));
  END IF;
  RETURN jsonb_build_object('requested',n_codes,'changed',n_changed,'unchanged',n_codes-n_changed,
    'followup_start_date',p_start_date);
END $$;

-- ---- set_consent_bulk ----------------------------------------------------------------------
-- The same consent status (and, when given, form version and date) for 1–500 patients, all
-- or none. Each patient is updated by set_patient_study_status with the stated basis as
-- reason, in research-code order (after every row is locked in id order), exactly as the
-- single-patient dialog submits it:
--  * consent_status is always sent;
--  * consent_version only when p_version is given (NULL keeps the recorded version; an
--    empty text clears it);
--  * consent_date when p_date is given; with p_date NULL the recorded date is kept when the
--    status stays the same and cleared when it changes (the date belongs to the status, as
--    in the dialog, which empties the date field when another status is chosen).
-- An error names the patient (DETAIL) and undoes the whole call.
CREATE OR REPLACE FUNCTION public.set_consent_bulk(
  p_project_id uuid,p_patient_codes text[],p_status text,p_version text,p_date date,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE reason text := btrim(p_reason); n_codes int; n_found int; n_changed int := 0; code text; result jsonb;
  current_status text; changes jsonb; e_state text; e_message text; e_hint text;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  n_codes := coalesce(cardinality(p_patient_codes),0);
  IF n_codes = 0 THEN RAISE EXCEPTION 'patient_codes_required'; END IF;
  IF n_codes > 500 THEN RAISE EXCEPTION 'too_many_patients'
    USING HINT='每次最多 500 位患者，请分批操作。'; END IF;
  IF array_position(p_patient_codes,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT c) FROM unnest(p_patient_codes) AS c) <> n_codes THEN
    RAISE EXCEPTION 'invalid_patient_code_list';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('unconfirmed','consented','waiver','declined','withdrawn') THEN
    RAISE EXCEPTION 'invalid_consent_status';
  END IF;
  IF reason IS NULL OR char_length(reason) NOT BETWEEN 2 AND 500
    OR regexp_replace(reason,'[\n\r\t]','','g') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'bulk_reason_required';
  END IF;
  IF public._contains_pii(reason) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  -- Every requested row is locked here, in id order (exactly as set_followup_start_date
  -- locks), before any patient is changed; the per-patient updates below then run on rows
  -- this transaction already holds.
  SELECT count(*) INTO n_found FROM (SELECT b.id FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code = ANY(p_patient_codes)
    ORDER BY b.id FOR UPDATE) AS locked;
  IF n_found <> n_codes THEN
    RAISE EXCEPTION 'patient_not_found'
      USING HINT=format('有 %s 个研究编号未在本项目找到，请刷新看板后重试；本次没有修改。',n_codes-n_found);
  END IF;
  -- Patients in research-code order (the rows are already locked above).
  FOR code,current_status IN SELECT b.patient_code,b.consent_status FROM public.patients_baseline b
      WHERE b.project_id=p_project_id AND b.patient_code = ANY(p_patient_codes)
      ORDER BY b.patient_code COLLATE "C" LOOP
    changes := jsonb_build_object('consent_status',p_status);
    IF p_version IS NOT NULL THEN changes := changes || jsonb_build_object('consent_version',p_version); END IF;
    IF p_date IS NOT NULL THEN changes := changes || jsonb_build_object('consent_date',p_date::text);
    ELSIF current_status IS DISTINCT FROM p_status THEN changes := changes || jsonb_build_object('consent_date','');
    END IF;
    BEGIN
      result := public.set_patient_study_status(p_project_id,code,changes,reason);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS e_state = RETURNED_SQLSTATE, e_message = MESSAGE_TEXT, e_hint = PG_EXCEPTION_HINT;
      IF coalesce(e_hint,'') = '' THEN
        RAISE EXCEPTION USING ERRCODE = e_state, MESSAGE = e_message,
          DETAIL = format('研究编号 %s；本次没有修改任何患者。',code);
      END IF;
      RAISE EXCEPTION USING ERRCODE = e_state, MESSAGE = e_message, HINT = e_hint,
        DETAIL = format('研究编号 %s；本次没有修改任何患者。',code);
    END;
    IF (result->>'changed')::boolean THEN n_changed := n_changed+1; END IF;
  END LOOP;
  IF n_changed > 0 THEN
    INSERT INTO public.audit_log(project_id,actor_uid,action,details)
      VALUES(p_project_id,auth.uid(),'consent_bulk_set',jsonb_build_object('consent_status',p_status,
        'consent_version',nullif(btrim(coalesce(p_version,'')),''),'consent_date',p_date,'reason',reason,
        'requested',n_codes,'changed',n_changed));
  END IF;
  RETURN jsonb_build_object('requested',n_codes,'changed',n_changed,'unchanged',n_codes-n_changed,
    'consent_status',p_status);
END $$;

REVOKE ALL ON FUNCTION public.set_followup_start_date(uuid,text[],date,text),
  public.set_consent_bulk(uuid,text[],text,text,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_followup_start_date(uuid,text[],date,text),
  public.set_consent_bulk(uuid,text[],text,text,date,text) TO authenticated;
COMMENT ON FUNCTION public.set_followup_start_date(uuid,text[],date,text) IS
  '批量设置（p_start_date 为空时清除）提醒起算日：每次 1–500 位患者，全部成功或全部不改；须填写 2–500 字原因（不含身份信息）；日期不晚于今天（北京时间）、不早于基线日期；逐字段审计。';
COMMENT ON FUNCTION public.set_consent_bulk(uuid,text[],text,text,date,text) IS
  '批量登记知情同意状态、同意书版本与日期：每次 1–500 位患者，全部成功或全部不改；须填写 2–500 字依据；每位患者按 set_patient_study_status 的同一规则校验、撤销链接并逐字段审计。';

-- ---- Board view ----------------------------------------------------------------------------
-- 0038's view; the next due date counts from the later of the latest visit and the reminder
-- start date, otherwise (neither) from the baseline date. followup_start_date is appended.
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
  v.last_patient_submission_at,
  b.followup_start_date
FROM public.patients_baseline b
JOIN public.projects p ON p.id = b.project_id
CROSS JOIN (SELECT registry_private.local_today() AS today) c
LEFT JOIN LATERAL (
  SELECT count(*) AS visit_count, min(x.visit_date) AS first_visit_date, max(x.visit_date) AS last_visit_date,
    max(x.created_at) FILTER (WHERE x.submitted_via_token_id IS NOT NULL) AS last_patient_submission_at
  FROM public.visits_long x WHERE x.project_id = b.project_id AND x.patient_code = b.patient_code
) v ON true
CROSS JOIN LATERAL (
  SELECT coalesce(greatest(v.last_visit_date,b.followup_start_date),b.baseline_date) + p.followup_interval_days AS next_due_date
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

REVOKE ALL ON public.v_patient_followup_status FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_patient_followup_status TO authenticated;
COMMENT ON VIEW public.v_patient_followup_status IS
  '工作台随访视图（按调用者权限，日期按北京时间）。next_due_date = 最近随访日期与提醒起算日（followup_start_date）中较晚者 + 项目随访间隔；两者都没有时按基线日期；followup_state：inactive 不再提醒（随访状态不是“随访中”，或已拒绝/撤回知情同意）、overdue 已逾期、due_soon 14 天内到期、no_visit 尚无随访且未到首次应随访日期（或无基线日期）、ok。尚无随访的患者逾期或 14 天内到期时同样计为 overdue/due_soon，可用 visit_count = 0 区分。last_link_* 为最近生成的一条随访链接（含已撤销）；active_link_count 只计未过期、未撤销、未用完的链接。';

INSERT INTO public.registry_schema_versions(version) VALUES('0041_followup_board') ON CONFLICT(version) DO NOTHING;
COMMIT;
