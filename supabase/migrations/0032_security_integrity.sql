-- 0032: registry authorization, patient tokens and clinical integrity.
-- Additive migration. Existing orphans are retained by NOT VALID foreign keys.
-- Deploy together with the matching patient client (structured submit status).
BEGIN;
CREATE SCHEMA IF NOT EXISTS registry_private;
REVOKE ALL ON SCHEMA registry_private FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.registry_schema_versions (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.registry_schema_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_schema_versions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assert_project_owner(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id=p_project_id AND p.created_by=auth.uid()
  ) THEN RAISE EXCEPTION 'project_access_denied' USING ERRCODE='42501'; END IF;
END $$;

-- Authenticated API clients cannot forge authorship or creation timestamps.
-- Restore/migration sessions with an explicitly trusted database role retain
-- the ability to restore original metadata; browser users never get that role.
CREATE OR REPLACE FUNCTION public._set_created_by()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_role text:=current_setting('role',true);
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(v_role,'') NOT IN ('service_role','supabase_admin','postgres') THEN
    NEW.created_by:=auth.uid();
    NEW.created_at:=now();
  ELSIF NEW.created_by IS NULL THEN NEW.created_by:=auth.uid(); END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public._set_updated_meta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_role text:=current_setting('role',true);
BEGIN
  IF coalesce(v_role,'') NOT IN ('service_role','supabase_admin','postgres')
    AND NOT(coalesce(v_role,'')='none' AND session_user IN ('postgres','supabase_admin')) THEN
    NEW.created_by:=OLD.created_by;
    NEW.created_at:=OLD.created_at;
  END IF;
  NEW.updated_at:=now();
  NEW.updated_by:=auth.uid();
  RETURN NEW;
END $$;

-- The database remains owner-only until a complete team authorization model exists.
-- Never treat a subscription check as a project authorization check.
CREATE OR REPLACE FUNCTION public.upsert_lab_record(
  p_project_id uuid, p_patient_code text, p_lab_date date, p_lab_test_code text,
  p_value_raw numeric, p_unit_symbol text, p_measured_at timestamptz DEFAULT NULL,
  p_lab_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  IF p_value_raw IS NULL OR p_value_raw::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid_lab_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lab_test_unit_map m
    WHERE m.lab_test_code=p_lab_test_code AND m.unit_symbol=p_unit_symbol) THEN
    RAISE EXCEPTION 'unit_not_allowed';
  END IF;
  IF p_lab_id IS NULL THEN
    INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,
      lab_test_code,value_raw,unit_symbol,measured_at)
    VALUES(p_project_id,p_patient_code,p_lab_date,p_lab_test_code,p_value_raw,p_unit_symbol,
      p_lab_test_code,p_value_raw,p_unit_symbol,p_measured_at) RETURNING id INTO v_id;
  ELSE
    UPDATE public.labs_long SET lab_date=p_lab_date,lab_name=p_lab_test_code,
      lab_value=p_value_raw,lab_unit=p_unit_symbol,lab_test_code=p_lab_test_code,
      value_raw=p_value_raw,unit_symbol=p_unit_symbol,measured_at=p_measured_at
    WHERE id=p_lab_id AND project_id=p_project_id AND patient_code=p_patient_code
    RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'lab_not_found'; END IF;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 40 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 40–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 20 OR p_dbp > 200) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 20–200 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

