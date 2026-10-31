-- 0048: IgA nephropathy, second batch aligned with the REIGNITE protocol V1.0 (GlomCon, 15 July
-- 2026). Additive, transactional and safe to re-run. No stored clinical value is changed; the
-- data stay in this registry (nothing here sends data anywhere).
--  * events_long: twelve manually recorded event types (protocol 1.3 and 3.2): ER visit, ICU
--    admission, any infection, venous thromboembolism, cardiovascular event, malignancy,
--    osteopenia or osteoporosis, fracture, avascular necrosis, new diabetes mellitus, new or
--    worsened hypertension and pregnancy. ER visits, ICU admissions, infections, cardiovascular
--    events, malignancies, fractures and pregnancies must say in event_detail what happened
--    (reason, type, site or outcome), like 'custom'. Their coded subtypes wait for the study's
--    case report form and data dictionary.
--  * events_long.los_days: length of stay in days (0-3650), only for hospitalization and ICU
--    admission (protocol 3.2: hospitalizations by reason and length of stay).
--  * visits_long.weight_kg (1-300 kg), recorded with the visit like the height.
--  * Laboratory dictionary: IgG, IgM, galactose-deficient IgA1, the white-cell differential
--    (absolute counts), 24-hour urine protein, albumin and creatinine, and the qualitative
--    serologies ANA, MPO-ANCA, PR3-ANCA, anti-GBM, HBsAg, anti-HCV, HIV, RPR and treponemal
--    antibody (results in result_text). Units follow common Chinese laboratory reports; the
--    study's data dictionary may refine them.
--  * Functions re-created from their reviewed 0047 text with only these additions (generated,
--    see commit message):
--    public._registry_input_columns (0047_imaging_records.sql)
--    registry_private.validate_clinical_input (0047_imaging_records.sql)
--    registry_private.check_clinical_row (0047_imaging_records.sql)
--    registry_private.import_clinical_row (0047_imaging_records.sql)
--    public._registry_validate_input (0047_imaging_records.sql)
BEGIN;

DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0047_imaging_records') THEN
    RAISE EXCEPTION '迁移 0048 已中止：尚未执行迁移 0047。请先按顺序执行 0032–0047，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.events_long','public.visits_long','public.lab_test_catalog','public.lab_test_unit_map',
      'public.unit_catalog','public.abbreviation_dictionary','public.concept_dictionary','public.imaging_long']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['public._registry_input_columns(text)','public._registry_validate_input(text,jsonb)',
        'registry_private.validate_clinical_input(text,jsonb)','registry_private.check_clinical_row(text,jsonb)',
        'registry_private.import_clinical_row(uuid,text,jsonb,integer,uuid)']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0048 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0047 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Event types and length of stay ------------------------------------------------------------
ALTER TABLE public.events_long DROP CONSTRAINT IF EXISTS events_long_event_type_check;
ALTER TABLE public.events_long ADD CONSTRAINT events_long_event_type_check CHECK (
  event_type IN ('egfr_decline_40pct','egfr_decline_57pct','esrd','death','complete_remission','partial_remission',
    'custom','dialysis_start','kidney_transplant','relapse','serious_infection','hospitalization',
    'er_visit','icu_admission','infection','venous_thromboembolism','cardiovascular_event','malignancy','osteoporosis','fracture','avascular_necrosis','new_diabetes','hypertension_new_or_worse','pregnancy'));
ALTER TABLE public.events_long ADD COLUMN IF NOT EXISTS los_days smallint;
ALTER TABLE public.events_long DROP CONSTRAINT IF EXISTS events_long_los_days_check;
ALTER TABLE public.events_long ADD CONSTRAINT events_long_los_days_check
  CHECK (los_days IS NULL OR (los_days >= 0 AND los_days <= 3650 AND event_type IN ('hospitalization','icu_admission')));
