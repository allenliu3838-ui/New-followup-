-- 0049: plausibility checks, core-field QC, research-id length, patient-link
-- status, and a reviewed mark for follow-ups submitted through a link.
-- Additive and transactional. Existing research IDs longer than 64 characters
-- are not rewritten; new inserts and updates must fit. Existing visits that
-- are missing a core item or sit outside the common blood-pressure / UPCR
-- range are rechecked so the data-quality list matches the new rules.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0048_reignite_batch2') THEN
    RAISE EXCEPTION '迁移 0049 已中止：尚未执行迁移 0048。请先按顺序执行 0032–0048，需人工核对后再迁移。';
  END IF;
END $$;

-- 研究编号：与导入校验一致，1–64 个字符，不能有首尾空格或控制字符。
-- NOT VALID：已有超长编号不阻断本次迁移，看板会换行显示；再编辑该患者时须先缩短。
ALTER TABLE public.patients_baseline
  DROP CONSTRAINT IF EXISTS patients_baseline_patient_code_len;
ALTER TABLE public.patients_baseline
  ADD CONSTRAINT patients_baseline_patient_code_len
  CHECK (patient_code IS NOT NULL AND length(patient_code) BETWEEN 1 AND 64
    AND patient_code = btrim(patient_code) AND patient_code !~ '[[:cntrl:]]')
  NOT VALID;

COMMENT ON CONSTRAINT patients_baseline_patient_code_len ON public.patients_baseline IS
  '研究编号 1–64 个字符，不能含首尾空格或控制字符。已有超长编号暂不强制改写。';

-- 患者经随访链接提交的记录：工作人员核对后写入时间。空表示尚未核对。
ALTER TABLE public.visits_long
  ADD COLUMN IF NOT EXISTS staff_reviewed_at timestamptz;
COMMENT ON COLUMN public.visits_long.staff_reviewed_at IS
  '工作人员核对患者经随访链接提交的记录的时间。工作人员直接录入的记录保持为空。';

-- 常见范围（警告，不拒绝保存）与数据库硬范围（拒绝保存）分开：
-- 收缩压硬范围 40–300、舒张压 20–200、UPCR 0–50000 mg/g（既有 CHECK）。
-- 常见范围与患者填写页一致：收缩压 70–220、舒张压 40–130、UPCR ≤10000 mg/g。
CREATE OR REPLACE FUNCTION public._qc_check_visit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_baseline public.patients_baseline%ROWTYPE;
  v_missing text[] := ARRAY[]::text[];
  v_range text[] := ARRAY[]::text[];
  v_who text := '';
