-- 0049: entry and data-quality review (findings of the 2026-11 acceptance tests).
-- Additive and transactional. No stored clinical value, timestamp or existing record is changed by
-- this migration; nothing here runs over existing visits.
--  * Visit quality rules (trigger on new and edited visits): every missing core item (systolic and
--    diastolic pressure, serum creatinine, UPCR) is named; a value inside the hard database range
--    but outside the common range (systolic 70-220, diastolic 40-130 mmHg, UPCR <= 10000 mg/g) is
--    saved and raises an OUT_OF_RANGE warning; the eGFR note names what is actually missing (sex,
--    birth year, or the visit height for patients aged 1-17).
--  * Existing visits are not rechecked automatically. public.recheck_visit_quality lets a project
--    writer apply the current rules to the project's visits on purpose. It writes data-quality
--    issues only (never the visits), does not reopen issues closed as "accept, will not fix", and
--    leaves an audit_log entry.
--  * Research IDs: 1-64 characters, trimmed, no control characters (NOT VALID: an existing longer
--    ID is kept; the row must be shortened before that patient's baseline can be edited).
--  * visits_long.staff_reviewed_at: when a project writer confirmed a follow-up a patient submitted
--    through a link (public.mark_patient_visit_reviewed). Empty for staff entries. The import undo
--    comparison treats this new column like the other later columns while it is empty.
--  * Patient links: the holder of a link learns whether it was revoked, expired or already used.
--    Unknown links still get only the generic token_invalid_or_expired.
--  * public.create_project accepts the follow-up interval (7-730 days, default 90). The old
--    four-argument call keeps working through the default.
--  * Account access, plans, trials and billing are not changed.
BEGIN;

DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0048_reignite_batch2') THEN
    RAISE EXCEPTION '迁移 0049 已中止：尚未执行迁移 0048。请先按顺序执行 0032–0048，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.raise_or_update_issue(uuid,text,text,uuid,text,text,text)',
      'public.resolve_issue_if_exists(uuid,text,text,uuid,text)','public._qc_check_visit()',
      'registry_private.assert_token(public.patient_tokens,boolean)',
      'registry_private.import_record_matches(text,uuid,text)','registry_private.import_record_digest(text,uuid)',
      'public.assert_project_permission(uuid,text)','public.assert_project_write_allowed(uuid)']) AS t
    WHERE to_regprocedure(t) IS NULL;
  IF missing IS NULL AND to_regprocedure('public.create_project(text,text,text,text)') IS NULL
     AND to_regprocedure('public.create_project(text,text,text,text,integer)') IS NULL THEN
    missing := 'public.create_project';
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0049 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0048 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Research ID length -------------------------------------------------------------------------
ALTER TABLE public.patients_baseline DROP CONSTRAINT IF EXISTS patients_baseline_patient_code_len;
ALTER TABLE public.patients_baseline ADD CONSTRAINT patients_baseline_patient_code_len
  CHECK (patient_code IS NOT NULL AND char_length(patient_code) BETWEEN 1 AND 64
    AND patient_code = btrim(patient_code) AND patient_code !~ '[[:cntrl:]]')
  NOT VALID;
COMMENT ON CONSTRAINT patients_baseline_patient_code_len ON public.patients_baseline IS
  '研究编号 1–64 个字符，不能有首尾空格或控制字符。迁移前已有的超长编号保留，修改该患者基线前须先缩短编号。';

-- ---- Review mark for follow-ups a patient submitted ---------------------------------------------
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS staff_reviewed_at timestamptz;
COMMENT ON COLUMN public.visits_long.staff_reviewed_at IS
  '工作人员核对患者经随访链接提交的这条随访的时间。工作人员直接录入的记录保持为空。';

