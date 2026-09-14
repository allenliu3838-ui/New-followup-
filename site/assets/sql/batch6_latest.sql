-- GENERATED compatibility batch 6/6; execute all six in order, stop on error.
-- MIGRATION 032: 0030_patient_labs_meds_rpc.sql
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

-- MIGRATION 033: 0031_patient_variants_rpc.sql
-- RPC: patient_list_variants — let token-based patient view see their genetic variant records
drop function if exists public.patient_list_variants(text, int);
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
set search_path = public
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
  from public.patient_tokens t
  join public.variants_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.test_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_variants(text, int) to anon, authenticated;

-- RPC: patient_list_events — let token-based patient view see their clinical endpoint events
drop function if exists public.patient_list_events(text, int);
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
set search_path = public
as $$
  select
    e.event_type,
    e.event_date,
    e.confirmed,
    e.source,
    e.notes,
    e.created_at
  from public.patient_tokens t
  join public.events_long e
    on e.project_id = t.project_id and e.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by e.event_date desc nulls last, e.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_events(text, int) to anon, authenticated;

-- MIGRATION 034: 0032_security_integrity.sql
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

-- MIGRATION 035: 0033_billing_registration.sql
-- Billing boundaries and registration. Run transactionally after 0032.
-- Preserve existing authorizations as explicit legacy sources for human review.
BEGIN;
create table if not exists public.account_entitlements (
  source_type text not null check(source_type in ('order','contract','manual','legacy')),
  source_id text not null,
  user_id uuid not null references auth.users(id),
  plan text not null check(plan in ('pro','institution','partner')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  project_quota int not null check(project_quota between 1 and 10000),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(source_type,source_id),
  check(ends_at is null or ends_at > starts_at)
);
alter table public.account_entitlements enable row level security;
revoke all on public.account_entitlements from public,anon,authenticated;
create index if not exists account_entitlements_user_idx on public.account_entitlements(user_id);

alter table public.user_profiles add column if not exists account_trial_started_at timestamptz;
alter table public.user_profiles add column if not exists account_trial_expires_at timestamptz;
insert into public.user_profiles(user_id) select id from auth.users on conflict do nothing;
update public.user_profiles pr set
 account_trial_started_at=coalesce(pr.account_trial_started_at,(select min(trial_started_at) from public.projects where created_by=pr.user_id),(select created_at from auth.users where id=pr.user_id),now()),
 account_trial_expires_at=coalesce(pr.account_trial_expires_at,(select min(trial_expires_at) from public.projects where created_by=pr.user_id),(select created_at+interval '30 days' from auth.users where id=pr.user_id),now()+interval '30 days');

insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'order',id::text,user_id,case plan_code when 'institutional' then 'institution' else plan_code end,
 coalesce(activated_at,created_at),end_at,greatest(1,least(project_quota,10000))
from public.billing_orders where status='activated' and end_at>coalesce(activated_at,created_at)
on conflict do nothing;
insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'contract',c.id::text,c.user_id,coalesce(c.plan,c.apply_plan),coalesce(c.activated_at,c.created_at),c.expires_at,greatest(3,least(coalesce(p.project_quota,3),10000))
from public.partner_contracts c left join public.user_profiles p on p.user_id=c.user_id
where c.status='approved' and c.payment_status='paid' and (c.expires_at is null or c.expires_at>coalesce(c.activated_at,c.created_at)) on conflict do nothing;
-- Explicit legacy sources: no automatic revocation of potentially valid old purchases.
insert into public.account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
select 'legacy',p.id::text,p.created_by,case when not p.trial_enabled then 'partner' else p.subscription_plan end,
 least(p.created_at,now()-interval '1 second'),case when not p.trial_enabled then null else p.subscription_active_until end,
 greatest(3,least(coalesce(pr.project_quota,3),10000))
from public.projects p left join public.user_profiles pr on pr.user_id=p.created_by
where p.created_by is not null and (not p.trial_enabled or (p.subscription_plan in ('pro','institution','partner') and (p.subscription_active_until is null or p.subscription_active_until>now())))
and not exists(select 1 from public.account_entitlements e where e.user_id=p.created_by and e.plan=p.subscription_plan and e.ends_at is not distinct from p.subscription_active_until)
on conflict do nothing;

create or replace function public._account_access(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_plan text; v_end timestamptz; v_quota int; v_trial timestamptz; v_admin boolean;
begin
 select exists(select 1 from platform_admins a join auth.users u on u.email=a.email where u.id=p_user_id) into v_admin;
 select account_trial_expires_at into v_trial from user_profiles where user_id=p_user_id;
 if v_admin then return jsonb_build_object('plan','partner','ends_at',null,'quota',10000,'can_write',true,'trial_expires_at',v_trial); end if;
 select e.plan into v_plan from account_entitlements e where e.user_id=p_user_id and e.revoked_at is null and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now())
 order by case e.plan when 'institution' then 0 when 'partner' then 1 else 2 end limit 1;
 select case when bool_or(ends_at is null) then null else max(ends_at) end,max(project_quota) into v_end,v_quota
 from account_entitlements where user_id=p_user_id and revoked_at is null and starts_at<=now() and (ends_at is null or ends_at>now());
 return jsonb_build_object('plan',coalesce(v_plan,'trial'),'ends_at',v_end,'quota',coalesce(v_quota,1),'can_write',v_plan is not null or coalesce(v_trial>now(),false),'trial_expires_at',v_trial);
end $$;
revoke all on function public._account_access(uuid) from public,anon,authenticated;

create or replace function public._sync_account_projects(p_user_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb;
begin
 v:=public._account_access(p_user_id);
 update projects set subscription_plan=v->>'plan',subscription_active_until=(v->>'ends_at')::timestamptz,
 trial_enabled=true,trial_expires_at=(v->>'trial_expires_at')::timestamptz,trial_grace_until=(v->>'trial_expires_at')::timestamptz+interval '7 days' where created_by=p_user_id;
 update user_profiles set project_quota=(v->>'quota')::int,updated_at=now() where user_id=p_user_id;
end $$;
revoke all on function public._sync_account_projects(uuid) from public,anon,authenticated;

create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid; v jsonb;
begin
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found'; end if;
 v:=public._account_access(v_uid);
 if not coalesce((v->>'can_write')::boolean,false) then raise exception 'subscription_required'; end if;
end $$;
revoke all on function public.assert_project_write_allowed(uuid) from public,anon,authenticated;

-- Broad row ownership is not column authorization. Preserve safe project editing.
revoke insert,update,truncate on public.projects from public,anon,authenticated;
grant insert(name,center_code,module,registry_type,description) on public.projects to authenticated;
grant update(name,description) on public.projects to authenticated;
revoke insert,update,truncate on public.user_profiles from public,anon,authenticated;
grant update(real_name,hospital,department,interested_plan,contact,notes) on public.user_profiles to authenticated;
revoke insert,update,delete,truncate on public.billing_orders,public.billing_payment_proofs,public.billing_audit_logs from public,anon,authenticated;
drop policy if exists user_own_orders_insert on public.billing_orders;
drop policy if exists user_own_proofs_insert on public.billing_payment_proofs;

create or replace function public._create_project_account_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid; v jsonb; v_used int; v_started timestamptz;
begin
 v_uid:=auth.uid();
 if v_uid is null then
   -- Trusted SQL/service maintenance must explicitly supply a real owner.
   if current_setting('role',true) not in ('postgres','service_role','supabase_admin','none') or new.created_by is null then raise exception 'authentication_required'; end if;
   v_uid:=new.created_by;
 elsif new.created_by is not null and new.created_by<>v_uid then raise exception 'owner_mismatch'; end if;
 perform 1 from auth.users where id=v_uid for update;
 if not found then raise exception 'owner_not_found'; end if;
 insert into user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
 select id,created_at,created_at+interval '30 days' from auth.users where id=v_uid on conflict do nothing;
 update user_profiles set account_trial_started_at=coalesce(account_trial_started_at,now()),account_trial_expires_at=coalesce(account_trial_expires_at,now()+interval '30 days') where user_id=v_uid;
 v:=public._account_access(v_uid);
 select count(*) into v_used from projects where created_by=v_uid;
 if v_used >= (v->>'quota')::int then raise exception 'project_quota_exceeded'; end if;
 if not (v->>'can_write')::boolean then raise exception 'subscription_required'; end if;
 if nullif(trim(new.name),'') is null or nullif(trim(new.center_code),'') is null then raise exception 'project_name_and_center_required'; end if;
 if new.module not in ('IGAN','LN','MN','DKD','CKD','KTX','GENERAL') then raise exception 'invalid_module'; end if;
 new.created_by:=v_uid; new.subscription_plan:=v->>'plan'; new.subscription_active_until:=(v->>'ends_at')::timestamptz;
 select account_trial_started_at into v_started from user_profiles where user_id=v_uid;
 new.trial_enabled:=true;new.trial_started_at:=v_started;new.trial_expires_at:=(v->>'trial_expires_at')::timestamptz;new.trial_grace_until:=new.trial_expires_at+interval '7 days';
 return new;
end $$;
revoke all on function public._create_project_account_guard() from public,anon,authenticated;
drop trigger if exists tr_account_project_guard on public.projects;
create trigger tr_account_project_guard before insert on public.projects for each row execute function public._create_project_account_guard();

create or replace function public.create_project(p_name text,p_center_code text,p_module text default 'GENERAL',p_description text default null)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 insert into projects(name,center_code,module,registry_type,description) values(trim(p_name),trim(p_center_code),upper(p_module),lower(p_module),p_description) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.create_project(text,text,text,text) from public,anon;
grant execute on function public.create_project(text,text,text,text) to authenticated;

create or replace function public.check_project_quota()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb; v_used int;
begin
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 v:=public._account_access(auth.uid()); select count(*) into v_used from projects where created_by=auth.uid();
 return v || jsonb_build_object('used',v_used,'remaining',greatest((v->>'quota')::int-v_used,0));
end $$;
revoke all on function public.check_project_quota() from public,anon;
grant execute on function public.check_project_quota() to authenticated;

-- Only administrators issue manual authorizations. Remove owner exception.
create or replace function public.admin_set_subscription(p_project_id uuid,p_plan text,p_active_until timestamptz default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only'; end if;
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found'; end if;
 perform 1 from auth.users where id=v_uid for update;
 if p_plan is null or p_plan not in ('trial','pro','institution','partner') then raise exception 'invalid_plan'; end if;
 if p_active_until is not null and p_active_until<=now() then raise exception 'future_expiry_required'; end if;
 update account_entitlements set revoked_at=now() where user_id=v_uid and source_type in ('manual','legacy');
 if p_plan<>'trial' then
 insert into account_entitlements(source_type,source_id,user_id,plan,ends_at,project_quota)
 values('manual',v_uid::text,v_uid,p_plan,p_active_until,3)
 on conflict(source_type,source_id) do update set plan=excluded.plan,starts_at=now(),ends_at=excluded.ends_at,revoked_at=null,updated_at=now();
 end if;
 perform public._sync_account_projects(v_uid);
end $$;
revoke all on function public.admin_set_subscription(uuid,text,timestamptz) from public,anon;
grant execute on function public.admin_set_subscription(uuid,text,timestamptz) to authenticated;

create or replace function public.admin_set_partner(p_project_id uuid,p_active_until timestamptz default '2099-12-31 23:59:59+00')
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.admin_set_subscription(p_project_id,'partner',p_active_until); end $$;
create or replace function public.admin_reset_to_trial(p_project_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.admin_set_subscription(p_project_id,'trial',null); end $$;
create or replace function public.admin_set_expiry(p_project_id uuid,p_expires_at timestamptz,p_plan text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;v_plan text;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select created_by,subscription_plan into v_uid,v_plan from projects where id=p_project_id;
 if not found then raise exception 'project_not_found';end if;
 if p_expires_at is null or p_expires_at<=now() then raise exception 'future_expiry_required';end if;
 if coalesce(p_plan,v_plan)='trial' then
 update user_profiles set account_trial_expires_at=p_expires_at where user_id=v_uid;
 perform public._sync_account_projects(v_uid);
 else perform public.admin_set_subscription(p_project_id,coalesce(p_plan,v_plan),p_expires_at);end if;
end $$;
create or replace function public.admin_adjust_trial(p_project_id uuid,p_extra_days int default 30)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid;v jsonb;v_until timestamptz;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 if p_extra_days is null or p_extra_days not between 1 and 365 then raise exception 'invalid_extension_days';end if;
 select created_by into v_uid from projects where id=p_project_id;
 if not found then raise exception 'project_not_found';end if;
 perform 1 from auth.users where id=v_uid for update;v:=public._account_access(v_uid);
 if v->>'plan'='trial' then
 update user_profiles set account_trial_expires_at=greatest(account_trial_expires_at,now())+make_interval(days=>p_extra_days) where user_id=v_uid;
 perform public._sync_account_projects(v_uid);
 else
 if v->>'ends_at' is null then return;end if;
 v_until:=(v->>'ends_at')::timestamptz+make_interval(days=>p_extra_days);
 perform public.admin_set_subscription(p_project_id,v->>'plan',v_until);
 end if;
end $$;

-- Reject unsupported institutional self-service; keep old signature as a guarded wrapper.
create or replace function public.create_billing_order(
 p_plan_code text,p_billing_cycle text,p_extra_projects int default 0,p_payment_method text default null,
 p_payer_name text default null,p_payer_email text default null,p_payer_hospital text default null,p_payer_phone text default null,
 p_invoice_needed boolean default false,p_invoice_type text default 'company',p_invoice_title text default null,p_invoice_tax_no text default null,p_invoice_email text default null,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;v_no text;v_amount numeric;v_extra int;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_plan_code is distinct from 'pro' then raise exception 'institution_requires_quote';end if;
 if p_billing_cycle is null or p_billing_cycle not in ('monthly','yearly') then raise exception 'invalid_billing_cycle';end if;
 if p_extra_projects is null or p_extra_projects not between 0 and 27 then raise exception 'invalid_project_count';end if;
 if p_payment_method is not null and p_payment_method not in ('wechat_qr','alipay_qr','bank_transfer') then raise exception 'invalid_payment_method';end if;
 if p_invoice_type is null or p_invoice_type not in ('company','personal') then raise exception 'invalid_invoice_type';end if;
 if p_invoice_needed and (nullif(trim(p_invoice_title),'') is null or nullif(trim(p_invoice_email),'') is null or (p_invoice_type='company' and nullif(trim(p_invoice_tax_no),'') is null)) then raise exception 'invoice_fields_required';end if;
 perform 1 from auth.users where id=auth.uid() for update;
 if (select count(*) from billing_orders where user_id=auth.uid() and created_at>now()-interval '15 minutes')>=5 then raise exception 'order_rate_limited';end if;
 v_extra:=p_extra_projects;v_amount:=case when p_billing_cycle='monthly' then 499+99*v_extra else 4790+950*v_extra end;v_no:=generate_order_no();
 insert into billing_orders(order_no,user_id,plan_code,billing_cycle,project_quota,extra_projects,amount_due,payment_method,payer_name,payer_email,payer_hospital,payer_phone,invoice_needed,invoice_type,invoice_title,invoice_tax_no,invoice_email,invoice_status,notes)
 values(v_no,auth.uid(),'pro',p_billing_cycle,3+v_extra,v_extra,v_amount,p_payment_method,p_payer_name,p_payer_email,p_payer_hospital,p_payer_phone,coalesce(p_invoice_needed,false),p_invoice_type,p_invoice_title,p_invoice_tax_no,p_invoice_email,case when p_invoice_needed then 'requested' else 'none' end,p_notes) returning id into v_id;
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(v_id,'created',auth.uid(),jsonb_build_object('amount_due',v_amount,'project_quota',3+v_extra));
 return jsonb_build_object('order_id',v_id,'order_no',v_no,'amount_due',v_amount,'project_quota',3+v_extra);
end $$;
drop function if exists public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text);
revoke all on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text,text) from public,anon;
grant execute on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text,text) to authenticated;

-- Persist keys, never client-provided URLs. Both order ownership and object existence are required.
create or replace function public.submit_payment_proof(p_order_id uuid,p_file_url text,p_file_name text default null,p_file_type text default null,p_amount_paid numeric default null,p_payment_method text default null,p_payer_name text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order billing_orders%rowtype;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 select * into v_order from billing_orders where id=p_order_id and user_id=auth.uid() for update;
 if not found or v_order.status not in ('unpaid','rejected') then raise exception 'order_not_found_or_not_payable';end if;
 if p_amount_paid is null or p_amount_paid<=0 then raise exception 'positive_paid_amount_required';end if;
 if p_file_url is null or p_file_url !~ ('^'||auth.uid()::text||'/'||p_order_id::text||'/[a-zA-Z0-9._-]+$') then raise exception 'invalid_proof_key';end if;
 if not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=p_file_url) then raise exception 'proof_object_not_found';end if;
 if exists(select 1 from billing_payment_proofs where order_id=p_order_id and file_url=p_file_url) then raise exception 'proof_already_submitted';end if;
 insert into billing_payment_proofs(order_id,file_url,file_name,file_type,uploaded_by) values(p_order_id,p_file_url,left(p_file_name,200),p_file_type,auth.uid());
 update billing_orders set status='pending_verification',submitted_at=now(),amount_paid=p_amount_paid,payment_method=coalesce(p_payment_method,payment_method),payer_name=coalesce(p_payer_name,payer_name),updated_at=now() where id=p_order_id;
 insert into billing_audit_logs(order_id,action,operator_user_id) values(p_order_id,'proof_uploaded',auth.uid());
end $$;
revoke all on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) from public,anon;
grant execute on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) to authenticated;

update storage.buckets set public=false,file_size_limit=10485760,allowed_mime_types=array['image/png','image/jpeg','image/webp','application/pdf'] where id='payment-proofs';
drop policy if exists payment_proofs_insert_own on storage.objects;
create policy payment_proofs_insert_own on storage.objects for insert to authenticated with check(
 bucket_id='payment-proofs' and (storage.foldername(name))[1]=auth.uid()::text and exists(select 1 from billing_orders o where o.id::text=(storage.foldername(name))[2] and o.user_id=auth.uid() and o.status in ('unpaid','rejected')));
drop policy if exists payment_proofs_select_own on storage.objects;
create policy payment_proofs_select_own on storage.objects for select to authenticated using(
 bucket_id='payment-proofs' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_platform_admin()));