BEGIN
  SELECT * INTO v_baseline
  FROM public.patients_baseline
  WHERE project_id = NEW.project_id AND patient_code = NEW.patient_code;

  IF FOUND AND v_baseline.baseline_date IS NOT NULL
     AND NEW.visit_date < v_baseline.baseline_date THEN
    PERFORM public.raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'DATE_CONFLICT', 'critical',
      '随访日期（' || NEW.visit_date || '）早于基线日期（'
      || v_baseline.baseline_date || '），数据无法用于时序分析'
    );
  ELSE
    PERFORM public.resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'DATE_CONFLICT'
    );
  END IF;

  -- 核心四项：收缩压、舒张压、血肌酐、尿蛋白肌酐比。缺任何一项都要指出名称。
  IF NEW.sbp IS NULL THEN v_missing := array_append(v_missing, '收缩压'); END IF;
  IF NEW.dbp IS NULL THEN v_missing := array_append(v_missing, '舒张压'); END IF;
  IF NEW.scr_umol_l IS NULL THEN v_missing := array_append(v_missing, '血肌酐'); END IF;
  IF NEW.upcr IS NULL THEN v_missing := array_append(v_missing, '尿蛋白肌酐比（UPCR）'); END IF;
  IF cardinality(v_missing) > 0 THEN
    PERFORM public.raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_CORE_FIELD', 'warning',
      '随访记录（' || NEW.visit_date || '）缺少' || array_to_string(v_missing, '、')
      || '。核心四项（收缩压、舒张压、血肌酐、尿蛋白肌酐比）不完整，会计入“核心四项完整率”。'
    );
  ELSE
    PERFORM public.resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_CORE_FIELD'
    );
  END IF;

  -- 落在硬范围之内、但超出常见范围：允许保存，并生成质控警告。
  IF NEW.sbp IS NOT NULL AND NEW.sbp BETWEEN 40 AND 300 AND (NEW.sbp < 70 OR NEW.sbp > 220) THEN
    v_range := array_append(v_range, '收缩压 ' || trim(to_char(NEW.sbp, 'FM999990.099')) || ' mmHg 超出常见范围 70–220 mmHg');
  END IF;
  IF NEW.dbp IS NOT NULL AND NEW.dbp BETWEEN 20 AND 200 AND (NEW.dbp < 40 OR NEW.dbp > 130) THEN
    v_range := array_append(v_range, '舒张压 ' || trim(to_char(NEW.dbp, 'FM999990.099')) || ' mmHg 超出常见范围 40–130 mmHg');
  END IF;
  IF NEW.upcr IS NOT NULL AND NEW.upcr >= 0 AND NEW.upcr <= 50000 AND NEW.upcr > 10000 THEN
    v_range := array_append(v_range, '尿蛋白肌酐比 ' || trim(to_char(NEW.upcr, 'FM99999990.099')) || ' mg/g 超出常见范围（≤10000 mg/g）');
  END IF;
  IF cardinality(v_range) > 0 THEN
    PERFORM public.raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'OUT_OF_RANGE', 'warning',
      '随访记录（' || NEW.visit_date || '）' || array_to_string(v_range, '；')
      || '。请对照原始记录核对数值和单位；确认无误可保留原值并选择“接受不修复”。'
    );
  ELSE
    PERFORM public.resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'OUT_OF_RANGE'
    );
  END IF;

  -- 只在性别或出生年份确实缺失时使用这条说明，并点名缺的是哪一项。
  IF NEW.egfr IS NULL AND NEW.scr_umol_l IS NOT NULL THEN
    IF NOT FOUND OR v_baseline.sex IS NULL OR upper(v_baseline.sex) NOT IN ('M','F') THEN
      v_who := v_who || '性别';
    END IF;
    IF NOT FOUND OR v_baseline.birth_year IS NULL THEN
      v_who := v_who || CASE WHEN v_who = '' THEN '' ELSE '和' END || '出生年份';
    END IF;
    IF v_who <> '' THEN
      PERFORM public.raise_or_update_issue(
        NEW.project_id, NEW.patient_code, 'visit', NEW.id,
        'MISSING_EGFR_INPUTS', 'info',
        '有血肌酐数据，但缺少患者' || v_who || '，无法自动计算 eGFR。请在基线中补充' || v_who || '。'
      );
    ELSE
      PERFORM public.resolve_issue_if_exists(
        NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_EGFR_INPUTS'
      );
    END IF;
  ELSE
    PERFORM public.resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_EGFR_INPUTS'
    );
  END IF;

  RETURN NEW;
END;
$$;

-- 已有随访按新规则补一次质控。只碰可能命中的行；updated_at 由既有触发器刷新，不写入字段审计。
UPDATE public.visits_long v
SET updated_at = v.updated_at
WHERE v.sbp IS NULL OR v.dbp IS NULL OR v.scr_umol_l IS NULL OR v.upcr IS NULL
   OR (v.sbp IS NOT NULL AND (v.sbp < 70 OR v.sbp > 220))
   OR (v.dbp IS NOT NULL AND (v.dbp < 40 OR v.dbp > 130))
   OR (v.upcr IS NOT NULL AND v.upcr > 10000)
   OR (v.egfr IS NULL AND v.scr_umol_l IS NOT NULL);