-- 0048's comparison with visits_long.staff_reviewed_at added as the newest later column.
CREATE OR REPLACE FUNCTION registry_private.import_record_matches(p_table text,p_id uuid,p_sha text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
-- True when the record still matches the fingerprint stored at import. Fingerprints are whole-row
-- JSON, so a column added after the import (newest first) is left out again while it is empty.
-- A value entered in such a column is an edit and never matches.
DECLARE r jsonb; late text[]; c text;
BEGIN
  IF p_sha IS NULL THEN RETURN false; END IF;
  IF registry_private.import_record_digest(p_table,p_id) = p_sha THEN RETURN true; END IF;
  late := CASE p_table WHEN 'visits_long' THEN ARRAY['staff_reviewed_at','weight_kg','height_cm']
    WHEN 'events_long' THEN ARRAY['los_days'] ELSE ARRAY[]::text[] END;
  IF cardinality(late) = 0 THEN RETURN false; END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id=$1',p_table) INTO r USING p_id;
  IF r IS NULL THEN RETURN false; END IF;
  FOREACH c IN ARRAY late LOOP
    IF NOT (r ? c) OR jsonb_typeof(r->c) <> 'null' THEN RETURN false; END IF;
    r := r - c;
    IF encode(sha256(convert_to(r::text,'UTF8')),'hex') = p_sha THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION registry_private.import_record_matches(text,uuid,text) FROM PUBLIC,anon,authenticated;

-- ---- Visit quality rules ------------------------------------------------------------------------
-- One rule outcome. With p_keep_wont_fix, an issue already closed as "accept, will not fix" for the
-- same record and rule is left closed instead of being raised again (manual recheck).
CREATE OR REPLACE FUNCTION registry_private.qc_visit_rule(v public.visits_long,p_rule text,p_severity text,
  p_message text,p_keep_wont_fix boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_message IS NULL THEN
    PERFORM public.resolve_issue_if_exists(v.project_id,v.patient_code,'visit',v.id,p_rule);
    RETURN;
  END IF;
  IF p_keep_wont_fix AND EXISTS (SELECT 1 FROM public.data_issues d WHERE d.project_id=v.project_id
      AND d.patient_code=v.patient_code AND d.record_type='visit' AND d.record_id=v.id
      AND d.rule_code=p_rule AND d.status='WONT_FIX') THEN
    RETURN;
  END IF;
  PERFORM public.raise_or_update_issue(v.project_id,v.patient_code,'visit',v.id,p_rule,p_severity,p_message);
END $$;
REVOKE ALL ON FUNCTION registry_private.qc_visit_rule(public.visits_long,text,text,text,boolean) FROM PUBLIC,anon,authenticated;

-- All visit rules for one row. Writes data_issues only.
CREATE OR REPLACE FUNCTION registry_private.qc_visit_check(v public.visits_long,p_keep_wont_fix boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.patients_baseline%ROWTYPE; found_b boolean; missing text[] := ARRAY[]::text[];
  out_of_range text[] := ARRAY[]::text[]; need text[] := ARRAY[]::text[]; age int; msg text;
BEGIN
  SELECT * INTO b FROM public.patients_baseline WHERE project_id=v.project_id AND patient_code=v.patient_code;
  found_b := FOUND;

  -- Follow-up date before the baseline date (rule kept from 0016).
  PERFORM registry_private.qc_visit_rule(v,'DATE_CONFLICT','critical',
    CASE WHEN found_b AND b.baseline_date IS NOT NULL AND v.visit_date < b.baseline_date THEN
      '随访日期（' || v.visit_date || '）早于基线日期（' || b.baseline_date || '），数据无法用于时序分析' END,
    p_keep_wont_fix);

  -- Core items: name every missing one.
  IF v.sbp IS NULL THEN missing := missing || '收缩压'::text; END IF;
  IF v.dbp IS NULL THEN missing := missing || '舒张压'::text; END IF;
  IF v.scr_umol_l IS NULL THEN missing := missing || '血肌酐'::text; END IF;
  IF v.upcr IS NULL THEN missing := missing || '尿蛋白肌酐比（UPCR）'::text; END IF;
  PERFORM registry_private.qc_visit_rule(v,'MISSING_CORE_FIELD','warning',
    CASE WHEN cardinality(missing) > 0 THEN
      '随访记录（' || v.visit_date || '）缺少' || array_to_string(missing,'、')
      || '。核心四项（收缩压、舒张压、血肌酐、尿蛋白肌酐比）不完整的随访不计入“核心四项完整率”。' END,
    p_keep_wont_fix);

  -- Inside the hard range (refused by CHECK otherwise) but outside the common range.
  IF v.sbp IS NOT NULL AND (v.sbp < 70 OR v.sbp > 220) THEN
    out_of_range := out_of_range || ('收缩压 ' || v.sbp::text || ' mmHg 超出常见范围 70–220 mmHg');
  END IF;
  IF v.dbp IS NOT NULL AND (v.dbp < 40 OR v.dbp > 130) THEN
    out_of_range := out_of_range || ('舒张压 ' || v.dbp::text || ' mmHg 超出常见范围 40–130 mmHg');
  END IF;
  IF v.upcr IS NOT NULL AND v.upcr > 10000 THEN
    out_of_range := out_of_range || ('尿蛋白肌酐比 ' || v.upcr::text || ' mg/g 超出常见范围（≤10000 mg/g）');
  END IF;
  PERFORM registry_private.qc_visit_rule(v,'OUT_OF_RANGE','warning',
    CASE WHEN cardinality(out_of_range) > 0 THEN
      '随访记录（' || v.visit_date || '）' || array_to_string(out_of_range,'；')
      || '。请对照原始记录核对数值和单位；确认无误可保留原值并选择“接受不修复”。' END,
    p_keep_wont_fix);

  -- eGFR not calculated although creatinine is present: say what is missing.
  msg := NULL;
  IF v.egfr IS NULL AND v.scr_umol_l IS NOT NULL THEN
    IF NOT found_b OR b.sex IS NULL OR upper(b.sex) NOT IN ('M','F') THEN need := need || '性别'::text; END IF;
    IF NOT found_b OR b.birth_year IS NULL THEN need := need || '出生年份'::text; END IF;
    IF cardinality(need) > 0 THEN
      msg := '有血肌酐数据，但缺少患者' || array_to_string(need,'和') || '，无法自动计算 eGFR。请在基线中补充'
        || array_to_string(need,'和') || '。';
    ELSE
      age := extract(year FROM v.visit_date)::int - b.birth_year;
      IF age BETWEEN 1 AND 17 AND v.height_cm IS NULL THEN
        msg := '患者随访时 ' || age || ' 岁，儿童 eGFR 按床旁 Schwartz 公式计算，需要本次随访的身高。请补充身高。';
      ELSE
        msg := '有血肌酐数据，但未能自动计算 eGFR（按出生年份计算的年龄为 ' || age
          || ' 岁）。请核对出生年份、随访日期和血肌酐。';
      END IF;
    END IF;
  END IF;
  PERFORM registry_private.qc_visit_rule(v,'MISSING_EGFR_INPUTS','info',msg,p_keep_wont_fix);
END $$;
REVOKE ALL ON FUNCTION registry_private.qc_visit_check(public.visits_long,boolean) FROM PUBLIC,anon,authenticated;

-- The 0016 trigger function now applies the rules above (same trigger trg_qc_visit).
CREATE OR REPLACE FUNCTION public._qc_check_visit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM registry_private.qc_visit_check(NEW,false);
  RETURN NEW;
END $$;

-- Apply the current rules to a project's existing visits, on purpose. Data-quality issues only.
CREATE OR REPLACE FUNCTION public.recheck_visit_quality(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v public.visits_long; n int := 0; open_before int; open_after int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  SELECT count(*) INTO open_before FROM public.data_issues
    WHERE project_id=p_project_id AND record_type='visit' AND status NOT IN ('RESOLVED','WONT_FIX');
  FOR v IN SELECT * FROM public.visits_long WHERE project_id=p_project_id ORDER BY visit_date,id LOOP
    PERFORM registry_private.qc_visit_check(v,true);
    n := n + 1;
  END LOOP;
  SELECT count(*) INTO open_after FROM public.data_issues
    WHERE project_id=p_project_id AND record_type='visit' AND status NOT IN ('RESOLVED','WONT_FIX');
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'visit_quality_rechecked',
      jsonb_build_object('visits',n,'open_visit_issues_before',open_before,'open_visit_issues_after',open_after));
  RETURN jsonb_build_object('visits',n,'open_before',open_before,'open_after',open_after);
END $$;
REVOKE ALL ON FUNCTION public.recheck_visit_quality(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.recheck_visit_quality(uuid) TO authenticated;
COMMENT ON FUNCTION public.recheck_visit_quality(uuid) IS
  '按当前质控规则重新检查本项目已有随访，只写数据质控问题，不改随访记录；已“接受不修复”的问题不重新打开。';

-- ---- Patient links: tell the holder why a link no longer works ----------------------------------
CREATE OR REPLACE FUNCTION registry_private.assert_token(
  p_row public.patient_tokens, p_allow_used boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_row.id IS NULL THEN RAISE EXCEPTION 'token_invalid' USING ERRCODE='42501'; END IF;
  IF p_row.revoked_at IS NOT NULL OR NOT p_row.active THEN
    RAISE EXCEPTION 'token_revoked' USING ERRCODE='42501';
  END IF;
  IF p_row.expires_at IS NOT NULL AND p_row.expires_at <= now() THEN
    RAISE EXCEPTION 'token_expired' USING ERRCODE='42501';
  END IF;
  IF NOT p_allow_used AND p_row.single_use AND p_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'single_use_token_already_used' USING ERRCODE='42501';
  END IF;
END $$;

-- ---- Create a project with its follow-up interval -----------------------------------------------
-- 0033's function with one more argument; the account guard trigger on projects is unchanged.
DROP FUNCTION IF EXISTS public.create_project(text,text,text,text);
CREATE OR REPLACE FUNCTION public.create_project(p_name text,p_center_code text,p_module text DEFAULT 'GENERAL',
  p_description text DEFAULT NULL,p_followup_interval_days int DEFAULT 90)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  IF p_followup_interval_days IS NULL OR p_followup_interval_days NOT BETWEEN 7 AND 730 THEN
    RAISE EXCEPTION 'invalid_followup_interval';
  END IF;
  INSERT INTO projects(name,center_code,module,registry_type,description,followup_interval_days)
  VALUES(trim(p_name),trim(p_center_code),upper(p_module),lower(p_module),p_description,p_followup_interval_days)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.create_project(text,text,text,text,int) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_project(text,text,text,text,int) TO authenticated;

-- ---- Mark a patient-submitted follow-up as reviewed ---------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_patient_visit_reviewed(p_project_id uuid,p_visit_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_at timestamptz; old_reason text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason','核对患者经随访链接提交的记录',true);
  UPDATE public.visits_long SET staff_reviewed_at=now()
    WHERE id=p_visit_id AND project_id=p_project_id AND submitted_via_token_id IS NOT NULL AND staff_reviewed_at IS NULL
    RETURNING staff_reviewed_at INTO v_at;
  IF NOT FOUND THEN
    SELECT staff_reviewed_at INTO v_at FROM public.visits_long
      WHERE id=p_visit_id AND project_id=p_project_id AND submitted_via_token_id IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_patient_submission'; END IF;
  END IF;
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION public.mark_patient_visit_reviewed(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.mark_patient_visit_reviewed(uuid,uuid) TO authenticated;
COMMENT ON FUNCTION public.mark_patient_visit_reviewed(uuid,uuid) IS
  '把患者经随访链接提交的一条随访标为工作人员已核对，再次调用返回原核对时间。不修改任何临床数值。';

INSERT INTO public.registry_schema_versions(version) VALUES('0049_qc_entry_review') ON CONFLICT(version) DO NOTHING;
COMMIT;