-- A token is a bearer credential. All patient reads share one validity rule.
CREATE OR REPLACE FUNCTION registry_private.assert_token(
  p_row public.patient_tokens, p_allow_used boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_row.id IS NULL OR NOT p_row.active OR p_row.revoked_at IS NOT NULL
    OR (p_row.expires_at IS NOT NULL AND p_row.expires_at <= now())
    OR (NOT p_allow_used AND p_row.single_use AND p_row.used_at IS NOT NULL) THEN
    RAISE EXCEPTION 'token_invalid_or_expired' USING ERRCODE='42501';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION registry_private.patient_token(p_token text)
RETURNS public.patient_tokens LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token;
  PERFORM registry_private.assert_token(v_token);
  RETURN v_token;
END $$;

CREATE OR REPLACE FUNCTION registry_private.project_write_status(p_project_id uuid)
RETURNS TABLE(can_write boolean,write_block_reason text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.assert_project_write_allowed(p_project_id);
  RETURN QUERY SELECT true,NULL::text;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM IN ('subscription_required','project_not_found') THEN
    RETURN QUERY SELECT false,SQLERRM::text;
  ELSE RAISE; END IF;
END $$;

DROP FUNCTION IF EXISTS public.patient_get_context(text);
CREATE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE(project_id uuid,project_name text,center_code text,module text,
  patient_code text,sex text,birth_year int,trial_expires_at timestamptz,
  trial_grace_until timestamptz,subscription_plan text,subscription_active_until timestamptz,
  can_write boolean,write_block_reason text,single_use boolean,token_expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id,p.name,p.center_code,p.module,t.patient_code,b.sex,b.birth_year,
    p.trial_expires_at,p.trial_grace_until,p.subscription_plan,p.subscription_active_until,
    w.can_write,w.write_block_reason,t.single_use,t.expires_at
  FROM registry_private.patient_token(p_token) t
  JOIN public.projects p ON p.id=t.project_id
  JOIN public.patients_baseline b ON b.project_id=t.project_id AND b.patient_code=t.patient_code
  CROSS JOIN LATERAL registry_private.project_write_status(p.id) w;
$$;

CREATE OR REPLACE FUNCTION public.create_patient_token_v2(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 30,
  p_single_use boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token text;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 365
    OR p_single_use IS NULL THEN RAISE EXCEPTION 'invalid_token_options'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code) THEN
    RAISE EXCEPTION 'patient_not_found';
  END IF;
  v_token:=replace(gen_random_uuid()::text,'-','');
  INSERT INTO public.patient_tokens(project_id,patient_code,token,expires_at,single_use,created_by)
    VALUES(p_project_id,p_patient_code,v_token,now()+make_interval(days=>p_expires_in_days),
      p_single_use,auth.uid());
  RETURN v_token;
END $$;
-- Compatibility for existing callers; creation and owner checks are server-side.
CREATE OR REPLACE FUNCTION public.create_patient_token(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 365
) RETURNS text LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.create_patient_token_v2(p_project_id,p_patient_code,p_expires_in_days,false);
$$;

-- Revocation is always allowed for the owner, including after subscription expiry.
-- Token mutation now goes through authorized RPCs, not direct table UPDATE.
DROP TRIGGER IF EXISTS tr_tokens_trial_lock ON public.patient_tokens;
CREATE OR REPLACE FUNCTION public.revoke_patient_token(p_token text,p_revoke_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM public.assert_project_owner(v_token.project_id);
  UPDATE public.patient_tokens SET active=false,revoked_at=coalesce(revoked_at,now()),
    revoke_reason=left(p_revoke_reason,500) WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      auth.uid(),'token_revoked','INFO',jsonb_build_object('token_id',v_token.id));
END $$;

ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submission_request_id uuid;
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submitted_via_token_id uuid;
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS submission_payload_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS visits_submission_request_unique
  ON public.visits_long(project_id,patient_code,submission_request_id)
  WHERE submission_request_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.patient_submit_visit(text,date,numeric,numeric,numeric,numeric,numeric,text);
DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text);
CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
  p_token text,p_visit_date date,p_sbp numeric DEFAULT NULL,p_dbp numeric DEFAULT NULL,
  p_scr_umol_l numeric DEFAULT NULL,p_upcr numeric DEFAULT NULL,p_egfr numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,p_request_id uuid DEFAULT NULL
) RETURNS TABLE(visit_id uuid,server_time timestamptz,receipt_token text,
  receipt_expires_at timestamptz,status text,message text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_token public.patient_tokens%ROWTYPE;
  v_existing public.visits_long%ROWTYPE;
  v_receipt public.visit_receipts%ROWTYPE;
  v_id uuid; v_hash text; v_count int; v_status text; v_message text;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM registry_private.assert_token(v_token,true);
  v_hash:=encode(sha256(convert_to(jsonb_build_array(p_visit_date,p_sbp,p_dbp,
    p_scr_umol_l,p_upcr,p_egfr,coalesce(p_notes,''))::text,'UTF8')),'hex');
  -- A successful same-request retry returns the existing receipt, never another row.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.visits_long v
      WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code
        AND v.submission_request_id=p_request_id;
    IF FOUND THEN
      IF v_existing.submitted_via_token_id IS DISTINCT FROM v_token.id
        OR v_existing.submission_payload_hash IS DISTINCT FROM v_hash THEN
        RAISE EXCEPTION 'idempotency_conflict';
      END IF;
      SELECT * INTO v_receipt FROM public.visit_receipts r WHERE r.visit_id=v_existing.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'receipt_not_available'; END IF;
      RETURN QUERY SELECT v_existing.id,v_existing.created_at,v_receipt.receipt_token,
        v_receipt.expires_at,'submitted'::text,'已提交，无需重复录入'::text;
      RETURN;
    END IF;
  END IF;
  PERFORM registry_private.assert_token(v_token);
  -- Serialize all token submissions for this patient, including different links.
  PERFORM 1 FROM public.patients_baseline b WHERE b.project_id=v_token.project_id
    AND b.patient_code=v_token.patient_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  PERFORM public.assert_project_write_allowed(v_token.project_id);
  IF p_visit_date IS NULL THEN RAISE EXCEPTION 'missing_visit_date'; END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields';
  END IF;
  IF p_sbp::text IN ('NaN','Infinity','-Infinity') OR p_dbp::text IN ('NaN','Infinity','-Infinity')
    OR p_scr_umol_l::text IN ('NaN','Infinity','-Infinity') OR p_upcr::text IN ('NaN','Infinity','-Infinity')
    OR p_egfr::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'invalid_numeric_value'; END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp>=p_sbp THEN
    RAISE EXCEPTION 'invalid_blood_pressure'; END IF;
  IF public._contains_pii(coalesce(p_notes,'')) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  IF length(coalesce(p_notes,''))>500 THEN RAISE EXCEPTION 'notes_too_long'; END IF;
  SELECT count(*) INTO v_count FROM public.visits_long v
    WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code
      AND v.created_at>now()-interval '1 minute';
  IF v_count>=12 THEN v_status:='rate_limited'; v_message:='提交过于频繁，链接已停用，请联系研究人员。';
  ELSE
    SELECT count(*) INTO v_count FROM public.visits_long v
      WHERE v.project_id=v_token.project_id AND v.patient_code=v_token.patient_code AND v.visit_date=p_visit_date;
    IF v_count>=6 THEN v_status:='same_day_limit_exceeded'; v_message:='同一日期已达到提交上限，链接已停用，请联系研究人员。'; END IF;
  END IF;
  IF v_status IS NOT NULL THEN
    UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason=v_status WHERE id=v_token.id;
    INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
      VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
        v_status,'HIGH',jsonb_build_object('count',v_count));
    -- Return, do not RAISE: the revocation and audit must commit.
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,v_status,v_message;
    RETURN;
  END IF;
  INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,
    egfr,egfr_formula_version,notes,submission_request_id,submitted_via_token_id,submission_payload_hash)
    VALUES(v_token.project_id,v_token.patient_code,p_visit_date,p_sbp,p_dbp,p_scr_umol_l,p_upcr,
      NULL,'missing_inputs',coalesce(p_notes,''),p_request_id,v_token.id,v_hash)
    RETURNING id INTO v_id;
  IF v_token.single_use THEN UPDATE public.patient_tokens SET used_at=now() WHERE id=v_token.id; END IF;
  INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at)
    VALUES(v_id,replace(gen_random_uuid()::text,'-',''),now()+interval '24 hours') RETURNING * INTO v_receipt;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      'visit_submitted','INFO',jsonb_build_object('visit_id',v_id,'single_use',v_token.single_use));
  RETURN QUERY SELECT v_id,now(),v_receipt.receipt_token,v_receipt.expires_at,'submitted'::text,'提交成功'::text;