COMMENT ON COLUMN public.events_long.event_type IS
  '事件类型：egfr_decline_40pct、egfr_decline_57pct、complete_remission、partial_remission 由分析脚本按方案计算；其余手工登记：esrd、dialysis_start、kidney_transplant、death、relapse、serious_infection（严重感染）、hospitalization（住院）、er_visit（急诊）、icu_admission（入住 ICU）、infection（任何感染）、venous_thromboembolism（静脉血栓栓塞）、cardiovascular_event（心血管事件）、malignancy（恶性肿瘤）、osteoporosis（骨量减少或骨质疏松）、fracture（骨折）、avascular_necrosis（缺血性骨坏死）、new_diabetes（新发糖尿病）、hypertension_new_or_worse（新发或加重的高血压）、pregnancy（妊娠）、custom。custom、严重感染、住院、急诊、ICU、感染、心血管事件、恶性肿瘤、骨折和妊娠须在 event_detail 写明原因、类型、部位或结局。疫苗接种在用药记录中登记（药物类别“疫苗”）。';
COMMENT ON COLUMN public.events_long.los_days IS '住院天数（0–3650），只用于住院（hospitalization）和入住 ICU（icu_admission）。';

-- ---- Visit weight ------------------------------------------------------------------------------
ALTER TABLE public.visits_long ADD COLUMN IF NOT EXISTS weight_kg numeric;
ALTER TABLE public.visits_long DROP CONSTRAINT IF EXISTS visits_long_weight_kg_check;
ALTER TABLE public.visits_long ADD CONSTRAINT visits_long_weight_kg_check
  CHECK (weight_kg IS NULL OR (weight_kg >= 1 AND weight_kg <= 300));
COMMENT ON COLUMN public.visits_long.weight_kg IS '随访时体重（kg，1–300），可空。';

-- ---- Input columns and validation (reviewed functions, extended) -------------------------------
CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit',
    'consent_status','consent_date','consent_version','followup_status','followup_status_date',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date',
    'c3g_biopsy_date','c3g_if_c3_dominant','c3g_em_pattern','c3g_crescent_pct','c3g_paraprotein']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes','height_cm','weight_kg']
  WHEN 'labs' THEN ARRAY['patient_code','lab_date','lab_test_code','value_raw','unit_symbol','result_text',
    'ref_range','abnormal_flag','notes','measured_at']
  WHEN 'meds' THEN ARRAY['patient_code','drug_name','drug_class','dose_value','dose_unit','route','frequency',
    'start_date','end_date','indication','notes']
  WHEN 'events' THEN ARRAY['patient_code','event_type','event_date','event_detail','evidence_source','notes','los_days']
  WHEN 'biopsies' THEN ARRAY['patient_code','biopsy_date','biopsy_kind','is_index','glomeruli_total','crescent_pct',
    'oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','notes']
  WHEN 'imaging' THEN ARRAY['patient_code','exam_date','modality',
    'left_length_cm','left_width_cm','left_depth_cm','right_length_cm','right_width_cm','right_depth_cm',
    'liver_cysts','mayo_image_class','notes']
  ELSE NULL::text[] END;
$$;