drop policy if exists payment_proofs_delete_own on storage.objects;
create policy payment_proofs_delete_own on storage.objects for delete to authenticated using(
 bucket_id='payment-proofs' and (storage.foldername(name))[1]=auth.uid()::text and not exists(select 1 from billing_payment_proofs p where p.file_url=name));

create or replace function public.admin_verify_order(p_order_id uuid,p_start_at timestamptz default null,p_end_at timestamptz default null,p_admin_notes text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o billing_orders%rowtype;v_uid uuid;v_start timestamptz;v_end timestamptz;v_existing timestamptz;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select user_id into v_uid from billing_orders where id=p_order_id;if not found then raise exception 'order_not_found';end if;
 perform 1 from auth.users where id=v_uid for update;
 select * into o from billing_orders where id=p_order_id for update;
 if o.status='activated' then return;end if;
 if o.status<>'pending_verification' then raise exception 'order_not_pending';end if;
 if not exists(select 1 from billing_payment_proofs where order_id=o.id) then raise exception 'payment_proof_required';end if;
 if o.amount_paid is null or o.amount_paid<o.amount_due then raise exception 'payment_amount_insufficient';end if;
 select max(ends_at) into v_existing from account_entitlements where user_id=o.user_id and revoked_at is null and ends_at>now();
 v_start:=coalesce(p_start_at,greatest(v_existing,now()));
 v_end:=coalesce(p_end_at,v_start+case when o.billing_cycle='monthly' then interval '1 month' else interval '1 year' end);
 if v_end<=v_start or v_end<=now() or (v_existing is not null and v_end<v_existing) then raise exception 'invalid_or_shortening_expiry';end if;
 update billing_orders set status='activated',paid_at=now(),activated_at=now(),start_at=v_start,end_at=v_end,admin_notes=p_admin_notes,updated_at=now() where id=o.id;
 insert into account_entitlements(source_type,source_id,user_id,plan,starts_at,ends_at,project_quota)
 values('order',o.id::text,o.user_id,case o.plan_code when 'institutional' then 'institution' else o.plan_code end,case when p_start_at is null then now() else p_start_at end,v_end,o.project_quota);
 perform public._sync_account_projects(o.user_id);
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(o.id,'activated',auth.uid(),jsonb_build_object('start_at',v_start,'end_at',v_end,'project_quota',o.project_quota));
end $$;
revoke all on function public.admin_verify_order(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.admin_verify_order(uuid,timestamptz,timestamptz,text) to authenticated;

create or replace function public.admin_set_invoice_status(p_order_id uuid,p_status text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 if p_status is null or p_status not in ('requested','issued') then raise exception 'invalid_invoice_status';end if;
 update billing_orders set invoice_status=p_status,updated_at=now() where id=p_order_id and invoice_needed and status='activated';
 if not found then raise exception 'activated_invoice_order_required';end if;
 insert into billing_audit_logs(order_id,action,operator_user_id,after_json) values(p_order_id,'invoice_status',auth.uid(),jsonb_build_object('status',p_status));
end $$;
revoke all on function public.admin_set_invoice_status(uuid,text) from public,anon;
grant execute on function public.admin_set_invoice_status(uuid,text) to authenticated;

-- Contract state changes affect this source only, preserving independent purchases.
create or replace function public._contract_entitlement_sync()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from auth.users where id=new.user_id for update;
 if new.status='approved' and new.payment_status='paid' then
 if new.expires_at is null or new.expires_at<=now() then raise exception 'future_contract_expiry_required';end if;
 insert into account_entitlements(source_type,source_id,user_id,plan,ends_at,project_quota)
 values('contract',new.id::text,new.user_id,coalesce(new.plan,new.apply_plan),new.expires_at,3)
 on conflict(source_type,source_id) do update set plan=excluded.plan,ends_at=excluded.ends_at,revoked_at=null,updated_at=now();
 else update account_entitlements set revoked_at=now(),updated_at=now() where source_type='contract' and source_id=new.id::text;end if;
 perform public._sync_account_projects(new.user_id);return new;
end $$;
revoke all on function public._contract_entitlement_sync() from public,anon,authenticated;
drop trigger if exists tr_contract_entitlement on public.partner_contracts;
create trigger tr_contract_entitlement after insert or update on public.partner_contracts for each row execute function public._contract_entitlement_sync();
create or replace function public.admin_cancel_contract(p_contract_id uuid,p_admin_note text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 update partner_contracts set status='cancelled',admin_note=coalesce(p_admin_note,admin_note),updated_at=now() where id=p_contract_id and status in ('pending','approved');
 if not found then raise exception 'contract_not_editable';end if;
end $$;
create or replace function public.admin_update_contract(p_contract_id uuid,p_payment_status text default null,p_expires_at timestamptz default null,p_plan text default null,p_annual_price numeric default null,p_discount_pct int default null,p_admin_note text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 update partner_contracts set payment_status=coalesce(p_payment_status,payment_status),expires_at=coalesce(p_expires_at,expires_at),plan=coalesce(p_plan,plan),annual_price_cny=coalesce(p_annual_price,annual_price_cny),discount_pct=coalesce(p_discount_pct,discount_pct),admin_note=coalesce(p_admin_note,admin_note),updated_at=now()
 where id=p_contract_id and status in ('pending','approved');
 if not found then raise exception 'contract_not_editable';end if;
end $$;
create or replace function public.admin_activate_contract(p_contract_id uuid,p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c partner_contracts%rowtype;
begin
 if not public.is_platform_admin() then raise exception 'platform_admin_only';end if;
 select * into c from partner_contracts where id=p_contract_id for update;
 if not found or c.status<>'approved' then raise exception 'contract_not_approved';end if;
 if c.payment_status='paid' and c.activated_at is not null then return;end if;
 update partner_contracts set payment_status='paid',paid_at=now(),activated_at=now(),expires_at=coalesce(p_expires_at,now()+interval '1 year'),updated_at=now() where id=c.id;
end $$;

-- Registered consent is attributable and version allowlisted. Not a signature/ethics approval.
alter table public.consent_logs alter column policy_version set default 'v2.0';
create or replace function public.log_consent(p_action text,p_policy_type text default 'both',p_policy_version text default 'v2.0',p_ip_address text default null,p_user_agent text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_action not in ('register','checkout','profile_submit','contract_apply') or p_policy_type not in ('terms','privacy','both') or p_policy_version<>'v2.0' then raise exception 'invalid_consent_version_or_action';end if;
 insert into consent_logs(user_id,action,policy_type,policy_version,ip_address,user_agent) values(auth.uid(),p_action,p_policy_type,p_policy_version,null,left(p_user_agent,1000));
end $$;
revoke insert on public.consent_logs from public,anon,authenticated;
revoke all on function public.log_consent(text,text,text,text,text) from public,anon;
grant execute on function public.log_consent(text,text,text,text,text) to authenticated;
revoke all on function public.expire_old_orders() from public,anon,authenticated;
grant execute on function public.expire_old_orders() to service_role;

-- New/overridden callable routines require an explicit authenticated grant plus internal checks.
revoke all on function public.admin_set_partner(uuid,timestamptz),public.admin_reset_to_trial(uuid),public.admin_set_expiry(uuid,timestamptz,text),public.admin_adjust_trial(uuid,int),public.admin_cancel_contract(uuid,text),public.admin_update_contract(uuid,text,timestamptz,text,numeric,int,text),public.admin_activate_contract(uuid,timestamptz) from public,anon;
grant execute on function public.admin_set_partner(uuid,timestamptz),public.admin_reset_to_trial(uuid),public.admin_set_expiry(uuid,timestamptz,text),public.admin_adjust_trial(uuid,int),public.admin_cancel_contract(uuid,text),public.admin_update_contract(uuid,text,timestamptz,text,numeric,int,text),public.admin_activate_contract(uuid,timestamptz) to authenticated;

create table if not exists public.account_entitlement_audit (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,
 source_type text not null,source_id text not null,operation text not null,
 changed_by uuid,changed_at timestamptz not null default now(),old_row jsonb,new_row jsonb
);
alter table public.account_entitlement_audit enable row level security;
revoke all on public.account_entitlement_audit from public,anon,authenticated;
create or replace function public._audit_account_entitlements() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into account_entitlement_audit(user_id,source_type,source_id,operation,changed_by,old_row,new_row)
 values(new.user_id,new.source_type,new.source_id,tg_op,auth.uid(),case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));return new;
end $$;
revoke all on function public._audit_account_entitlements() from public,anon,authenticated;
create trigger tr_account_entitlement_audit after insert or update on public.account_entitlements for each row execute function public._audit_account_entitlements();
insert into public.registry_schema_versions(version) values('0033_billing_registration') on conflict do nothing;
COMMIT;

-- MIGRATION 036: 0034_import_corrections.sql
-- Transactional imports, explicit units and auditable corrections.
-- Historical ambiguous UPCR values are deliberately NOT relabelled or converted.
BEGIN;

ALTER TABLE public.patients_baseline
  ADD COLUMN IF NOT EXISTS baseline_upcr_unit text,
  ADD COLUMN IF NOT EXISTS baseline_upcr_raw numeric,
  ADD COLUMN IF NOT EXISTS baseline_upcr_original_unit text,
  ADD COLUMN IF NOT EXISTS qc_reason text;

CREATE OR REPLACE FUNCTION public._registry_check_baseline_upcr()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.baseline_upcr, NEW.baseline_upcr_unit, NEW.baseline_upcr_raw, NEW.baseline_upcr_original_unit)
       IS NOT DISTINCT FROM ROW(OLD.baseline_upcr, OLD.baseline_upcr_unit, OLD.baseline_upcr_raw, OLD.baseline_upcr_original_unit) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.baseline_upcr IS NULL THEN
    NEW.baseline_upcr_unit := NULL;
    NEW.baseline_upcr_raw := NULL;
    NEW.baseline_upcr_original_unit := NULL;
    RETURN NEW;
  END IF;
  IF NEW.baseline_upcr::text IN ('NaN','Infinity','-Infinity')
     OR NEW.baseline_upcr_raw IS NULL OR NEW.baseline_upcr_raw::text IN ('NaN','Infinity','-Infinity')
     OR NEW.baseline_upcr < 0 OR NEW.baseline_upcr_raw < 0
     OR NEW.baseline_upcr_unit IS DISTINCT FROM 'mg/g'
     OR NEW.baseline_upcr_original_unit IS NULL
     OR NEW.baseline_upcr_original_unit NOT IN ('mg/g','g/g') THEN
    RAISE EXCEPTION 'baseline_upcr_unit_required'
      USING HINT = '新录入或更正UPCR须同时提供原值、原单位及标准mg/g值；历史未知单位不可猜测。';
  END IF;
  IF abs(NEW.baseline_upcr - NEW.baseline_upcr_raw *
       CASE NEW.baseline_upcr_original_unit WHEN 'g/g' THEN 1000 ELSE 1 END)
       > abs(NEW.baseline_upcr_raw * CASE NEW.baseline_upcr_original_unit WHEN 'g/g' THEN 1000 ELSE 1 END) * 0.000000000001 THEN
    RAISE EXCEPTION 'baseline_upcr_conversion_mismatch';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS registry_baseline_upcr_units ON public.patients_baseline;
CREATE TRIGGER registry_baseline_upcr_units BEFORE INSERT OR UPDATE ON public.patients_baseline
FOR EACH ROW EXECUTE FUNCTION public._registry_check_baseline_upcr();

CREATE TABLE IF NOT EXISTS public.registry_import_batches (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('baseline','visits')),
  content_sha256 text NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,batch_id)
);
CREATE TABLE IF NOT EXISTS public.registry_import_records (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('baseline','visits')),
  content_sha256 text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,kind,content_sha256)
);
ALTER TABLE public.registry_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registry_import_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registry_import_batches, public.registry_import_records FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit','consent_research',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes']
  WHEN 'labs' THEN ARRAY['lab_date','lab_test_code','value_raw','unit_symbol','measured_at']
  ELSE NULL::text[] END;