END $$;

create or replace function public.patient_list_visits(
  p_token text,
  p_limit int default 30
)
returns table (
  visit_date date,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric,
  upcr numeric,
  egfr numeric,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    v.visit_date,
    v.sbp,
    v.dbp,
    v.scr_umol_l,
    v.upcr,
    v.egfr,
    v.notes,
    v.created_at
  from registry_private.patient_token(p_token) t
  join public.visits_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.visit_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

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
set search_path = pg_catalog, public, pg_temp
as $$
  select
    l.lab_date,
    l.lab_name,
    l.lab_value,
    l.lab_unit,
    l.created_at
  from registry_private.patient_token(p_token) t
  join public.labs_long l
    on l.project_id = t.project_id and l.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by l.lab_date desc nulls last, l.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

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
set search_path = pg_catalog, public, pg_temp
as $$
  select
    m.drug_name,
    m.drug_class,
    m.dose,
    m.start_date,
    m.end_date,
    m.created_at
  from registry_private.patient_token(p_token) t
  join public.meds_long m
    on m.project_id = t.project_id and m.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by m.start_date desc nulls last, m.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

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
set search_path = pg_catalog, public, pg_temp
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
  from registry_private.patient_token(p_token) t
  join public.variants_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.test_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

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
set search_path = pg_catalog, public, pg_temp
as $$
  select
    e.event_type,
    e.event_date,
    e.confirmed,
    e.source,
    e.notes,
    e.created_at
  from registry_private.patient_token(p_token) t
  join public.events_long e
    on e.project_id = t.project_id and e.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by e.event_date desc nulls last, e.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

-- Deferred validation preserves historical orphans for explicit reconciliation.
-- New and re-keyed rows must reference a baseline in the same project.
DO $$
DECLARE v_table text; v_name text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['visits_long','labs_long','meds_long','variants_long',
    'events_long','patient_tokens','ktx_baseline_ext','ktx_visits_ext'] LOOP
    v_name:=v_table||'_patient_project_fk';
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('public.'||v_table)::regclass AND conname=v_name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY(project_id,patient_code) REFERENCES public.patients_baseline(project_id,patient_code) ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID',v_table,v_name);
    END IF;
  END LOOP;
END $$;

-- Date integrity also applies to direct table writes and patient-token submissions.
-- SECURITY INVOKER is intentional: an unauthorized direct INSERT must not use a
-- trigger's error text to probe another project's baseline or visit existence.
CREATE OR REPLACE FUNCTION registry_private.check_research_dates()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_baseline_date date;
BEGIN
  IF TG_TABLE_NAME='patients_baseline' THEN
    IF TG_OP='UPDATE' AND NEW.baseline_date IS NOT DISTINCT FROM OLD.baseline_date THEN RETURN NEW; END IF;
    IF NEW.baseline_date>current_date THEN RAISE EXCEPTION 'future_baseline_date'; END IF;
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
    IF NEW.visit_date>current_date THEN RAISE EXCEPTION 'future_visit_date'; END IF;
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
DROP TRIGGER IF EXISTS registry_baseline_dates ON public.patients_baseline;
CREATE TRIGGER registry_baseline_dates BEFORE INSERT OR UPDATE OF baseline_date ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_research_dates();
DROP TRIGGER IF EXISTS registry_visit_dates ON public.visits_long;
CREATE TRIGGER registry_visit_dates BEFORE INSERT OR UPDATE OF visit_date,project_id,patient_code ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_research_dates();

CREATE OR REPLACE FUNCTION public._auto_compute_egfr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_sex text; v_birth_year int; v_age numeric;
BEGIN
  -- An explicitly marked manual value is distinct from a stale calculated value.
  IF NEW.egfr_formula_version='manual' AND NEW.egfr IS NOT NULL THEN RETURN NEW; END IF;
  NEW.egfr:=NULL;
  NEW.egfr_formula_version:='missing_inputs';
  SELECT b.sex,b.birth_year INTO v_sex,v_birth_year FROM public.patients_baseline b
    WHERE b.project_id=NEW.project_id AND b.patient_code=NEW.patient_code;
  IF NEW.scr_umol_l IS NULL OR NEW.scr_umol_l<=0 OR NEW.visit_date IS NULL
    OR v_sex IS NULL OR upper(v_sex) NOT IN ('M','F') OR v_birth_year IS NULL THEN RETURN NEW; END IF;
  v_age:=extract(year FROM NEW.visit_date)-v_birth_year;
  IF v_age<18 OR v_age>120 THEN RETURN NEW; END IF;
  NEW.egfr:=public.ckd_epi_2021(NEW.scr_umol_l/88.4,v_sex,v_age);
  NEW.egfr_formula_version:='CKD-EPI-2021-Cr';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_auto_egfr ON public.visits_long;
CREATE TRIGGER trg_auto_egfr BEFORE INSERT OR UPDATE OF scr_umol_l,visit_date,project_id,
  patient_code,egfr,egfr_formula_version ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION public._auto_compute_egfr();

CREATE OR REPLACE FUNCTION registry_private.refresh_patient_egfr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.sex IS DISTINCT FROM NEW.sex OR OLD.birth_year IS DISTINCT FROM NEW.birth_year THEN
    UPDATE public.visits_long SET egfr=NULL,egfr_formula_version='missing_inputs'
      WHERE project_id=NEW.project_id AND patient_code=NEW.patient_code
        AND egfr_formula_version IS DISTINCT FROM 'manual';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_baseline_refresh_egfr ON public.patients_baseline;
CREATE TRIGGER trg_baseline_refresh_egfr AFTER UPDATE OF sex,birth_year ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.refresh_patient_egfr();

-- CD19 percentage is not an absolute cell count; retain raw % and no false standard value.
-- Use the same creatinine unit convention as eGFR and the patient/staff clients.
-- This changes future normalization only; existing lab rows are not rewritten.
UPDATE public.lab_test_unit_map SET multiplier=1.0/88.4,offset_val=0
  WHERE lab_test_code='CREAT' AND unit_symbol='μmol/L';
ALTER TABLE public.labs_long ADD COLUMN IF NOT EXISTS normalization_status text NOT NULL DEFAULT 'legacy_unverified';
CREATE OR REPLACE FUNCTION public.normalize_lab_value(p_code text,p_value numeric,p_unit text)
RETURNS numeric LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_multiplier numeric; v_offset numeric;
BEGIN
  IF p_code='CD19' AND p_unit='%' THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value::text IN ('NaN','Infinity','-Infinity') THEN RETURN NULL; END IF;
  SELECT multiplier,offset_val INTO v_multiplier,v_offset FROM public.lab_test_unit_map
    WHERE lab_test_code=p_code AND unit_symbol=p_unit;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN p_value*v_multiplier+v_offset;
END $$;
CREATE OR REPLACE FUNCTION registry_private.normalize_lab_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.lab_test_code IS NULL THEN
    NEW.value_standard:=NULL;NEW.standard_unit:=NULL;NEW.normalization_status:='unmapped';
    RETURN NEW;
  END IF;
  IF NEW.value_raw IS NULL OR NEW.unit_symbol IS NULL OR NEW.value_raw::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'invalid_lab_value_or_unit'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lab_test_unit_map m WHERE m.lab_test_code=NEW.lab_test_code AND m.unit_symbol=NEW.unit_symbol) THEN
    RAISE EXCEPTION 'unit_not_allowed'; END IF;
  NEW.lab_name:=NEW.lab_test_code;NEW.lab_value:=NEW.value_raw;NEW.lab_unit:=NEW.unit_symbol;
  NEW.value_standard:=public.normalize_lab_value(NEW.lab_test_code,NEW.value_raw,NEW.unit_symbol);
  IF NEW.lab_test_code='CD19' AND NEW.unit_symbol='%' THEN
    NEW.standard_unit:=NULL;NEW.normalization_status:='not_convertible';
  ELSE
    SELECT c.standard_unit INTO NEW.standard_unit FROM public.lab_test_catalog c WHERE c.code=NEW.lab_test_code;
    NEW.normalization_status:='normalized';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_normalize_lab_row ON public.labs_long;
