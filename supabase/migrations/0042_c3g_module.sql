-- 0042: C3 glomerulopathy module, visit height with paediatric eGFR, safety events.
-- Additive, transactional and safe to re-run on existing production data.
--  * Laboratory dictionary: module C3G with the complement tests a C3 glomerulopathy
--    registry records (sC5b-9, CH50, AH50, C3 nephritic factor, factors H / I / B and the
--    anti-factor-H antibody) and their units; C3 and C4 stay where they are (module LN).
--  * patients_baseline: c3g_biopsy_date, c3g_if_c3_dominant, c3g_em_pattern,
--    c3g_crescent_pct, c3g_paraprotein — all NULL for every existing patient, shown by the
--    workbench only for projects of module C3G, importable and correctable like the IgAN
--    and LN pathology fields.
--  * visits_long.height_cm (30–250 cm). Children (1–17 years by calendar year) now get an
--    eGFR by the bedside Schwartz 2009 equation (0.413 × height / creatinine mg/dL) when the
--    visit records a height; without one the visit stays 'missing_inputs' as before. Adults
--    are computed exactly as before (CKD-EPI 2021). egfr_formula_version therefore gains the
--    value 'Schwartz-2009-bedside'; the trigger also fires when the height changes.
--  * events_long: serious_infection, hospitalization and vaccination join the manually
--    recorded event types (import and workbench); each must say what happened in
--    event_detail, like 'custom'.
--  * projects.module may be 'C3G' (0033's creation guard, whitelist extended by one value);
--    0040's four whitelist / validation functions are re-created with exactly these
--    additions and no other change; the concept and abbreviation dictionaries gain entries.
BEGIN;

-- Preconditions. Nothing below runs unless 0041 is in place and the objects this migration
-- re-creates or extends exist.
DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0041_followup_board') THEN
    RAISE EXCEPTION '迁移 0042 已中止：尚未执行迁移 0041。请先按顺序执行 0032–0041，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.lab_test_catalog','public.lab_test_unit_map','public.unit_catalog',
      'public.concept_dictionary','public.abbreviation_dictionary','public.events_long','public.visits_long',
      'public.patients_baseline']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['public._registry_input_columns(text)','public._registry_validate_input(text,jsonb)',
        'registry_private.validate_clinical_input(text,jsonb)','registry_private.check_clinical_row(text,jsonb)',
        'registry_private.import_clinical_row(uuid,text,jsonb,integer,uuid)','public._auto_compute_egfr()',
        'public.ckd_epi_2021(numeric,text,numeric)','public._create_project_account_guard()']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.visits_long'::regclass
      AND tgname='trg_auto_egfr' AND NOT tgisinternal) THEN
    missing := 'trigger trg_auto_egfr';
  END IF;
  IF missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.events_long'::regclass
      AND conname='events_long_event_type_check') THEN
    missing := 'constraint events_long_event_type_check';
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0042 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0041 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Laboratory dictionary: module C3G ----------------------------------------------------
INSERT INTO public.unit_catalog(symbol, description) VALUES
  ('U/mL',    '单位每毫升（总补体活性 CH50 常用单位）'),
  ('AU/mL',   '任意单位每毫升（抗体检测，各实验室定义不同）'),
  ('μg/mL',   '微克每毫升（与 mg/L 等值）')
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO public.lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  ('SC5B9',  '可溶性C5b-9（sC5b-9）',      'Soluble C5b-9 (terminal complement complex)', 'C3G', false, NULL, 'ng/mL',
             '末端补体通路活化标志物。参考范围以检测实验室为准；不同试剂盒结果不宜直接比较，请记录检测单位。'),
  ('CH50',   '总补体活性（CH50）',          'Total hemolytic complement (CH50)',           'C3G', false, NULL, 'U/mL',
             '经典途径总活性。C3 肾小球病常见 C3 降低伴 CH50 降低而 C4 正常；参考范围以检测实验室为准。'),
  ('AH50',   '旁路途径补体活性（AH50）',    'Alternative pathway hemolytic activity (AH50)','C3G', false, NULL, '%',
             '以正常血清活性百分比表示。参考范围以检测实验室为准。'),
  ('C3NEF',  'C3肾炎因子（C3NeF）',         'C3 nephritic factor',                          'C3G', false, NULL, '%',
             '定性结果（阳性/阴性）填写在结果文字，定量（C3 转化酶稳定化百分比）填数值。不同实验室方法差异大，请记录方法。'),
  ('CFH',    '补体H因子（FH）',             'Complement factor H',                          'C3G', false, NULL, 'mg/L',
             '血清浓度。参考范围以检测实验室为准；μg/mL 与 mg/L 等值。'),
  ('CFI',    '补体I因子（FI）',             'Complement factor I',                          'C3G', false, NULL, 'mg/L',
             '血清浓度。参考范围以检测实验室为准；μg/mL 与 mg/L 等值。'),
  ('CFB',    '补体B因子（FB）',             'Complement factor B',                          'C3G', false, NULL, 'mg/L',
             '血清浓度。g/L 与 mg/dL 自动换算为 mg/L；参考范围以检测实验室为准。'),
  ('CFHAB',  '抗H因子抗体',                 'Anti-factor H antibody',                       'C3G', false, NULL, 'AU/mL',
             '定量结果填 AU/mL；只有阳性/阴性时填写在结果文字。各实验室阈值不同，请记录方法与阈值。')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  ('SC5B9', 'ng/mL', 1,    0, true),
  ('CH50',  'U/mL',  1,    0, true),
  ('AH50',  '%',     1,    0, true),
  ('C3NEF', '%',     1,    0, true),
  ('CFH',   'mg/L',  1,    0, true),
  ('CFH',   'μg/mL', 1,    0, false),
  ('CFI',   'mg/L',  1,    0, true),
  ('CFI',   'μg/mL', 1,    0, false),
  ('CFB',   'mg/L',  1,    0, true),
  ('CFB',   'g/L',   1000, 0, false),
  ('CFB',   'mg/dL', 10,   0, false),
  ('CFHAB', 'AU/mL', 1,    0, true)
ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- ---- C3 glomerulopathy pathology (patients_baseline) ---------------------------------------
ALTER TABLE public.patients_baseline
  ADD COLUMN IF NOT EXISTS c3g_biopsy_date     date,
  ADD COLUMN IF NOT EXISTS c3g_if_c3_dominant  boolean,
  ADD COLUMN IF NOT EXISTS c3g_em_pattern      text,
  ADD COLUMN IF NOT EXISTS c3g_crescent_pct    numeric,
  ADD COLUMN IF NOT EXISTS c3g_paraprotein     text;