$$;

CREATE OR REPLACE FUNCTION public._registry_validate_input(p_kind text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text; v text; n numeric; d date;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each_text(p_row) LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN
      RAISE EXCEPTION 'unsupported_column: %', k;
    END IF;
    IF v IS NULL THEN CONTINUE; END IF;
    IF jsonb_typeof(p_row->k) IN ('object','array') THEN RAISE EXCEPTION 'scalar_value_required: %',k; END IF;
    IF k IN ('patient_code','sex','baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date',
      'baseline_upcr_unit','baseline_upcr_original_unit','ln_class','treatment_arm','randomization_id','notes','lab_test_code','unit_symbol','measured_at')
      AND jsonb_typeof(p_row->k)<>'string' THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
    IF k IN ('birth_year','baseline_scr','baseline_upcr','baseline_upcr_raw','sbp','dbp','scr_umol_l','upcr','egfr',
             'oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','value_raw') THEN
      n := v::numeric;
      IF n::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'non_finite_number: %', k; END IF;
      IF k <> 'value_raw' AND n < 0 THEN RAISE EXCEPTION 'negative_value: %',k; END IF;
      IF k IN ('baseline_scr','scr_umol_l') AND n <= 0 THEN RAISE EXCEPTION 'creatinine_must_be_positive'; END IF;
      IF k = 'birth_year' AND (n <> trunc(n) OR n < 1900 OR n > extract(year FROM current_date)) THEN
        RAISE EXCEPTION 'invalid_birth_year';
      END IF;
      IF k LIKE 'oxford_%' AND (n <> trunc(n) OR n > CASE WHEN k IN ('oxford_t','oxford_c') THEN 2 ELSE 1 END) THEN
        RAISE EXCEPTION 'invalid_oxford_score: %',k;
      END IF;
      IF k IN ('ln_activity_index','ln_chronicity_index') AND (n <> trunc(n) OR n > CASE k WHEN 'ln_activity_index' THEN 24 ELSE 12 END) THEN
        RAISE EXCEPTION 'invalid_ln_score: %',k;
      END IF;
    END IF;
    IF k IN ('baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date') THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END IF;
      d := v::date;
      IF d::text <> v OR d > current_date THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
    END IF;
    IF k = 'patient_code' AND (length(v) NOT BETWEEN 1 AND 64 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_patient_code';
    END IF;
    IF k = 'sex' AND v NOT IN ('M','F') THEN RAISE EXCEPTION 'invalid_sex'; END IF;
    IF k = 'notes' AND length(v) > 500 THEN RAISE EXCEPTION 'notes_too_long'; END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public._registry_validate_visit_payload(p_project_id uuid,p_row jsonb,p_exclude_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.visits_long; checks jsonb;
BEGIN
  v := jsonb_populate_record(NULL::public.visits_long,p_row);
  checks := public.validate_visit_record(p_project_id,v.patient_code,v.visit_date,v.sbp,v.dbp,v.scr_umol_l,v.upcr,v.egfr,v.notes,p_exclude_id);
  IF jsonb_array_length(coalesce(checks->'errors','[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'visit_validation_failed' USING DETAIL = (checks->'errors')::text;
  END IF;
END $$;

-- Replace partial audit triggers with a single complete, transactional audit.
CREATE OR REPLACE FUNCTION public._registry_audit_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE before_row jsonb := to_jsonb(OLD); after_row jsonb := to_jsonb(NEW); k text; reason text;
BEGIN
  reason := coalesce(nullif(current_setting('app.registry_change_reason',true),''), nullif(after_row->>'qc_reason',''), '通过数据录入更新');
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
    VALUES(TG_TABLE_NAME,OLD.id,OLD.project_id,OLD.patient_code,'__record_deleted__',
      encode(sha256(convert_to(before_row::text,'UTF8')),'hex'),NULL,auth.uid(),
      coalesce(nullif(current_setting('app.registry_change_reason',true),''),'删除操作；未提交删除原因。旧记录内容仅保存SHA256指纹。'));
    RETURN OLD;
  END IF;
  FOR k IN SELECT jsonb_object_keys(after_row) LOOP
    IF k IN ('updated_at','updated_by','qc_reason','created_at','created_by') THEN CONTINUE; END IF;
    IF (before_row->k) IS DISTINCT FROM (after_row->k) THEN
      INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
      VALUES(TG_TABLE_NAME,NEW.id,NEW.project_id,NEW.patient_code,k,before_row->>k,after_row->>k,auth.uid(),reason);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_audit_visit_fields ON public.visits_long;
DROP TRIGGER IF EXISTS trg_audit_baseline_fields ON public.patients_baseline;
DROP TRIGGER IF EXISTS registry_audit_visit ON public.visits_long;
CREATE TRIGGER registry_audit_visit AFTER UPDATE OR DELETE ON public.visits_long FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_audit_baseline ON public.patients_baseline;
CREATE TRIGGER registry_audit_baseline AFTER UPDATE OR DELETE ON public.patients_baseline FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_audit_lab ON public.labs_long;
CREATE TRIGGER registry_audit_lab AFTER UPDATE OR DELETE ON public.labs_long FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();

CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project_id AND created_by=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_access_denied'; END IF;
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
      IF rec_id IS NOT NULL THEN
        IF clean ? 'baseline_date' AND EXISTS (
          SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=clean->>'patient_code'
            AND visit_date < (clean->>'baseline_date')::date
        ) THEN RAISE EXCEPTION 'row_%_baseline_date_after_existing_visit',row_no; END IF;
        clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,clean)))->key)
                  FROM jsonb_object_keys(clean) AS keys(key));
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