CREATE TRIGGER trg_normalize_lab_row BEFORE INSERT OR UPDATE OF lab_test_code,value_raw,unit_symbol,
  lab_name,lab_value,lab_unit,value_standard,standard_unit,normalization_status ON public.labs_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.normalize_lab_row();
-- Do not rewrite historical clinical rows in this migration. The deployment preflight
-- reports legacy CD19% standardized counts and stale eGFR for reviewed reconciliation.

-- Lead contacts are not a public directory of everyone who requested a demo.
DROP POLICY IF EXISTS allow_public_insert ON public.demo_requests;
DROP POLICY IF EXISTS allow_auth_select ON public.demo_requests;
DROP POLICY IF EXISTS allow_auth_update ON public.demo_requests;
CREATE POLICY demo_public_submit ON public.demo_requests FOR INSERT TO anon,authenticated
  WITH CHECK(status='pending');
CREATE POLICY demo_admin_read ON public.demo_requests FOR SELECT TO authenticated
  USING(public.is_platform_admin());
CREATE POLICY demo_admin_update ON public.demo_requests FOR UPDATE TO authenticated
  USING(public.is_platform_admin()) WITH CHECK(public.is_platform_admin());
REVOKE ALL ON public.demo_requests FROM PUBLIC,anon,authenticated;
GRANT INSERT(name,institution,department,email,contact,use_case,message) ON public.demo_requests TO anon,authenticated;
GRANT SELECT ON public.demo_requests TO authenticated;
GRANT UPDATE(status) ON public.demo_requests TO authenticated;