ALTER TABLE public.patients_baseline DROP CONSTRAINT IF EXISTS c3g_em_pattern_check;
ALTER TABLE public.patients_baseline ADD CONSTRAINT c3g_em_pattern_check
  CHECK (c3g_em_pattern IS NULL OR c3g_em_pattern IN ('C3GN','DDD','unclassified'));
ALTER TABLE public.patients_baseline DROP CONSTRAINT IF EXISTS c3g_crescent_pct_check;
ALTER TABLE public.patients_baseline ADD CONSTRAINT c3g_crescent_pct_check
  CHECK (c3g_crescent_pct IS NULL OR (c3g_crescent_pct >= 0 AND c3g_crescent_pct <= 100));
ALTER TABLE public.patients_baseline DROP CONSTRAINT IF EXISTS c3g_paraprotein_check;
ALTER TABLE public.patients_baseline ADD CONSTRAINT c3g_paraprotein_check
  CHECK (c3g_paraprotein IS NULL OR c3g_paraprotein IN ('negative','positive','not_tested'));
COMMENT ON COLUMN public.patients_baseline.c3g_biopsy_date    IS 'C3 肾小球病肾穿日期（可选）。';
COMMENT ON COLUMN public.patients_baseline.c3g_if_c3_dominant IS '免疫荧光是否为 C3 优势沉积（C3 强度比其他任何免疫反应物高至少 2 个等级）；true/false，未评估留空。';
COMMENT ON COLUMN public.patients_baseline.c3g_em_pattern     IS '电镜分型：C3GN（C3 肾小球肾炎）、DDD（致密物沉积病）、unclassified（未能分型）。';
COMMENT ON COLUMN public.patients_baseline.c3g_crescent_pct   IS '新月体占肾小球的百分比（0–100）。';
COMMENT ON COLUMN public.patients_baseline.c3g_paraprotein    IS '单克隆免疫球蛋白筛查：negative 阴性、positive 阳性、not_tested 未查。';