CREATE OR REPLACE FUNCTION public.correct_registry_record(p_project_id uuid,p_table text,p_record_id uuid,p_changes jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text; before_row jsonb; after_row jsonb; assignments text; changes jsonb := p_changes; old_reason text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project_id AND created_by=auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_access_denied'; END IF;
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'correction_reason_required'; END IF;
  kind := CASE p_table WHEN 'patients_baseline' THEN 'baseline' WHEN 'visits_long' THEN 'visits' WHEN 'labs_long' THEN 'labs' END;
  IF kind IS NULL THEN RAISE EXCEPTION 'unsupported_record_type'; END IF;
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR changes='{}'::jsonb THEN RAISE EXCEPTION 'correction_changes_required'; END IF;
  IF changes ? 'patient_code' THEN RAISE EXCEPTION 'patient_identity_is_immutable'; END IF;
  PERFORM public._registry_validate_input(kind,changes);
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

REVOKE ALL ON FUNCTION public._registry_check_baseline_upcr(),public._registry_input_columns(text),
 public._registry_validate_input(text,jsonb),public._registry_validate_visit_payload(uuid,jsonb,uuid),public._registry_audit_changes() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text) TO authenticated;

INSERT INTO public.registry_schema_versions(version) VALUES('0034_import_corrections') ON CONFLICT(version) DO NOTHING;