ALTER TABLE public.visit_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visit_receipts FROM PUBLIC,anon,authenticated;
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['concept_dictionary','abbreviation_dictionary','concept_alias_dictionary'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO anon,authenticated',v_table);
    EXECUTE format('CREATE POLICY registry_catalog_read ON public.%I FOR SELECT TO anon,authenticated USING(true)',v_table);
  END LOOP;
END $$;

-- Issue generation/resolution and field audit writes are trigger-only operations.
DROP POLICY IF EXISTS issues_project_owner ON public.data_issues;
CREATE POLICY issues_owner_read ON public.data_issues FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.projects p WHERE p.id=data_issues.project_id AND p.created_by=auth.uid()));
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.data_issues FROM PUBLIC,anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.field_audit_log FROM PUBLIC,anon,authenticated;
DROP POLICY IF EXISTS field_audit_select ON public.field_audit_log;
CREATE POLICY field_audit_select ON public.field_audit_log FOR SELECT TO authenticated
  USING(project_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=field_audit_log.project_id AND p.created_by=auth.uid()));
-- No direct token write can unset used_at, revive a revoked link or bypass single_use.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.patient_tokens FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_field_audit(p_table_name text,p_record_id uuid)
RETURNS TABLE(changed_at timestamptz,field_name text,old_value text,new_value text,changed_by uuid,change_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT a.changed_at,a.field_name,a.old_value,a.new_value,a.changed_by,a.change_reason
  FROM public.field_audit_log a JOIN public.projects p ON p.id=a.project_id
  WHERE a.table_name=p_table_name AND a.record_id=p_record_id AND p.created_by=auth.uid()
  ORDER BY a.changed_at DESC;
$$;

-- PostgreSQL gives PUBLIC EXECUTE to new functions by default. An explicit GRANT
-- to authenticated alone does not remove that anonymous path.
DO $$
DECLARE v_function record;
BEGIN
  FOR v_function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname=ANY(ARRAY[
      '_audit_baseline_fields','_audit_visit_fields','_audit_visits_long_changes','_auto_compute_egfr','_contains_pii',
      '_new_snapshot_code','_pii_guard','_qc_check_lab','_qc_check_visit','_set_created_by',
      '_set_updated_meta','_trial_block_write','admin_activate_contract','admin_adjust_trial','admin_cancel_contract',
      'admin_get_order_proofs','admin_get_visit_history','admin_list_consent_logs','admin_list_contracts','admin_list_orders',
      'admin_list_projects','admin_reject_contract','admin_reject_order','admin_reset_to_trial','admin_review_contract',
      'admin_set_expiry','admin_set_partner','admin_set_subscription','admin_update_contract','admin_verify_order',
      'apply_partner_contract','assert_project_owner','assert_project_write_allowed','check_duplicate_lab','check_jump_spike',
      'check_project_quota','ckd_epi_2021','close_issue_wont_fix','create_billing_order','create_patient_token',
      'create_patient_token_v2','create_project_snapshot','expire_old_orders','generate_order_no','get_field_audit',
      'get_issue_summary','get_my_contract','get_my_orders','is_platform_admin','list_project_snapshots',
      'lock_project_snapshot','log_consent','log_field_change','log_project_audit','normalize_lab_value',
      'patient_get_context','patient_list_events','patient_list_labs','patient_list_meds','patient_list_variants',
      'patient_list_visits','patient_submit_visit','patient_submit_visit_v2','raise_or_update_issue','resolve_issue_if_exists',
      'revoke_patient_token','search_concepts_cn','set_concept_dictionary_updated_at','submit_payment_proof','upsert_lab_record',
      'upsert_my_profile','validate_date_chain','validate_visit_record'
    ]) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon',v_function.signature);
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_function.signature::oid AND p.prosecdef) THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp',v_function.signature);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA registry_private FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.assert_project_owner(uuid),public.assert_project_write_allowed(uuid)
  FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.raise_or_update_issue(uuid,text,text,uuid,text,text,text),
  public.resolve_issue_if_exists(uuid,text,text,uuid,text),
  public.log_field_change(text,uuid,uuid,text,text,text,text,text) FROM authenticated;
-- Pure helpers used by ordinary row triggers may run without disclosing stored data.
GRANT EXECUTE ON FUNCTION public._contains_pii(text),public.ckd_epi_2021(numeric,text,numeric)
  TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
  public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
  public.create_patient_token(uuid,text,int),public.create_patient_token_v2(uuid,text,int,boolean),
  public.revoke_patient_token(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.patient_get_context(text),public.patient_list_visits(text,int),
  public.patient_list_labs(text,int),public.patient_list_meds(text,int),
  public.patient_list_variants(text,int),public.patient_list_events(text,int),
  public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text,uuid)
  TO anon,authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0032_security_integrity') ON CONFLICT DO NOTHING;
COMMIT;