CREATE OR REPLACE FUNCTION registry_private.validate_clinical_input(p_kind text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v text; n numeric; d date; ts timestamptz; today date := registry_private.local_today();
  max_len jsonb := '{"result_text":50,"ref_range":50,"notes":500,"drug_name":200,"dose_unit":20,
    "frequency":20,"indication":100,"event_detail":500}';
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('labs','meds','events','biopsies','imaging') THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each_text(p_row) ORDER BY key LOOP
    IF NOT k = ANY(public._registry_input_columns(p_kind)) THEN RAISE EXCEPTION 'unsupported_column: %',k; END IF;
    IF v IS NULL THEN CONTINUE; END IF;
    IF k = 'los_days' THEN
      IF jsonb_typeof(p_row->k) NOT IN ('number','string') OR btrim(v) !~ '^[0-9]{1,4}$' THEN
        RAISE EXCEPTION 'integer_required: %',k USING HINT='住院天数请填写不带小数点的整数。';
      END IF;
      IF btrim(v)::int > 3650 THEN RAISE EXCEPTION 'number_out_of_range: %',k USING HINT='住院天数为 0–3650 天。'; END IF;
      CONTINUE;
    END IF;
    IF k IN ('glomeruli_total','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c') THEN
      IF jsonb_typeof(p_row->k) NOT IN ('number','string') OR btrim(v) !~ '^[0-9]{1,3}$' THEN
        RAISE EXCEPTION 'integer_required: %',k USING HINT='请填写不带小数点的整数。';
      END IF;
      n := btrim(v)::numeric;
      IF k LIKE 'oxford_%' AND n > (CASE WHEN k IN ('oxford_t','oxford_c') THEN 2 ELSE 1 END) THEN
        RAISE EXCEPTION 'invalid_oxford_score: %',k;
      END IF;
      CONTINUE;
    END IF;
    IF k IN ('value_raw','dose_value','crescent_pct',
      'left_length_cm','left_width_cm','left_depth_cm','right_length_cm','right_width_cm','right_depth_cm') THEN
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
      IF k LIKE '%\_cm' AND (n <= 0 OR n > 40) THEN
        RAISE EXCEPTION 'number_out_of_range: %',k USING HINT='肾脏径线以厘米（cm）填写，须大于 0、不超过 40，例如 12.5。';
      END IF;
      IF k = 'crescent_pct' AND (n < 0 OR n > 100) THEN
        RAISE EXCEPTION 'number_out_of_range: %',k USING HINT='新月体比例填 0–100 的百分数，例如 12.5。';
      END IF;
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
    IF k IN ('lab_date','start_date','end_date','event_date','biopsy_date','exam_date') THEN
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
    ELSIF k = 'biopsy_kind' AND v NOT IN ('native','transplant') THEN RAISE EXCEPTION 'invalid_biopsy_kind';
    ELSIF k = 'is_index' AND v NOT IN ('true','false') THEN RAISE EXCEPTION 'invalid_boolean: %',k;
    ELSIF k = 'modality' AND v NOT IN ('ultrasound','ct','mri') THEN RAISE EXCEPTION 'invalid_imaging_modality';
    ELSIF k = 'liver_cysts' AND v NOT IN ('present','absent') THEN RAISE EXCEPTION 'invalid_liver_cysts';
    ELSIF k = 'mayo_image_class' AND v NOT IN ('typical','atypical') THEN RAISE EXCEPTION 'invalid_mayo_image_class';
    ELSIF k = 'drug_class' AND v NOT IN ('RAS阻断剂','SGLT2抑制剂','糖皮质激素','免疫抑制剂','利尿剂',
      '降压药（其他）','降糖药（其他）','降脂药','抗凝/抗血小板','其他',
      '内皮素受体拮抗剂','补体抑制剂','盐皮质激素受体拮抗剂','预防性抗生素','试验药物','疫苗',
      '血管加压素V2受体拮抗剂') THEN RAISE EXCEPTION 'invalid_drug_class';
    ELSIF k = 'route' AND v NOT IN ('PO','IV','SC','IM','topical','other') THEN RAISE EXCEPTION 'invalid_route';
    ELSIF k = 'event_type' AND v NOT IN ('egfr_decline_40pct','egfr_decline_57pct','esrd','death','complete_remission',
      'partial_remission','custom','dialysis_start','kidney_transplant','relapse',
      'serious_infection','hospitalization',
      'er_visit','icu_admission','infection','venous_thromboembolism','cardiovascular_event','malignancy','osteoporosis','fracture','avascular_necrosis','new_diabetes','hypertension_new_or_worse','pregnancy') THEN RAISE EXCEPTION 'invalid_event_type';
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
    IF p_row->>'event_type' IN ('custom','serious_infection','hospitalization','er_visit','icu_admission','infection','cardiovascular_event','malignancy','fracture','pregnancy')
      AND p_row->>'event_detail' IS NULL THEN
      RAISE EXCEPTION 'event_detail_required'
        USING HINT='该事件类型须在 event_detail 中写明内容：感染写部位或病原，住院、急诊和 ICU 写原因，心血管事件、恶性肿瘤和骨折写类型或部位，妊娠写结局。';
    END IF;
    IF p_row->>'los_days' IS NOT NULL AND p_row->>'event_type' NOT IN ('hospitalization','icu_admission') THEN
      RAISE EXCEPTION 'los_days_not_applicable' USING HINT='住院天数只用于住院和 ICU 事件。';
    END IF;
  ELSIF p_kind = 'biopsies' THEN
    IF p_row->>'biopsy_date' IS NULL THEN RAISE EXCEPTION 'biopsy_date_required'; END IF;
    IF p_row->>'biopsy_kind' IS NULL THEN
      RAISE EXCEPTION 'biopsy_kind_required' USING HINT='活检类型填 native（自体肾）或 transplant（移植肾）。';
    END IF;
    -- Oxford C (Trimarchi 2017): C0 no crescents, C1 crescents in under 25% of glomeruli, C2 in 25% or more.
    IF p_row->>'oxford_c' IS NOT NULL AND p_row->>'crescent_pct' IS NOT NULL AND NOT (
        ((p_row->>'oxford_c')::numeric = 0 AND (p_row->>'crescent_pct')::numeric = 0)
        OR ((p_row->>'oxford_c')::numeric = 1 AND (p_row->>'crescent_pct')::numeric > 0 AND (p_row->>'crescent_pct')::numeric < 25)
        OR ((p_row->>'oxford_c')::numeric = 2 AND (p_row->>'crescent_pct')::numeric >= 25)) THEN
      RAISE EXCEPTION 'oxford_c_crescent_mismatch'
        USING HINT='牛津分型 C 与新月体比例不一致：C0 为无新月体，C1 为新月体占肾小球不足 25%，C2 为 25% 及以上。请按病理报告核对。';
    END IF;
  ELSIF p_kind = 'imaging' THEN
    IF p_row->>'exam_date' IS NULL THEN RAISE EXCEPTION 'exam_date_required'; END IF;
    IF p_row->>'modality' IS NULL THEN
      RAISE EXCEPTION 'imaging_modality_required' USING HINT='检查方式填 ultrasound（超声）、ct 或 mri（磁共振）。';
    END IF;
    IF NOT p_row ?| ARRAY['left_length_cm','left_width_cm','left_depth_cm','right_length_cm','right_width_cm','right_depth_cm','liver_cysts'] THEN
      RAISE EXCEPTION 'imaging_measurement_required' USING HINT='至少填写一项肾脏径线或肝囊肿情况。';
    END IF;
    -- Mayo imaging classes are defined on CT or MRI only (Irazabal 2015).
    IF p_row->>'mayo_image_class' IS NOT NULL AND p_row->>'modality' = 'ultrasound' THEN
      RAISE EXCEPTION 'mayo_class_requires_ct_or_mri' USING HINT='Mayo 影像分型（典型或非典型）只适用于 CT 或磁共振，超声检查请留空。';
    END IF;
  ELSE RAISE EXCEPTION 'invalid_import_request';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION registry_private.import_clinical_row(p_project_id uuid,p_kind text,p_row jsonb,
  p_row_no int,p_batch_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb := p_row; clean jsonb; k text; msg text; hint text; tbl text; key_cols text[];
  key_match text; row_hash text; rec_id uuid; cols text; exprs text;
BEGIN
  tbl := CASE p_kind WHEN 'labs' THEN 'labs_long' WHEN 'meds' THEN 'meds_long' WHEN 'events' THEN 'events_long'
    WHEN 'biopsies' THEN 'biopsies_long' WHEN 'imaging' THEN 'imaging_long' END;
  key_cols := CASE p_kind WHEN 'labs' THEN ARRAY['patient_code','lab_date','lab_test_code']
    WHEN 'meds' THEN ARRAY['patient_code','drug_name','start_date']
    WHEN 'biopsies' THEN ARRAY['patient_code','biopsy_date','biopsy_kind']
    WHEN 'imaging' THEN ARRAY['patient_code','exam_date','modality']
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
      'serious_infection','hospitalization',
      'er_visit','icu_admission','infection','venous_thromboembolism','cardiovascular_event','malignancy','osteoporosis','fracture','avascular_necrosis','new_diabetes','hypertension_new_or_worse','pregnancy') THEN
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
  IF p_kind = 'biopsies' AND clean->>'is_index' = 'true' AND EXISTS (SELECT 1 FROM public.biopsies_long b
      WHERE b.project_id=p_project_id AND b.patient_code=clean->>'patient_code' AND b.is_index) THEN
    RAISE EXCEPTION 'row_%_index_biopsy_exists',p_row_no
      USING HINT='该患者已有一次基准活检；每位患者只能有一次。请先核对已有活检记录；本批次未写入。';
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