COMMIT;

-- MIGRATION 037: 0035_frozen_exports.sql
-- Reproducible research exports: a single statement reads all tables at one MVCC snapshot.
-- No patient tokens, authentication records, payment details or security credentials are exported.
BEGIN;
CREATE TABLE IF NOT EXISTS registry_private.export_contents (
  snapshot_id uuid PRIMARY KEY REFERENCES public.project_snapshots(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  content_text text NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  UNIQUE(project_id,request_id)
);
ALTER TABLE registry_private.export_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.export_contents FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.reject_export_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'frozen_export_is_immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_export_contents ON registry_private.export_contents;
CREATE TRIGGER immutable_export_contents BEFORE UPDATE ON registry_private.export_contents
FOR EACH ROW EXECUTE FUNCTION registry_private.reject_export_update();
REVOKE ALL ON FUNCTION registry_private.reject_export_update() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_registry_export(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE s public.project_snapshots; e registry_private.export_contents;
BEGIN
  SELECT * INTO s FROM public.project_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'export_not_found'; END IF;
  PERFORM public.assert_project_owner(s.project_id);
  SELECT * INTO e FROM registry_private.export_contents WHERE snapshot_id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'metadata_only_snapshot'
    USING HINT = '这是旧版本元数据记录，未保存当时数据；请创建新的研究导出。'; END IF;
  RETURN jsonb_build_object('id',s.id,'snapshot_id',s.snapshot_id,'created_at',e.created_at,
    'content_sha256',e.content_sha256,'content_text',e.content_text,
    'consistency','database_statement_snapshot','schema_version','registry_v2');
END $$;

CREATE OR REPLACE FUNCTION public.create_registry_export(p_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE payload jsonb; payload_text text; sha text; sid uuid; code text; part record; n_patients int; n_visits int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'export_request_id_required'; END IF;
  -- Serialize exports for this project, including lost-response retries. This is a read entitlement:
  -- trial expiry does not prevent a researcher from retrieving their own data.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
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
      'project',jsonb_build_object('id',p.id,'name',p.name,'center_code',p.center_code,'module',p.module,'registry_type',p.registry_type),
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

REVOKE ALL ON FUNCTION public.create_registry_export(uuid,uuid),public.get_registry_export(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_registry_export(uuid,uuid),public.get_registry_export(uuid) TO authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0035_frozen_exports') ON CONFLICT(version) DO NOTHING;
COMMIT;

-- MIGRATION 038: 0036_project_members.sql
-- Explicit per-project collaboration. A project is the data boundary, not an organization tree.
-- Owners remain the sole membership/project/billing managers. Reading is not a DRM guarantee:
-- viewers can read clinical records; only owners/analysts may call the dedicated export RPCs.
BEGIN;
CREATE TABLE public.project_members (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('editor','analyst','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY(project_id,user_id)
);
CREATE INDEX project_members_user_idx ON public.project_members(user_id,project_id);
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_members FROM PUBLIC,anon,authenticated;
CREATE TABLE registry_private.member_add_attempts (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  email_sha256 text NOT NULL
);
CREATE INDEX member_add_attempts_actor_time_idx ON registry_private.member_add_attempts(actor_id,attempted_at);
ALTER TABLE registry_private.member_add_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registry_private.member_add_attempts FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.project_role(p_project_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN p.created_by=auth.uid() THEN 'owner' ELSE m.role END
  FROM public.projects p LEFT JOIN public.project_members m ON m.project_id=p.id AND m.user_id=auth.uid()
  WHERE p.id=p_project_id AND auth.uid() IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION public.has_project_permission(p_project_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(CASE p_permission
    WHEN 'read' THEN registry_private.project_role(p_project_id) IN ('owner','editor','analyst','viewer')
    WHEN 'write' THEN registry_private.project_role(p_project_id) IN ('owner','editor')
    WHEN 'tokens' THEN registry_private.project_role(p_project_id) IN ('owner','editor')
    WHEN 'export' THEN registry_private.project_role(p_project_id) IN ('owner','analyst')
    WHEN 'manage' THEN registry_private.project_role(p_project_id)='owner'
    ELSE false END,false);
$$;
CREATE OR REPLACE FUNCTION public.assert_project_permission(p_project_id uuid,p_permission text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT public.has_project_permission(p_project_id,p_permission) THEN
    RAISE EXCEPTION 'project_access_denied' USING ERRCODE='42501';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.get_project_access(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r text; writable boolean:=false; why text;
BEGIN
  r:=registry_private.project_role(p_project_id);
  IF r IN ('owner','editor') THEN
    SELECT s.can_write,s.write_block_reason INTO writable,why FROM registry_private.project_write_status(p_project_id) s;
  ELSIF r IS NOT NULL THEN why:='role_read_only'; ELSE why:='project_access_denied'; END IF;
  RETURN jsonb_build_object('role',r,'can_read',r IS NOT NULL,
    'can_write',coalesce(writable,false),'can_export',coalesce(r IN ('owner','analyst'),false),
    'can_manage_tokens',coalesce(writable,false),'can_manage_members',coalesce(r='owner',false),
    'can_manage_project',coalesce(r='owner',false),'write_block_reason',why);
END $$;
CREATE OR REPLACE FUNCTION public.list_project_members(p_project_id uuid)
RETURNS TABLE(user_id uuid,email text,display_name text,role text,created_at timestamptz,is_owner boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  RETURN QUERY
    SELECT u.id,u.email::text,up.real_name::text,'owner'::text,p.created_at,true
    FROM public.projects p JOIN auth.users u ON u.id=p.created_by
    LEFT JOIN public.user_profiles up ON up.user_id=u.id WHERE p.id=p_project_id
    UNION ALL
    SELECT u.id,u.email::text,up.real_name::text,m.role,m.created_at,false
    FROM public.project_members m JOIN auth.users u ON u.id=m.user_id
    LEFT JOIN public.user_profiles up ON up.user_id=u.id WHERE m.project_id=p_project_id;
END $$;
CREATE OR REPLACE FUNCTION public.add_project_member(p_project_id uuid,p_email text,p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_id uuid; normalized_email text:=lower(btrim(p_email)); owner_id uuid; n int;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  IF p_role IS NULL OR p_role NOT IN ('editor','analyst','viewer') THEN RAISE EXCEPTION 'invalid_member_role'; END IF;
  -- Serialize owner-wide attempts across projects, so concurrent failures cannot evade the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('registry-members:'||auth.uid()::text,0));
  SELECT count(*) INTO n FROM registry_private.member_add_attempts
    WHERE actor_id=auth.uid() AND attempted_at>now()-interval '1 hour';
  IF n>=20 OR (SELECT count(*) FROM registry_private.member_add_attempts
    WHERE actor_id=auth.uid() AND attempted_at>now()-interval '1 day')>=100 THEN
    RETURN jsonb_build_object('status','rate_limited');
  END IF;
  INSERT INTO registry_private.member_add_attempts(actor_id,email_sha256)
    VALUES(auth.uid(),encode(sha256(convert_to(coalesce(normalized_email,''),'UTF8')),'hex'));
  SELECT created_by INTO owner_id FROM public.projects WHERE id=p_project_id FOR UPDATE;
  IF normalized_email IS NULL OR length(normalized_email)>254 OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('status','not_added');
  END IF;
  -- Auth service owns email verification; an unverified registered email is not sufficient.
  -- to_jsonb keeps this migration compatible with isolated auth-schema test fixtures.
  SELECT u.id INTO target_id FROM auth.users u WHERE lower(u.email)=normalized_email
    AND nullif(to_jsonb(u)->>'email_confirmed_at','') IS NOT NULL
    ORDER BY u.id LIMIT 1;
  IF target_id IS NULL OR target_id=owner_id THEN RETURN jsonb_build_object('status','not_added'); END IF;
  IF EXISTS(SELECT 1 FROM public.project_members WHERE project_id=p_project_id AND user_id=target_id) THEN
    RETURN jsonb_build_object('status','already_member');
  END IF;
  IF (SELECT count(*) FROM public.project_members WHERE project_id=p_project_id)>=100 THEN
    RETURN jsonb_build_object('status','not_added');
  END IF;
  INSERT INTO public.project_members(project_id,user_id,role,created_by) VALUES(p_project_id,target_id,p_role,auth.uid());
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_added',jsonb_build_object('user_id',target_id,'role',p_role));
  RETURN jsonb_build_object('status','added');
END $$;
-- An editor can have copied any project bearer link. Removing that write authority
-- must revoke every unexpired active link atomically, not only links they created.
CREATE OR REPLACE FUNCTION registry_private.revoke_member_access_tokens(p_project_id uuid,p_member_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n int;
BEGIN
 PERFORM public.assert_project_owner(p_project_id);
 UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason='editor_permission_removed'
  WHERE project_id=p_project_id AND active=true AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>now());
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO public.security_audit_logs(project_id,actor_uid,event_type,severity,details)
  VALUES(p_project_id,auth.uid(),'member_access_tokens_revoked','INFO',jsonb_build_object('member_id',p_member_id,'revoked_token_count',n));
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION registry_private.revoke_member_access_tokens(uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.change_project_member_role(p_project_id uuid,p_user_id uuid,p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_role text; revoked_count int:=0;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION 'project_owner_is_immutable'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('editor','analyst','viewer') THEN RAISE EXCEPTION 'invalid_member_role'; END IF;
  SELECT role INTO previous_role FROM public.project_members WHERE project_id=p_project_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found'; END IF;
  UPDATE public.project_members SET role=p_role WHERE project_id=p_project_id AND user_id=p_user_id;
  IF previous_role='editor' AND p_role<>'editor' THEN revoked_count:=registry_private.revoke_member_access_tokens(p_project_id,p_user_id); END IF;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_role_changed',jsonb_build_object('user_id',p_user_id,'previous_role',previous_role,'role',p_role,'revoked_token_count',revoked_count));
  RETURN jsonb_build_object('status','updated','revoked_token_count',revoked_count);
END $$;
CREATE OR REPLACE FUNCTION public.remove_project_member(p_project_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_role text; revoked_count int:=0;
BEGIN
  PERFORM public.assert_project_owner(p_project_id);
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION 'project_owner_is_immutable'; END IF;
  DELETE FROM public.project_members WHERE project_id=p_project_id AND user_id=p_user_id RETURNING role INTO previous_role;
  IF previous_role IS NULL THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF previous_role='editor' THEN revoked_count:=registry_private.revoke_member_access_tokens(p_project_id,p_user_id); END IF;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'member_removed',jsonb_build_object('user_id',p_user_id,'previous_role',previous_role,'revoked_token_count',revoked_count));
  RETURN jsonb_build_object('status','removed','revoked_token_count',revoked_count);
END $$;

-- Record identity is immutable on every UPDATE path, even if the caller can write both projects.
-- This prevents moving an expired source project's records into an active destination project.
CREATE OR REPLACE FUNCTION registry_private.guard_clinical_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)->'id') IS DISTINCT FROM (to_jsonb(OLD)->'id')
   OR (to_jsonb(NEW)->'project_id') IS DISTINCT FROM (to_jsonb(OLD)->'project_id')
   OR (to_jsonb(NEW)->'patient_code') IS DISTINCT FROM (to_jsonb(OLD)->'patient_code') THEN
  RAISE EXCEPTION 'clinical_identity_is_immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.guard_clinical_identity() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['patients_baseline','visits_long','labs_long','meds_long','variants_long','events_long',
  'ktx_baseline_ext','ktx_visits_ext','project_custom_labs'] LOOP
  EXECUTE format('CREATE TRIGGER a_registry_identity BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION registry_private.guard_clinical_identity()',t);
 END LOOP;
END $$;

-- Clinical RLS. Subscription triggers remain independent of authorization.
DO $$
DECLARE t text; pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY['patients_baseline','visits_long','labs_long','meds_long','variants_long','events_long',
    'ktx_baseline_ext','ktx_visits_ext','project_custom_labs'] LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',pol.policyname,t);
    END LOOP;
    EXECUTE format('CREATE POLICY member_read ON public.%I FOR SELECT TO authenticated USING(public.has_project_permission(project_id,''read''))',t);
    EXECUTE format('CREATE POLICY member_insert ON public.%I FOR INSERT TO authenticated WITH CHECK(public.has_project_permission(project_id,''write''))',t);
    EXECUTE format('CREATE POLICY member_update ON public.%I FOR UPDATE TO authenticated USING(public.has_project_permission(project_id,''write'')) WITH CHECK(public.has_project_permission(project_id,''write''))',t);
    EXECUTE format('CREATE POLICY member_delete ON public.%I FOR DELETE TO authenticated USING(public.has_project_permission(project_id,''write''))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['data_issues','field_audit_log','visits_long_history','audit_log','project_snapshots'] LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',pol.policyname,t);
    END LOOP;
    EXECUTE format('CREATE POLICY member_read ON public.%I FOR SELECT TO authenticated USING(public.has_project_permission(project_id,''read''))',t);
  END LOOP;
END $$;
DROP POLICY projects_select_own ON public.projects;
CREATE POLICY projects_select_members ON public.projects FOR SELECT TO authenticated USING(public.has_project_permission(id,'read'));
DROP POLICY tokens_select_own ON public.patient_tokens;
CREATE POLICY tokens_read_editors ON public.patient_tokens FOR SELECT TO authenticated USING(public.has_project_permission(project_id,'tokens'));
-- No read-role policy on security logs: token administration belongs to the project owner/editor.
DROP POLICY sec_audit_select_own ON public.security_audit_logs;
CREATE POLICY security_read_editors ON public.security_audit_logs FOR SELECT TO authenticated USING(public.has_project_permission(project_id,'tokens'));
DROP POLICY comments_issue_owner ON public.data_issue_comments;
CREATE POLICY comment_read_members ON public.data_issue_comments FOR SELECT TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'read')));
CREATE POLICY comment_insert_editors ON public.data_issue_comments FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid() AND EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')));
CREATE POLICY comment_update_editors ON public.data_issue_comments FOR UPDATE TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')
    AND (data_issue_comments.created_by=auth.uid() OR public.has_project_permission(i.project_id,'manage'))))
  WITH CHECK(EXISTS(SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')));
CREATE POLICY comment_delete_editors ON public.data_issue_comments FOR DELETE TO authenticated USING(EXISTS(
  SELECT 1 FROM public.data_issues i WHERE i.id=issue_id AND public.has_project_permission(i.project_id,'write')
    AND (data_issue_comments.created_by=auth.uid() OR public.has_project_permission(i.project_id,'manage'))));
-- Legacy extension/custom-field tables did not all have the account write guard.
CREATE TRIGGER member_ktxb_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ktx_baseline_ext FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
CREATE TRIGGER member_ktxv_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ktx_visits_ext FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
CREATE TRIGGER member_custom_lab_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.project_custom_labs FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();

-- Explicit replacements preserve all existing validation, transaction and export bounds.
CREATE OR REPLACE FUNCTION public.upsert_lab_record(
  p_project_id uuid, p_patient_code text, p_lab_date date, p_lab_test_code text,
  p_value_raw numeric, p_unit_symbol text, p_measured_at timestamptz DEFAULT NULL,
  p_lab_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
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
  PERFORM public.assert_project_permission(p_project_id,'read');
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

CREATE OR REPLACE FUNCTION public.create_patient_token_v2(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 30,
  p_single_use boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token text;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  -- SHARE conflicts with membership changes' NO KEY UPDATE lock. Recheck after waiting:
  -- a concurrently removed editor must not mint a fresh bearer token after bulk revocation.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'tokens');
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

CREATE OR REPLACE FUNCTION public.revoke_patient_token(p_token text,p_revoke_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token=p_token FOR UPDATE;
  PERFORM public.assert_project_permission(v_token.project_id,'tokens');
  UPDATE public.patient_tokens SET active=false,revoked_at=coalesce(revoked_at,now()),
    revoke_reason=left(p_revoke_reason,500) WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,encode(sha256(convert_to(p_token,'UTF8')),'hex'),
      auth.uid(),'token_revoked','INFO',jsonb_build_object('token_id',v_token.id));
END $$;

CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
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
      IF rec_id IS NOT NULL THEN
        IF clean ? 'baseline_date' AND EXISTS (
          SELECT 1 FROM public.visits_long WHERE project_id=p_project_id AND patient_code=clean->>'patient_code'
            AND visit_date < (clean->>'baseline_date')::date
        ) THEN RAISE EXCEPTION 'row_%_baseline_date_after_existing_visit',row_no; END IF;
        clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,clean)))->key)
                  FROM jsonb_object_keys(clean) AS keys(key));
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

CREATE OR REPLACE FUNCTION public.correct_registry_record(p_project_id uuid,p_table text,p_record_id uuid,p_changes jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE kind text; before_row jsonb; after_row jsonb; assignments text; changes jsonb := p_changes; old_reason text;
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

CREATE OR REPLACE FUNCTION public.get_registry_export(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE s public.project_snapshots; e registry_private.export_contents;
BEGIN
  SELECT * INTO s FROM public.project_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'export_not_found'; END IF;
  PERFORM public.assert_project_permission(s.project_id,'export');
  SELECT * INTO e FROM registry_private.export_contents WHERE snapshot_id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'metadata_only_snapshot'
    USING HINT = '这是旧版本元数据记录，未保存当时数据；请创建新的研究导出。'; END IF;
  RETURN jsonb_build_object('id',s.id,'snapshot_id',s.snapshot_id,'created_at',e.created_at,
    'content_sha256',e.content_sha256,'content_text',e.content_text,
    'consistency','database_statement_snapshot','schema_version','registry_v2');
END $$;

CREATE OR REPLACE FUNCTION public.create_registry_export(p_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
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
      'project',jsonb_build_object('id',p.id,'name',p.name,'center_code',p.center_code,'module',p.module,'registry_type',p.registry_type),
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

CREATE OR REPLACE FUNCTION public.get_field_audit(p_table_name text,p_record_id uuid)
RETURNS TABLE(changed_at timestamptz,field_name text,old_value text,new_value text,changed_by uuid,change_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
  SELECT a.changed_at,a.field_name,a.old_value,a.new_value,a.changed_by,a.change_reason
  FROM public.field_audit_log a JOIN public.projects p ON p.id=a.project_id
  WHERE a.table_name=p_table_name AND a.record_id=p_record_id AND public.has_project_permission(a.project_id,'read')
  ORDER BY a.changed_at DESC;
$$;

create or replace function public.admin_get_visit_history(
  p_project_id uuid,
  p_patient_code text default null,
  p_limit int default 200
)
returns table (
  changed_at timestamptz,
  action text,
  visit_id uuid,
  patient_code text,
  changed_by uuid,
  old_row jsonb,
  new_row jsonb
)
language sql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
  select
    h.changed_at,
    h.action,
    h.visit_id,
    h.patient_code,
    h.changed_by,
    h.old_row,
    h.new_row
  from public.visits_long_history h
  where h.project_id = p_project_id
    and (p_patient_code is null or h.patient_code = p_patient_code)
    and exists (
      select 1 from public.projects p
      where p.id = p_project_id and public.has_project_permission(p.id,'read')
    )
  order by h.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

CREATE OR REPLACE FUNCTION get_issue_summary(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_open',    COUNT(*) FILTER (WHERE status = 'OPEN'),
    'total_in_prog', COUNT(*) FILTER (WHERE status = 'IN_PROGRESS'),
    'total_resolved',COUNT(*) FILTER (WHERE status = 'RESOLVED'),
    'total_wontfix', COUNT(*) FILTER (WHERE status = 'WONT_FIX'),
    'by_severity', jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='critical'),
      'warning',  COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='warning'),
      'info',     COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='info')
    ),
    'close_rate_pct', ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('RESOLVED','WONT_FIX'))
      / NULLIF(COUNT(*), 0)
    , 1)
  )
  INTO v_result
  FROM data_issues
  WHERE project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = p_project_id AND public.has_project_permission(p.id,'read')
    );

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