-- 持有链接的人可以知道这条链接是过期、已撤销还是已经用过。不知道链接的人仍然只能得到“无法识别”。
CREATE OR REPLACE FUNCTION registry_private.assert_token(
  p_row public.patient_tokens, p_allow_used boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_row.id IS NULL THEN
    RAISE EXCEPTION 'token_invalid' USING ERRCODE = '42501';
  END IF;
  IF p_row.revoked_at IS NOT NULL OR NOT p_row.active THEN
    RAISE EXCEPTION 'token_revoked' USING ERRCODE = '42501';
  END IF;
  IF p_row.expires_at IS NOT NULL AND p_row.expires_at <= now() THEN
    RAISE EXCEPTION 'token_expired' USING ERRCODE = '42501';
  END IF;
  IF NOT p_allow_used AND p_row.single_use AND p_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'single_use_token_already_used' USING ERRCODE = '42501';
  END IF;
END $$;

-- 账户试用日期缺失时，用该用户仍未到期的项目试用日（取最晚的一天），避免试用期内被标成只读。
CREATE OR REPLACE FUNCTION public._account_access(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plan text; v_end timestamptz; v_quota int; v_trial timestamptz; v_admin boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.platform_admins a JOIN auth.users u ON u.email = a.email WHERE u.id = p_user_id) INTO v_admin;
  SELECT account_trial_expires_at INTO v_trial FROM public.user_profiles WHERE user_id = p_user_id;
  IF v_trial IS NULL THEN
    SELECT max(p.trial_expires_at) INTO v_trial
    FROM public.projects p
    WHERE p.created_by = p_user_id AND p.trial_enabled IS NOT FALSE AND p.trial_expires_at IS NOT NULL;
  END IF;
  IF v_admin THEN
    RETURN jsonb_build_object('plan','partner','ends_at',NULL,'quota',10000,'can_write',true,'trial_expires_at',v_trial);
  END IF;
  SELECT e.plan INTO v_plan FROM public.account_entitlements e
  WHERE e.user_id = p_user_id AND e.revoked_at IS NULL AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())
  ORDER BY CASE e.plan WHEN 'institution' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END LIMIT 1;
  SELECT CASE WHEN bool_or(ends_at IS NULL) THEN NULL ELSE max(ends_at) END, max(project_quota)
  INTO v_end, v_quota
  FROM public.account_entitlements
  WHERE user_id = p_user_id AND revoked_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now());
  RETURN jsonb_build_object(
    'plan', coalesce(v_plan,'trial'),
    'ends_at', v_end,
    'quota', coalesce(v_quota,1),
    'can_write', v_plan IS NOT NULL OR coalesce(v_trial > now(), false),
    'trial_expires_at', v_trial
  );
END $$;
REVOKE ALL ON FUNCTION public._account_access(uuid) FROM PUBLIC, anon, authenticated;

-- 创建项目时可指定随访间隔（7–730 天，默认 90）。旧的四参数调用仍然有效。
DROP FUNCTION IF EXISTS public.create_project(text, text, text, text);
CREATE FUNCTION public.create_project(
  p_name text,
  p_center_code text,
  p_module text DEFAULT 'GENERAL',
  p_description text DEFAULT NULL,
  p_followup_interval_days int DEFAULT 90
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  IF p_followup_interval_days IS NULL OR p_followup_interval_days <> trunc(p_followup_interval_days)
     OR p_followup_interval_days NOT BETWEEN 7 AND 730 THEN
    RAISE EXCEPTION 'invalid_followup_interval';
  END IF;
  INSERT INTO public.projects(name, center_code, module, registry_type, description, followup_interval_days)
  VALUES (trim(p_name), trim(p_center_code), upper(p_module), lower(p_module), p_description, p_followup_interval_days)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.create_project(text, text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_project(text, text, text, text, int) TO authenticated;

-- 项目负责人或录入协作人把患者提交的随访标为已核对。不改临床数值。
CREATE OR REPLACE FUNCTION public.mark_patient_visit_reviewed(p_project_id uuid, p_visit_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id, 'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  PERFORM set_config('app.registry_change_reason', '核对患者经随访链接提交的记录', true);
  UPDATE public.visits_long
  SET staff_reviewed_at = now()
  WHERE id = p_visit_id AND project_id = p_project_id AND submitted_via_token_id IS NOT NULL
  RETURNING staff_reviewed_at INTO v_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_patient_submission'; END IF;
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION public.mark_patient_visit_reviewed(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_patient_visit_reviewed(uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.mark_patient_visit_reviewed(uuid, uuid) IS
  '把患者经随访链接提交的一条随访标为工作人员已核对。不修改血压、肌酐或 UPCR。';

INSERT INTO public.registry_schema_versions(version) VALUES ('0049_qc_entry_review') ON CONFLICT (version) DO NOTHING;
COMMIT;