CREATE OR REPLACE FUNCTION public._registry_validate_input(p_kind text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text; v text; n numeric; d date; today date := registry_private.local_today();
BEGIN
  IF p_kind IN ('labs','meds','events','biopsies','imaging') THEN
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
             'c3g_crescent_pct','height_cm','weight_kg') THEN
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
      IF k = 'weight_kg' AND (n < 1 OR n > 300) THEN RAISE EXCEPTION 'invalid_weight_kg'; END IF;
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

-- ---- Laboratory dictionary ---------------------------------------------------------------------
-- The existing normalization (0040) converts quantitative results to the standard unit and keeps
-- qualitative rows (result_text only) as 'qualitative'. A test without any unit mapping accepts
-- qualitative results only.
INSERT INTO public.unit_catalog(symbol, description) VALUES
  ('g/24h',    '克每 24 小时'),
  ('mg/24h',   '毫克每 24 小时'),
  ('mmol/24h', '毫摩尔每 24 小时'),
  ('μmol/24h', '微摩尔每 24 小时')
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO public.lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  ('IGG',      '血清IgG',                       'Serum IgG',                        'GENERAL', false, '2465-3', 'g/L',
               '报告单位为 mg/dL 时由系统换算为 g/L（1 mg/dL = 0.01 g/L）。'),
  ('IGM',      '血清IgM',                       'Serum IgM',                        'GENERAL', false, '2472-9', 'g/L',
               '报告单位为 mg/dL 时由系统换算为 g/L（1 mg/dL = 0.01 g/L）。'),
  ('GDIGA1',   '半乳糖缺陷IgA1（Gd-IgA1）',     'Galactose-deficient IgA1',         'IGAN',    false, NULL,     'μg/mL',
               '不同试剂（如 KM55 法）的结果不能直接比较，请在备注中写明检测方法；只接受 μg/mL，其他单位请填在结果文字。'),
  ('NEUT',     '中性粒细胞计数',                'Neutrophils, absolute',            'GENERAL', false, '751-8',  '10^9/L', '填绝对计数；百分比可写在备注。'),
  ('LYMPH',    '淋巴细胞计数',                  'Lymphocytes, absolute',            'GENERAL', false, '731-0',  '10^9/L', '填绝对计数；百分比可写在备注。'),
  ('MONO',     '单核细胞计数',                  'Monocytes, absolute',              'GENERAL', false, '742-7',  '10^9/L', '填绝对计数；百分比可写在备注。'),
  ('EOS',      '嗜酸性粒细胞计数',              'Eosinophils, absolute',            'GENERAL', false, '711-2',  '10^9/L', '填绝对计数；百分比可写在备注。'),
  ('BASO',     '嗜碱性粒细胞计数',              'Basophils, absolute',              'GENERAL', false, '704-7',  '10^9/L', '填绝对计数；百分比可写在备注。'),
  ('UTP24',    '24小时尿蛋白定量',              'Urine protein, 24 hours',          'GENERAL', false, NULL,     'g/24h',
               '报告单位为 mg/24h 时由系统换算为 g/24h。尿量和留尿是否完整请写在备注。'),
  ('UALB24',   '24小时尿白蛋白',                'Urine albumin, 24 hours',          'GENERAL', false, NULL,     'mg/24h',
               '报告单位为 g/24h 时由系统换算为 mg/24h。'),
  ('UCREA24',  '24小时尿肌酐',                  'Urine creatinine, 24 hours',       'GENERAL', false, NULL,     'mmol/24h',
               '报告单位为 μmol/24h、mg/24h 或 g/24h 时由系统换算为 mmol/24h（1 mg = 0.008842 mmol）。用于核对 24 小时尿是否留全。'),
  ('ANA',      '抗核抗体（ANA）',               'Antinuclear antibodies',           'GENERAL', false, NULL,     '定性',
               '定性结果：在结果文字中填写阴性或阳性，阳性时写滴度和核型，例如“阳性 1:320 颗粒型”。'),
  ('MPO_ANCA', '抗髓过氧化物酶抗体（MPO-ANCA）', 'MPO-ANCA',                        'GENERAL', false, NULL,     '定性',
               '在结果文字中填写阴性或阳性；有定量结果时连同单位和检测方法一起写在结果文字，不同方法不能直接比较。'),
  ('PR3_ANCA', '抗蛋白酶3抗体（PR3-ANCA）',     'PR3-ANCA',                         'GENERAL', false, NULL,     '定性',
               '在结果文字中填写阴性或阳性；有定量结果时连同单位和检测方法一起写在结果文字。'),
  ('ANTI_GBM', '抗肾小球基底膜抗体',            'Anti-GBM antibodies',              'GENERAL', false, NULL,     '定性',
               '在结果文字中填写阴性或阳性；有定量结果时连同单位和检测方法一起写在结果文字。'),
  ('HBSAG',    '乙肝表面抗原（HBsAg）',         'Hepatitis B surface antigen',      'GENERAL', false, NULL,     '定性', '在结果文字中填写阴性或阳性。'),
  ('HCV_AB',   '丙肝抗体（抗-HCV）',            'Hepatitis C antibodies',           'GENERAL', false, NULL,     '定性', '在结果文字中填写阴性或阳性。'),
  ('HIV_AB',   'HIV 抗体（或抗原抗体联合检测）', 'HIV antibodies / antigen-antibody', 'GENERAL', false, NULL,    '定性', '在结果文字中填写阴性、阳性或待复核。'),
  ('RPR',      '梅毒快速血浆反应素试验（RPR）', 'Rapid plasma reagin',              'GENERAL', false, NULL,     '定性', '在结果文字中填写阴性或阳性，阳性时写滴度，例如“阳性 1:8”。'),
  ('TP_AB',    '梅毒螺旋体抗体',                'Treponema pallidum antibodies',    'GENERAL', false, NULL,     '定性', '在结果文字中填写阴性或阳性。')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  ('IGG',     'g/L',      1,        0, true),
  ('IGG',     'mg/dL',    0.01,     0, false),
  ('IGM',     'g/L',      1,        0, true),
  ('IGM',     'mg/dL',    0.01,     0, false),
  ('GDIGA1',  'μg/mL',    1,        0, true),
  ('NEUT',    '10^9/L',   1,        0, true),
  ('LYMPH',   '10^9/L',   1,        0, true),
  ('MONO',    '10^9/L',   1,        0, true),
  ('EOS',     '10^9/L',   1,        0, true),
  ('BASO',    '10^9/L',   1,        0, true),
  ('UTP24',   'g/24h',    1,        0, true),
  ('UTP24',   'mg/24h',   0.001,    0, false),
  ('UALB24',  'mg/24h',   1,        0, true),
  ('UALB24',  'g/24h',    1000,     0, false),
  ('UCREA24', 'mmol/24h', 1,        0, true),
  ('UCREA24', 'μmol/24h', 0.001,    0, false),
  ('UCREA24', 'mg/24h',   0.008842, 0, false),
  ('UCREA24', 'g/24h',    8.842,    0, false)
ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- ---- Display dictionaries ----------------------------------------------------------------------
INSERT INTO public.concept_dictionary(code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn, affects_export, affects_qc)
VALUES
  ('weight_kg', 'GENERAL', '随访时体重', '体重', '可空；成人和儿童都可以填写。', '有体重记录时填写。', 'kg（千克）', true, false),
  ('los_days', 'GENERAL', '住院天数', '住院天数', '只用于住院和入住 ICU 事件；入院当天到出院当天的天数。', '有出院记录时填写。', '天', true, false)
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
  ('Gd-IgA1', '半乳糖缺陷 IgA1',     '化验指标', '首次显示建议：半乳糖缺陷 IgA1（galactose-deficient IgA1，Gd-IgA1）'),
  ('ICU',     '重症监护病房',         '临床事件', '首次显示建议：重症监护病房（ICU）'),
  ('VTE',     '静脉血栓栓塞',         '临床事件', '首次显示建议：静脉血栓栓塞（VTE，含深静脉血栓和肺栓塞）'),
  ('RPR',     '快速血浆反应素试验',   '化验指标', '首次显示建议：梅毒快速血浆反应素试验（RPR）')
ON CONFLICT (abbr) DO NOTHING;

INSERT INTO public.registry_schema_versions(version) VALUES('0048_reignite_batch2') ON CONFLICT(version) DO NOTHING;
COMMIT;