create or replace function public.list_project_snapshots(p_project_id uuid)
returns setof public.project_snapshots
language sql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
  select s.*
  from public.project_snapshots s
  where s.project_id = p_project_id
    and exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'read'))
  order by s.created_at desc;
$$;

create or replace function public.create_project_snapshot(
  p_project_id uuid,
  p_kind text default 'snapshot',
  p_filter_summary jsonb default '{}'::jsonb,
  p_schema_version text default 'core_v1'
)
returns table (
  id uuid,
  snapshot_id text,
  status text,
  created_at timestamptz,
  n_patients int,
  n_visits int,
  missing_rate numeric,
  qc_summary jsonb
)
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_snapshot_id text;
  v_n_patients int := 0;
  v_n_visits int := 0;
  v_missing_rate numeric := 0;
  v_qc jsonb;
  v_id uuid;
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  if p_kind not in ('snapshot','paper_package','export') then
    raise exception 'invalid_kind';
  end if;

  select count(distinct patient_code) into v_n_patients from public.patients_baseline where project_id = p_project_id;
  select count(*) into v_n_visits from public.visits_long where project_id = p_project_id;

  select jsonb_build_object(
    'visits_missing_sbp', count(*) filter (where sbp is null),
    'visits_missing_dbp', count(*) filter (where dbp is null),
    'visits_missing_scr', count(*) filter (where scr_umol_l is null),
    'visits_missing_upcr', count(*) filter (where upcr is null)
  ) into v_qc
  from public.visits_long
  where project_id = p_project_id;

  if v_n_visits > 0 then
    select (
      ((count(*) filter (where sbp is null or dbp is null or scr_umol_l is null or upcr is null))::numeric / count(*)::numeric) * 100
    ) into v_missing_rate
    from public.visits_long
    where project_id = p_project_id;
  end if;

  v_snapshot_id := public._new_snapshot_code();

  insert into public.project_snapshots(
    snapshot_id, project_id, status, kind, filter_summary, schema_version,
    n_patients, n_visits, missing_rate, qc_summary, created_by
  )
  values (
    v_snapshot_id, p_project_id, 'draft', p_kind, coalesce(p_filter_summary,'{}'::jsonb), p_schema_version,
    v_n_patients, v_n_visits, coalesce(v_missing_rate,0), coalesce(v_qc,'{}'::jsonb), v_uid
  )
  returning project_snapshots.id into v_id;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (
    p_project_id,
    v_uid,
    'snapshot_create',
    v_snapshot_id,
    jsonb_build_object('kind', p_kind, 'schema_version', p_schema_version, 'filter_summary', coalesce(p_filter_summary,'{}'::jsonb))
  );

  return query
  select s.id, s.snapshot_id, s.status, s.created_at, s.n_patients, s.n_visits, s.missing_rate, s.qc_summary
  from public.project_snapshots s where s.id = v_id;