-- ---- Visit height and paediatric eGFR (visits_long) -----------------------------------------
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS height_cm numeric;
ALTER TABLE public.visits_long DROP CONSTRAINT IF EXISTS visits_height_range;
ALTER TABLE public.visits_long ADD CONSTRAINT visits_height_range
  CHECK (height_cm IS NULL OR (height_cm >= 30 AND height_cm <= 250));
COMMENT ON COLUMN public.visits_long.height_cm IS
  '随访时身高（cm，30–250）。1–17 岁患者填写后系统按床旁 Schwartz 2009 公式估算 eGFR；成人可不填。';
COMMENT ON COLUMN public.visits_long.egfr_formula_version IS
  'eGFR计算公式版本：CKD-EPI-2021-Cr（成人）| Schwartz-2009-bedside（1–17 岁，需本次身高）| manual | missing_inputs';

-- 0032's trigger, unchanged for adults; children get the bedside Schwartz 2009 equation when
-- the visit has a height. Age is the calendar-year difference, as before.
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
  IF v_age<1 OR v_age>120 THEN RETURN NEW; END IF;
  IF v_age<18 THEN
    -- Bedside Schwartz 2009: 0.413 × height (cm) / creatinine (mg/dL); needs this visit's height.
    IF NEW.height_cm IS NULL OR NEW.height_cm<=0 THEN RETURN NEW; END IF;
    NEW.egfr:=round(0.413*NEW.height_cm/(NEW.scr_umol_l/88.4),1);
    NEW.egfr_formula_version:='Schwartz-2009-bedside';
    RETURN NEW;
  END IF;
  NEW.egfr:=public.ckd_epi_2021(NEW.scr_umol_l/88.4,v_sex,v_age);
  NEW.egfr_formula_version:='CKD-EPI-2021-Cr';
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public._auto_compute_egfr() FROM PUBLIC,anon;
DROP TRIGGER IF EXISTS trg_auto_egfr ON public.visits_long;
CREATE TRIGGER trg_auto_egfr BEFORE INSERT OR UPDATE OF scr_umol_l,visit_date,project_id,
  patient_code,egfr,egfr_formula_version,height_cm ON public.visits_long
  FOR EACH ROW EXECUTE FUNCTION public._auto_compute_egfr();

-- ---- Safety events (events_long) ----------------------------------------------------------
ALTER TABLE public.events_long DROP CONSTRAINT IF EXISTS events_long_event_type_check;
ALTER TABLE public.events_long ADD CONSTRAINT events_long_event_type_check CHECK (
  event_type IN ('egfr_decline_40pct','egfr_decline_57pct','esrd','death','complete_remission','partial_remission',
    'custom','dialysis_start','kidney_transplant','relapse','serious_infection','hospitalization','vaccination'));
COMMENT ON COLUMN public.events_long.event_type IS
  '事件类型：egfr_decline_40pct、egfr_decline_57pct、complete_remission、partial_remission 由分析脚本按方案计算；esrd、dialysis_start、kidney_transplant、death、relapse、serious_infection（严重感染）、hospitalization（住院）、vaccination（疫苗接种）、custom 手工登记。严重感染、住院、疫苗接种和 custom 须在 event_detail 写明内容。';