end;
$$;

create or replace function public.lock_project_snapshot(p_snapshot_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
declare
  v_project uuid;
  v_snapshot text;
begin
  select project_id, snapshot_id into v_project, v_snapshot
  from public.project_snapshots
  where id = p_snapshot_id
  limit 1;

  if v_project is null then
    raise exception 'snapshot_not_found';
  end if;

  if not exists (select 1 from public.projects p where p.id = v_project and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  update public.project_snapshots
  set status = 'locked', locked_at = now(), locked_by = auth.uid()
  where id = p_snapshot_id and status <> 'locked';

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (v_project, auth.uid(), 'snapshot_lock', v_snapshot, '{}'::jsonb);
end;
$$;

create or replace function public.log_project_audit(
  p_project_id uuid,
  p_action text,
  p_snapshot_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog,public,pg_temp
as $$
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and public.has_project_permission(p.id,'export')) then
    raise exception 'admin_only';
  end if;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (p_project_id, auth.uid(), p_action, p_snapshot_id, coalesce(p_details,'{}'::jsonb));
end;
$$;

-- QC resolution is a clinical write, including the project's account entitlement.
CREATE OR REPLACE FUNCTION public.close_issue_wont_fix(p_issue_id uuid,p_resolution text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pid uuid;
BEGIN
 SELECT project_id INTO pid FROM public.data_issues WHERE id=p_issue_id;
 PERFORM public.assert_project_permission(pid,'write');
 PERFORM public.assert_project_write_allowed(pid);
 IF p_resolution IS NULL OR length(btrim(p_resolution)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'resolution_required'; END IF;
 UPDATE public.data_issues SET status='WONT_FIX',resolution_note=btrim(p_resolution),resolved_at=now(),updated_at=now() WHERE id=p_issue_id;
 INSERT INTO public.audit_log(project_id,actor_uid,action,details)
  VALUES(pid,auth.uid(),'issue_wont_fix',jsonb_build_object('issue_id',p_issue_id,'reason',btrim(p_resolution)));
END $$;

CREATE OR REPLACE FUNCTION registry_private.guard_member_auxiliary_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pid uuid;
BEGIN
 IF TG_TABLE_NAME='data_issue_comments' THEN
  SELECT project_id INTO pid FROM public.data_issues WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
  -- Parent deletion already passed its RLS; a cascading child DELETE may no longer see the issue.
  IF TG_OP='DELETE' AND pid IS NULL AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.issue_id IS DISTINCT FROM OLD.issue_id THEN RAISE EXCEPTION 'comment_issue_is_immutable'; END IF;
  -- Do not reveal foreign issue existence before checking the caller's authorization.
  PERFORM public.assert_project_permission(pid,'write');
  PERFORM public.assert_project_write_allowed(pid);
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
   VALUES(pid,auth.uid(),'issue_comment_'||lower(TG_OP),jsonb_build_object('comment_id',CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END));
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF auth.uid() IS NOT NULL AND coalesce(current_setting('role',true),'') NOT IN ('service_role','supabase_admin','postgres') THEN
  IF TG_OP='INSERT' THEN NEW.created_by:=auth.uid();NEW.created_at:=now();
  ELSE NEW.created_by:=OLD.created_by;NEW.created_at:=OLD.created_at; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_comment_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.data_issue_comments
 FOR EACH ROW EXECUTE FUNCTION registry_private.guard_member_auxiliary_row();
CREATE TRIGGER member_custom_lab_metadata BEFORE INSERT OR UPDATE ON public.project_custom_labs
 FOR EACH ROW EXECUTE FUNCTION registry_private.guard_member_auxiliary_row();

REVOKE ALL ON FUNCTION registry_private.project_role(uuid),registry_private.guard_member_auxiliary_row() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.assert_project_permission(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.has_project_permission(uuid,text),public.get_project_access(uuid),
 public.list_project_members(uuid),public.add_project_member(uuid,text,text),
 public.change_project_member_role(uuid,uuid,text),public.remove_project_member(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.has_project_permission(uuid,text),public.get_project_access(uuid),
 public.list_project_members(uuid),public.add_project_member(uuid,text,text),
 public.change_project_member_role(uuid,uuid,text),public.remove_project_member(uuid,uuid) TO authenticated;
-- Replacements retain their existing ACLs; make the intended exposed contract explicit.
REVOKE ALL ON FUNCTION public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
 public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
 public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
 public.import_registry_rows(uuid,text,jsonb,uuid),public.correct_registry_record(uuid,text,uuid,jsonb,text),
 public.create_registry_export(uuid,uuid),public.get_registry_export(uuid),public.get_field_audit(text,uuid),
 public.admin_get_visit_history(uuid,text,int),public.get_issue_summary(uuid),public.list_project_snapshots(uuid),
 public.create_project_snapshot(uuid,text,jsonb,text),public.lock_project_snapshot(uuid),
 public.log_project_audit(uuid,text,text,jsonb),public.close_issue_wont_fix(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.upsert_lab_record(uuid,text,date,text,numeric,text,timestamptz,uuid),
 public.validate_visit_record(uuid,text,date,numeric,numeric,numeric,numeric,numeric,text,uuid),
 public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
 public.import_registry_rows(uuid,text,jsonb,uuid),public.correct_registry_record(uuid,text,uuid,jsonb,text),
 public.create_registry_export(uuid,uuid),public.get_registry_export(uuid),public.get_field_audit(text,uuid),
 public.admin_get_visit_history(uuid,text,int),public.get_issue_summary(uuid),public.list_project_snapshots(uuid),
 public.create_project_snapshot(uuid,text,jsonb,text),public.lock_project_snapshot(uuid),
 public.log_project_audit(uuid,text,text,jsonb),public.close_issue_wont_fix(uuid,text) TO authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0036_project_members') ON CONFLICT(version) DO NOTHING;
COMMIT;