-- ---- Project module C3G (0033's guard, unchanged except for the whitelist) -------------------
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
 if new.module not in ('IGAN','LN','MN','DKD','CKD','KTX','GENERAL','C3G') then raise exception 'invalid_module'; end if;
 new.created_by:=v_uid; new.subscription_plan:=v->>'plan'; new.subscription_active_until:=(v->>'ends_at')::timestamptz;
 select account_trial_started_at into v_started from user_profiles where user_id=v_uid;
 new.trial_enabled:=true;new.trial_started_at:=v_started;new.trial_expires_at:=(v->>'trial_expires_at')::timestamptz;new.trial_grace_until:=new.trial_expires_at+interval '7 days';
 return new;
end $$;
revoke all on function public._create_project_account_guard() from public,anon,authenticated;

-- ---- Input columns and validation (0040's functions, extended) -----------------------------
CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit',
    'consent_status','consent_date','consent_version','followup_status','followup_status_date',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date',
    'c3g_biopsy_date','c3g_if_c3_dominant','c3g_em_pattern','c3g_crescent_pct','c3g_paraprotein']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes','height_cm']
  WHEN 'labs' THEN ARRAY['patient_code','lab_date','lab_test_code','value_raw','unit_symbol','result_text',
    'ref_range','abnormal_flag','notes','measured_at']
  WHEN 'meds' THEN ARRAY['patient_code','drug_name','drug_class','dose_value','dose_unit','route','frequency',
    'start_date','end_date','indication','notes']
  WHEN 'events' THEN ARRAY['patient_code','event_type','event_date','event_detail','evidence_source','notes']
  ELSE NULL::text[] END;
$$;

CREATE OR REPLACE FUNCTION registry_private.validate_clinical_input(p_kind text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v text; n numeric; d date; ts timestamptz; today date := registry_private.local_today();
  max_len jsonb := '{"result_text":50,"ref_range":50,"notes":500,"drug_name":200,"dose_unit":20,
    "frequency":20,"indication":100,"event_detail":500}';
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('labs','meds','events') THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each_text(p_row) ORDER BY key LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN RAISE EXCEPTION 'unsupported_column: %',k; END IF;
    IF v IS NULL THEN CONTINUE; END IF;
    IF k IN ('value_raw','dose_value') THEN
      IF jsonb_typeof(p_row->k) NOT IN ('number','string')
        OR btrim(v) !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$' THEN
        RAISE EXCEPTION 'invalid_number: %',k
          USING HINT='请填写数字（可带小数点），不要带单位、空格以外的符号或文字。';
      END IF;
      n := btrim(v)::numeric;
      IF abs(n) >= 1000000000000 OR (k = 'dose_value' AND n >= 1000000) THEN
        RAISE EXCEPTION 'number_out_of_range: %',k;
      END IF;
      IF k = 'dose_value' AND n <= 0 THEN RAISE EXCEPTION 'value_must_be_positive: %',k; END IF;
      CONTINUE;
    END IF;
    IF jsonb_typeof(p_row->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
    IF k = 'patient_code' AND (length(v) NOT BETWEEN 1 AND 64 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_patient_code';
    END IF;
    IF regexp_replace(v,'[\n\r\t]','','g') ~ '[[:cntrl:]]' OR (k NOT IN ('notes','event_detail') AND v ~ '[\n\r\t]') THEN
      RAISE EXCEPTION 'invalid_text: %',k;
    END IF;
    IF max_len ? k AND char_length(v) > (max_len->>k)::int THEN
      IF k = 'notes' THEN RAISE EXCEPTION 'notes_too_long'; END IF;
      RAISE EXCEPTION 'text_too_long: %',k USING HINT=format('该列最多 %s 字。',max_len->>k);
    END IF;
    IF k IN ('lab_date','start_date','end_date','event_date') THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END IF;
      BEGIN d := v::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END;
      IF d::text <> v OR d > today THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
      IF d < DATE '1900-01-01' THEN RAISE EXCEPTION 'date_before_1900: %',k; END IF;
    ELSIF k = 'measured_at' THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$' THEN
        RAISE EXCEPTION 'invalid_timestamp: %',k;
      END IF;
      BEGIN ts := v::timestamptz;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_timestamp: %',k; END;
      IF ts > now() OR ts < TIMESTAMPTZ '1900-01-01 00:00:00+08' THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
    ELSIF k = 'lab_test_code' THEN
      IF NOT EXISTS (SELECT 1 FROM public.lab_test_catalog c WHERE c.code=v) THEN
        RAISE EXCEPTION 'unknown_lab_test_code'
          USING HINT='化验项目编码不在系统检验字典中，请在预览页映射到字典编码，或标记为不导入。';
      END IF;
    ELSIF k = 'abnormal_flag' AND v NOT IN ('H','L','N') THEN RAISE EXCEPTION 'invalid_abnormal_flag';
    ELSIF k = 'drug_class' AND v NOT IN ('RAS阻断剂','SGLT2抑制剂','糖皮质激素','免疫抑制剂','利尿剂',
      '降压药（其他）','降糖药（其他）','降脂药','抗凝/抗血小板','其他') THEN RAISE EXCEPTION 'invalid_drug_class';
    ELSIF k = 'route' AND v NOT IN ('PO','IV','SC','IM','topical','other') THEN RAISE EXCEPTION 'invalid_route';
    ELSIF k = 'event_type' AND v NOT IN ('egfr_decline_40pct','egfr_decline_57pct','esrd','death','complete_remission',
      'partial_remission','custom','dialysis_start','kidney_transplant','relapse',
      'serious_infection','hospitalization','vaccination') THEN RAISE EXCEPTION 'invalid_event_type';
    ELSIF k = 'evidence_source' AND v NOT IN ('medical_record','lab_review','phone_followup','death_certificate','other') THEN
      RAISE EXCEPTION 'invalid_evidence_source';
    ELSIF k IN ('drug_name','dose_unit','frequency','result_text','ref_range','indication','notes','event_detail')
      AND btrim(v) = '' THEN RAISE EXCEPTION 'invalid_text: %',k;
    END IF;
    IF k IN ('result_text','ref_range','notes','drug_name','dose_unit','frequency','indication','event_detail')
      AND public._contains_pii(v) THEN
      RAISE EXCEPTION 'pii_detected_blocked: %',k
        USING HINT='检测到疑似个人身份信息（手机号、身份证号、住院号/病案号、姓名、邮箱或 8 位以上连续数字），请删除后再导入。';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION registry_private.validate_clinical_input(text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.check_clinical_row(p_kind text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE allowed text;
BEGIN
  IF p_kind = 'labs' THEN
    IF p_row->>'lab_date' IS NULL THEN RAISE EXCEPTION 'lab_date_required'; END IF;
    IF p_row->>'lab_test_code' IS NULL THEN RAISE EXCEPTION 'lab_test_code_required'; END IF;
    IF p_row->>'value_raw' IS NULL AND p_row->>'result_text' IS NULL THEN
      RAISE EXCEPTION 'lab_value_or_result_required'
        USING HINT='定量结果填写数值与单位；定性结果（如 阴性、+）填写在 result_text。';
    END IF;
    IF p_row->>'value_raw' IS NOT NULL AND p_row->>'unit_symbol' IS NULL THEN RAISE EXCEPTION 'unit_symbol_required'; END IF;
    IF p_row->>'value_raw' IS NULL AND p_row->>'unit_symbol' IS NOT NULL THEN
      RAISE EXCEPTION 'unit_requires_value' USING HINT='只有定性结果时请不要填写单位。';
    END IF;
    IF p_row->>'unit_symbol' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.lab_test_unit_map m
      WHERE m.lab_test_code=p_row->>'lab_test_code' AND m.unit_symbol=p_row->>'unit_symbol') THEN
      SELECT string_agg(m.unit_symbol,'、' ORDER BY m.is_standard DESC,m.unit_symbol) INTO allowed
        FROM public.lab_test_unit_map m WHERE m.lab_test_code=p_row->>'lab_test_code';
      RAISE EXCEPTION 'unit_not_allowed: unit_symbol'
        USING HINT=format('该化验项目可用的单位：%s。',coalesce(allowed,'无'));
    END IF;
  ELSIF p_kind = 'meds' THEN
    IF p_row->>'drug_name' IS NULL THEN RAISE EXCEPTION 'drug_name_required'; END IF;
    IF p_row->>'start_date' IS NULL THEN RAISE EXCEPTION 'start_date_required'; END IF;
    IF (p_row->>'end_date')::date < (p_row->>'start_date')::date THEN RAISE EXCEPTION 'end_date_before_start_date'; END IF;
  ELSIF p_kind = 'events' THEN
    IF p_row->>'event_type' IS NULL THEN RAISE EXCEPTION 'event_type_required'; END IF;
    IF p_row->>'event_date' IS NULL THEN RAISE EXCEPTION 'event_date_required'; END IF;
    IF p_row->>'evidence_source' IS NULL THEN RAISE EXCEPTION 'evidence_source_required'; END IF;
    IF p_row->>'event_type' IN ('custom','serious_infection','hospitalization','vaccination')
      AND p_row->>'event_detail' IS NULL THEN
      RAISE EXCEPTION 'event_detail_required'
        USING HINT='自定义事件、严重感染、住院和疫苗接种请在 event_detail 中写明内容（感染部位或诊断、住院原因、疫苗名称）。';
    END IF;
  ELSE RAISE EXCEPTION 'invalid_import_request';
  END IF;
END $$;
REVOKE ALL ON FUNCTION registry_private.check_clinical_row(text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION registry_private.import_clinical_row(p_project_id uuid,p_kind text,p_row jsonb,
  p_row_no int,p_batch_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb := p_row; clean jsonb; k text; msg text; hint text; tbl text; key_cols text[];
  key_match text; row_hash text; rec_id uuid; cols text; exprs text;
BEGIN
  tbl := CASE p_kind WHEN 'labs' THEN 'labs_long' WHEN 'meds' THEN 'meds_long' WHEN 'events' THEN 'events_long' END;
  key_cols := CASE p_kind WHEN 'labs' THEN ARRAY['patient_code','lab_date','lab_test_code']
    WHEN 'meds' THEN ARRAY['patient_code','drug_name','start_date']
    ELSE ARRAY['patient_code','event_type','event_date'] END;
  IF r ? 'project_id' AND r->>'project_id' IS DISTINCT FROM p_project_id::text THEN
    RAISE EXCEPTION 'row_%_project_mismatch',p_row_no;
  END IF;
  r := r - 'project_id';
  -- Unknown headers are refused even when the cell is empty. Empty and blank cells are
  -- absent values; other text cells are trimmed except the patient code, which must match.
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN
      RAISE EXCEPTION 'row_%_unsupported_column: %',p_row_no,k USING HINT='模板中没有这一列，请删除该列或按模板列名填写；本批次未写入。';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_object_agg(key,CASE WHEN jsonb_typeof(value)='string' AND key <> 'patient_code'
      THEN to_jsonb(btrim(value #>> '{}')) ELSE value END),'{}'::jsonb) INTO clean
    FROM jsonb_each(r) WHERE jsonb_typeof(value) <> 'null'
      AND NOT (jsonb_typeof(value)='string' AND btrim(value #>> '{}')='');
  BEGIN
    PERFORM registry_private.validate_clinical_input(p_kind,clean);
    IF coalesce(clean->>'patient_code','') = '' THEN RAISE EXCEPTION 'patient_code_required'; END IF;
    PERFORM registry_private.check_clinical_row(p_kind,clean);
    IF p_kind = 'events' AND clean->>'event_type' NOT IN ('esrd','dialysis_start','kidney_transplant','death','relapse','custom',
      'serious_infection','hospitalization','vaccination') THEN
      RAISE EXCEPTION 'derived_endpoint_not_importable'
        USING HINT='eGFR 下降与缓解属于由化验数据计算的终点，由分析脚本按研究方案判定，不能导入；本批次未写入。';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, hint = PG_EXCEPTION_HINT;
    RAISE EXCEPTION 'row_%_%',p_row_no,msg USING HINT=coalesce(nullif(hint,''),'请按模板说明更正该行；本批次未写入。');
  END;
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline WHERE project_id=p_project_id AND patient_code=clean->>'patient_code') THEN
    RAISE EXCEPTION 'row_%_patient_not_registered',p_row_no
      USING HINT='该研究编号在本项目中没有患者基线记录，请先导入或建立患者；本批次未写入。';
  END IF;
  -- Typed values as the table stores them (dates, numbers), so equal content hashes equally.
  EXECUTE format('SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.%I,$1)))->key) FROM jsonb_object_keys($1) AS keys(key)',tbl)
    INTO clean USING clean;
  row_hash := encode(sha256(convert_to(clean::text,'UTF8')),'hex');
  SELECT record_id INTO rec_id FROM public.registry_import_records
    WHERE project_id=p_project_id AND kind=p_kind AND content_sha256=row_hash LIMIT 1;
  IF rec_id IS NOT NULL THEN
    EXECUTE format('SELECT CASE WHEN to_jsonb(t) @> $2 THEN 1 ELSE 0 END FROM public.%I t WHERE t.id=$1 AND t.project_id=$3',tbl)
      INTO k USING rec_id,clean,p_project_id;
    IF k IS NULL THEN RAISE EXCEPTION 'row_%_previously_imported_record_deleted_requires_review',p_row_no
      USING HINT='同样内容曾经导入，但该记录之后被删除；请先核实是否应重新录入。本批次未写入。'; END IF;
    IF k = '0' THEN RAISE EXCEPTION 'row_%_record_changed_since_import',p_row_no
      USING HINT = '记录已在导入后更正，请核对当前记录；不会覆盖更正或默默跳过差异。'; END IF;
    -- This batch counts the record as skipped: link it so undoing another batch keeps it.
    INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
      VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'matched') ON CONFLICT DO NOTHING;
    RETURN 'skipped';
  END IF;
  key_match := (SELECT string_agg(format('t.%1$I=(jsonb_populate_record(NULL::public.%2$I,$2)).%1$I',c,tbl),' AND ')
    FROM unnest(key_cols) AS c);
  EXECUTE format('SELECT t.id FROM public.%I t WHERE t.project_id=$1 AND %s AND to_jsonb(t) @> $2 ORDER BY t.id LIMIT 1',tbl,key_match)
    INTO rec_id USING p_project_id,clean;
  IF rec_id IS NOT NULL THEN
    INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
      VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'matched');
    RETURN 'skipped';
  END IF;
  EXECUTE format('SELECT t.id FROM public.%I t WHERE t.project_id=$1 AND %s ORDER BY t.id LIMIT 1',tbl,key_match)
    INTO rec_id USING p_project_id,clean;
  IF rec_id IS NOT NULL THEN
    RAISE EXCEPTION 'row_%_same_key_record_conflict',p_row_no
      USING HINT = '同一患者同一业务键已有不同数据，请先在记录纠错中核实；本批次未写入。';
  END IF;
  r := clean || jsonb_build_object('project_id',p_project_id,'created_by',auth.uid());
  IF p_kind = 'meds' AND clean ? 'dose_value' AND clean ? 'dose_unit' THEN
    r := r || jsonb_build_object('dose',(clean->>'dose_value') || ' ' || (clean->>'dose_unit'));
  ELSIF p_kind = 'events' THEN
    r := r || jsonb_build_object('source','manual','confirmed',true);
  END IF;
  SELECT string_agg(format('%I',key),',' ORDER BY key),
         string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',tbl,key),',' ORDER BY key)
    INTO cols,exprs FROM jsonb_object_keys(r) AS keys(key);
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s RETURNING id',tbl,cols,exprs) INTO rec_id USING r;
  INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
    VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'inserted');
  RETURN 'inserted';
END $$;
REVOKE ALL ON FUNCTION registry_private.import_clinical_row(uuid,text,jsonb,int,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public._registry_validate_input(p_kind text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text; v text; n numeric; d date; today date := registry_private.local_today();
BEGIN
  IF p_kind IN ('labs','meds','events') THEN
    PERFORM registry_private.validate_clinical_input(p_kind,p_row);
    RETURN;
  END IF;
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
      'consent_status','consent_date','consent_version','followup_status','followup_status_date',
      'c3g_biopsy_date','c3g_em_pattern','c3g_paraprotein')
      AND jsonb_typeof(p_row->k)<>'string' THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
    IF k IN ('birth_year','baseline_scr','baseline_upcr','baseline_upcr_raw','sbp','dbp','scr_umol_l','upcr','egfr',
             'oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','value_raw',
             'c3g_crescent_pct','height_cm') THEN
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
      IF k = 'c3g_crescent_pct' AND n > 100 THEN RAISE EXCEPTION 'invalid_c3g_crescent_pct'; END IF;
      IF k = 'height_cm' AND (n < 30 OR n > 250) THEN RAISE EXCEPTION 'invalid_height_cm'; END IF;
    END IF;
    IF k IN ('baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date','consent_date','followup_status_date',
      'c3g_biopsy_date') THEN
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
    IF k IN ('ln_podocytopathy','c3g_if_c3_dominant') AND v NOT IN ('true','false') THEN RAISE EXCEPTION 'invalid_boolean: %',k; END IF;
    IF k = 'c3g_em_pattern' AND v NOT IN ('C3GN','DDD','unclassified') THEN RAISE EXCEPTION 'invalid_c3g_em_pattern'; END IF;
    IF k = 'c3g_paraprotein' AND v NOT IN ('negative','positive','not_tested') THEN RAISE EXCEPTION 'invalid_c3g_paraprotein'; END IF;
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

-- ---- Chinese display dictionaries ---------------------------------------------------------
INSERT INTO public.concept_dictionary(code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn, affects_export, affects_qc)
VALUES
  ('height_cm', 'GENERAL', '随访时身高', '身高', '儿童（1–17 岁）填写后系统按床旁 Schwartz 2009 公式估算 eGFR；成人可不填。', '儿童每次随访填写。', 'cm（厘米）', true, true),
  ('c3g_biopsy_date', 'C3G', 'C3 肾小球病肾穿日期', '肾穿日期', '未做肾穿或无报告可留空。', '建立基线时填写。', NULL, true, false),
  ('c3g_if_c3_dominant', 'C3G', '免疫荧光 C3 优势沉积', 'C3 优势', 'C3 强度比其他任何免疫反应物高至少 2 个等级记为“是”。', '有免疫荧光报告时填写。', NULL, true, true),
  ('c3g_em_pattern', 'C3G', '电镜分型（C3GN / DDD）', '电镜分型', 'C3GN：C3 肾小球肾炎；DDD：致密物沉积病；未能分型选“未能分型”。', '有电镜报告时填写。', NULL, true, true),
  ('c3g_crescent_pct', 'C3G', '新月体比例', '新月体%', '新月体占肾小球的百分比。', '有病理报告时填写。', '%（百分比）', true, false),
  ('c3g_paraprotein', 'C3G', '单克隆免疫球蛋白筛查', '单克隆筛查', '成人 C3 肾小球病建议筛查；阴性、阳性或未查。', '建立基线时填写。', NULL, true, false)
ON CONFLICT (code) DO UPDATE SET
  domain = EXCLUDED.domain,
  display_name_cn = EXCLUDED.display_name_cn,
  short_name_cn = EXCLUDED.short_name_cn,
  help_text_cn = EXCLUDED.help_text_cn,
  when_to_fill_cn = EXCLUDED.when_to_fill_cn,
  unit_cn = EXCLUDED.unit_cn,
  affects_export = EXCLUDED.affects_export,
  affects_qc = EXCLUDED.affects_qc;

INSERT INTO public.abbreviation_dictionary(abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('C3GN',   'C3 肾小球肾炎',          '病种相关', '首次显示建议：C3 肾小球肾炎（C3GN，C3 肾小球病的一种电镜分型）'),
  ('DDD',    '致密物沉积病',            '病种相关', '首次显示建议：致密物沉积病（DDD，C3 肾小球病的一种电镜分型）'),
  ('sC5b-9', '可溶性末端补体复合物',    '化验指标', '首次显示建议：可溶性 C5b-9（sC5b-9，末端补体通路活化标志物）'),
  ('CH50',   '总补体活性',              '化验指标', '首次显示建议：总补体活性（CH50，经典途径）'),
  ('AH50',   '旁路途径补体活性',        '化验指标', '首次显示建议：旁路途径补体活性（AH50）'),
  ('C3NeF',  'C3 肾炎因子',             '化验指标', '首次显示建议：C3 肾炎因子（C3NeF）')
ON CONFLICT (abbr) DO NOTHING;

INSERT INTO public.registry_schema_versions(version) VALUES('0042_c3g_module') ON CONFLICT(version) DO NOTHING;
COMMIT;
