-- 0047: kidney imaging records and serum total bilirubin.
-- Additive, transactional and safe to re-run. No stored clinical value is changed.
--  * public.imaging_long: one row per imaging examination of the kidneys (ultrasound, CT or MRI):
--    examination date, modality, length, width and depth of each kidney in cm, liver cysts
--    (present or absent), the Mayo imaging class for CT and MRI (typical or atypical) and notes.
--    One row per patient, examination date and modality. Total kidney volume tkv_ml is computed
--    by the database (ellipsoid: pi/6 x length x width x depth, both kidneys added) and only when
--    all six diameters are given; it cannot be typed. The table has the protections of the other
--    clinical tables: member row security, immutable identity, field audit of changes and
--    deletions, the read-only lock, created/updated metadata, the PII guard on notes, and no
--    examination date after today (Beijing date) or before 1900. A wrong record may be deleted;
--    the deletion is audited like a biopsy record's.
--  * Batch import accepts kind 'imaging' (business key: patient + examination date + modality),
--    with undo like the other clinical records.
--  * The frozen export carries imaging_long and its field notes. Height-adjusted TKV and the
--    Mayo class 1A-1E are computed by the analysis pack, not stored.
--  * Laboratory dictionary: TBIL, serum total bilirubin in umol/L (mg/dL converted x 17.104).
--  * Display dictionary: abbreviations TKV and htTKV.
--  * Functions re-created from their reviewed text with only these additions (generated, see
--    commit message):
--    public._registry_input_columns (0043_biopsy_records.sql)
--    registry_private.validate_clinical_input (0046_adpkd_module.sql)
--    registry_private.check_clinical_row (0043_biopsy_records.sql)
--    registry_private.import_record_digest (0044_project_fields.sql)
--    registry_private.import_clinical_row (0043_biopsy_records.sql)
--    public._registry_validate_input (0043_biopsy_records.sql)
--    public.import_registry_rows (0044_project_fields.sql)
--    public.undo_import_batch (0044_project_fields.sql)
--    public.create_registry_export (0044_project_fields.sql)
BEGIN;

-- Preconditions. Nothing below runs unless 0046 is in place and the objects this migration
-- re-creates or extends exist.
DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0046_adpkd_module') THEN
    RAISE EXCEPTION '迁移 0047 已中止：尚未执行迁移 0046。请先按顺序执行 0032–0046，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.patients_baseline','public.projects','public.biopsies_long','public.patient_field_values',
      'public.registry_import_batches','public.registry_import_records','public.field_audit_log','public.audit_log',
      'public.lab_test_catalog','public.lab_test_unit_map','public.unit_catalog','public.abbreviation_dictionary',
      'public.concept_dictionary']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['public._registry_input_columns(text)','public._registry_validate_input(text,jsonb)',
        'registry_private.validate_clinical_input(text,jsonb)','registry_private.check_clinical_row(text,jsonb)',
        'registry_private.import_clinical_row(uuid,text,jsonb,integer,uuid)','registry_private.import_record_digest(text,uuid)',
        'registry_private.import_field_row(uuid,jsonb,integer,uuid)',
        'public.import_registry_rows(uuid,text,jsonb,uuid)','public.undo_import_batch(uuid,uuid,text)',
        'public.create_registry_export(uuid,uuid)','public.get_registry_export(uuid)','registry_private.guard_clinical_identity()',
        'public._registry_audit_changes()','public._set_created_by()','public._trial_block_write()',
        'public._set_updated_meta()','public._pii_guard()','public._contains_pii(text)','registry_private.local_today()',
        'registry_private.project_ids_with_permission(text)']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0047 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0046 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Kidney imaging records (imaging_long) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.imaging_long (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  patient_code     text NOT NULL,
  exam_date        date NOT NULL,
  modality         text NOT NULL,
  left_length_cm   numeric,
  left_width_cm    numeric,
  left_depth_cm    numeric,
  right_length_cm  numeric,
  right_width_cm   numeric,
  right_depth_cm   numeric,
  tkv_ml           numeric GENERATED ALWAYS AS (CASE WHEN left_length_cm IS NOT NULL AND left_width_cm IS NOT NULL AND left_depth_cm IS NOT NULL
    AND right_length_cm IS NOT NULL AND right_width_cm IS NOT NULL AND right_depth_cm IS NOT NULL
    THEN round(pi()::numeric / 6 * (left_length_cm*left_width_cm*left_depth_cm + right_length_cm*right_width_cm*right_depth_cm), 1) END) STORED,
  liver_cysts      text,
  mayo_image_class text,
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT imaging_long_modality_check CHECK (modality IN ('ultrasound','ct','mri')),
  CONSTRAINT imaging_long_date_floor CHECK (exam_date >= DATE '1900-01-01'),
  CONSTRAINT imaging_long_left_length_range CHECK (left_length_cm IS NULL OR (left_length_cm > 0 AND left_length_cm <= 40)),
  CONSTRAINT imaging_long_left_width_range CHECK (left_width_cm IS NULL OR (left_width_cm > 0 AND left_width_cm <= 40)),
  CONSTRAINT imaging_long_left_depth_range CHECK (left_depth_cm IS NULL OR (left_depth_cm > 0 AND left_depth_cm <= 40)),
  CONSTRAINT imaging_long_right_length_range CHECK (right_length_cm IS NULL OR (right_length_cm > 0 AND right_length_cm <= 40)),
  CONSTRAINT imaging_long_right_width_range CHECK (right_width_cm IS NULL OR (right_width_cm > 0 AND right_width_cm <= 40)),
  CONSTRAINT imaging_long_right_depth_range CHECK (right_depth_cm IS NULL OR (right_depth_cm > 0 AND right_depth_cm <= 40)),
  CONSTRAINT imaging_long_liver_cysts_check CHECK (liver_cysts IS NULL OR liver_cysts IN ('present','absent')),
  CONSTRAINT imaging_long_mayo_class_check CHECK (mayo_image_class IS NULL OR mayo_image_class IN ('typical','atypical')),
  CONSTRAINT imaging_long_mayo_class_modality CHECK (mayo_image_class IS NULL OR modality IN ('ct','mri')),
  CONSTRAINT imaging_long_has_measurement CHECK (num_nonnulls(left_length_cm,left_width_cm,left_depth_cm,right_length_cm,right_width_cm,right_depth_cm,liver_cysts) >= 1),
  CONSTRAINT imaging_long_notes_length CHECK (char_length(notes) BETWEEN 1 AND 500),
  CONSTRAINT imaging_long_patient_project_fk FOREIGN KEY (project_id,patient_code)
    REFERENCES public.patients_baseline(project_id,patient_code) ON UPDATE CASCADE ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT imaging_long_business_key UNIQUE (project_id,patient_code,exam_date,modality)
);
COMMENT ON TABLE public.imaging_long IS
  '肾脏影像记录：每次检查一行（超声、CT 或磁共振），可多次。同一患者同一日期同一检查方式只能一行。总肾体积由系统按椭球公式计算。';
COMMENT ON COLUMN public.imaging_long.exam_date IS '检查日期，不能晚于今天（北京时间），不早于 1900-01-01。';
COMMENT ON COLUMN public.imaging_long.modality IS '检查方式：ultrasound 超声；ct；mri 磁共振。';
COMMENT ON COLUMN public.imaging_long.left_length_cm IS '左肾长径（cm，大于 0、不超过 40）。宽径、厚径和右肾同此。';
COMMENT ON COLUMN public.imaging_long.tkv_ml IS '总肾体积（mL）：π/6 × 长 × 宽 × 厚，左右肾相加，保留 1 位小数；左右肾三条径线都填写时由系统计算，不能手工填写。';
COMMENT ON COLUMN public.imaging_long.liver_cysts IS '肝囊肿：present 有；absent 无；空值为未记录。';
COMMENT ON COLUMN public.imaging_long.mayo_image_class IS 'Mayo 影像分型：typical 典型；atypical 非典型。只适用于 CT 或磁共振。';
COMMENT ON COLUMN public.imaging_long.notes IS '备注（最多 500 字），不得填写身份信息。';

-- Examination dates follow the research-date rule of visits and biopsies (Beijing date). It reads
-- no table, so it may run with definer rights.
CREATE OR REPLACE FUNCTION registry_private.reject_future_exam_date()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.exam_date > registry_private.local_today()
    AND (TG_OP = 'INSERT' OR NEW.exam_date IS DISTINCT FROM OLD.exam_date) THEN
    RAISE EXCEPTION 'future_exam_date';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.reject_future_exam_date() FROM PUBLIC,anon,authenticated;

-- The same triggers as biopsies_long.
DROP TRIGGER IF EXISTS a_registry_identity ON public.imaging_long;
CREATE TRIGGER a_registry_identity BEFORE UPDATE ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.guard_clinical_identity();
DROP TRIGGER IF EXISTS registry_audit_imaging ON public.imaging_long;
CREATE TRIGGER registry_audit_imaging AFTER UPDATE OR DELETE ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_exam_date_future ON public.imaging_long;
CREATE TRIGGER registry_exam_date_future BEFORE INSERT OR UPDATE OF exam_date ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.reject_future_exam_date();
DROP TRIGGER IF EXISTS tr_imaging_created_by ON public.imaging_long;
CREATE TRIGGER tr_imaging_created_by BEFORE INSERT ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION public._set_created_by();
DROP TRIGGER IF EXISTS tr_imaging_trial_lock ON public.imaging_long;
CREATE TRIGGER tr_imaging_trial_lock BEFORE INSERT OR UPDATE OR DELETE ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
DROP TRIGGER IF EXISTS tr_imaging_updated_meta ON public.imaging_long;
CREATE TRIGGER tr_imaging_updated_meta BEFORE UPDATE ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_meta();
DROP TRIGGER IF EXISTS trg_pii_guard_imaging ON public.imaging_long;
CREATE TRIGGER trg_pii_guard_imaging BEFORE INSERT OR UPDATE ON public.imaging_long
  FOR EACH ROW EXECUTE FUNCTION public._pii_guard('notes');

-- Member row security exactly as biopsies_long.
ALTER TABLE public.imaging_long ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_read ON public.imaging_long;
CREATE POLICY member_read ON public.imaging_long FOR SELECT TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('read')));
DROP POLICY IF EXISTS member_insert ON public.imaging_long;
CREATE POLICY member_insert ON public.imaging_long FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
DROP POLICY IF EXISTS member_update ON public.imaging_long;
CREATE POLICY member_update ON public.imaging_long FOR UPDATE TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('write')))
  WITH CHECK (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
DROP POLICY IF EXISTS member_delete ON public.imaging_long;
CREATE POLICY member_delete ON public.imaging_long FOR DELETE TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
-- Client roles never truncate (row security does not cover TRUNCATE).
REVOKE TRUNCATE,TRIGGER,REFERENCES ON public.imaging_long FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.imaging_long TO authenticated;

-- ---- Batch import kind 'imaging' ---------------------------------------------------------------
ALTER TABLE public.registry_import_batches DROP CONSTRAINT IF EXISTS registry_import_batches_kind_check,
  ADD CONSTRAINT registry_import_batches_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events','biopsies','fields','imaging'));
ALTER TABLE public.registry_import_records DROP CONSTRAINT IF EXISTS registry_import_records_kind_check,
  ADD CONSTRAINT registry_import_records_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events','biopsies','fields','imaging'));

-- ---- Input columns, validation, import, undo and export (reviewed functions, extended) --------
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
      'serious_infection','hospitalization') THEN RAISE EXCEPTION 'invalid_event_type';
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
    IF p_row->>'event_type' IN ('custom','serious_infection','hospitalization')
      AND p_row->>'event_detail' IS NULL THEN
      RAISE EXCEPTION 'event_detail_required'
        USING HINT='自定义事件、严重感染和住院请在 event_detail 中写明内容（感染部位或诊断、住院原因）。';
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

CREATE OR REPLACE FUNCTION registry_private.import_record_digest(p_table text,p_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
DECLARE r jsonb;
BEGIN
  IF p_table IS NULL OR p_table NOT IN ('visits_long','labs_long','meds_long','events_long','biopsies_long',
    'patient_field_values','imaging_long') THEN
    RAISE EXCEPTION 'unsupported_record_type';
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id=$1',p_table) INTO r USING p_id;
  RETURN encode(sha256(convert_to(r::text,'UTF8')),'hex');
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
      'serious_infection','hospitalization') THEN
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

CREATE OR REPLACE FUNCTION public.import_registry_rows(p_project_id uuid,p_kind text,p_rows jsonb,p_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb; clean jsonb; old_row jsonb; previous public.registry_import_batches%ROWTYPE;
  payload_hash text; row_hash text; tbl text; cols text; exprs text; assignments text; rec_id uuid;
  added int := 0; changed int := 0; skipped int := 0; row_no int := 0; result jsonb; old_reason text; k text;
  record_table text;
  study_keys text[] := ARRAY['consent_status','followup_status','consent_date','consent_version','followup_status_date'];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_kind IS NULL OR p_kind NOT IN ('baseline','visits','labs','meds','events','biopsies','fields','imaging') OR p_batch_id IS NULL THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
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
    IF p_kind = 'fields' THEN
      IF registry_private.import_field_row(p_project_id,r,row_no,p_batch_id) = 'inserted' THEN
        added := added+1;
      ELSE
        skipped := skipped+1;
      END IF;
      CONTINUE;
    END IF;
    IF p_kind IN ('labs','meds','events','biopsies','imaging') THEN
      IF registry_private.import_clinical_row(p_project_id,p_kind,r,row_no,p_batch_id) = 'inserted' THEN
        added := added+1;
      ELSE
        skipped := skipped+1;
      END IF;
      CONTINUE;
    END IF;
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
        WHERE project_id=p_project_id AND kind=p_kind AND content_sha256=row_hash LIMIT 1;
      IF rec_id IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.visits_long WHERE id=rec_id AND project_id=p_project_id) THEN
          RAISE EXCEPTION 'row_%_previously_imported_record_deleted_requires_review',row_no
            USING HINT='同样内容曾经导入，但该记录之后被删除；请先核实是否应重新录入。本批次未写入。';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.visits_long v WHERE id=rec_id AND project_id=p_project_id AND to_jsonb(v) @> clean) THEN
          RAISE EXCEPTION 'row_%_record_changed_since_import',row_no
            USING HINT = '记录已在导入后更正，请核对当前记录；不会覆盖更正或默默跳过差异。';
        END IF;
        INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
          VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'matched') ON CONFLICT DO NOTHING;
        skipped := skipped+1; CONTINUE;
      END IF;
      SELECT id INTO rec_id FROM public.visits_long v WHERE project_id=p_project_id
        AND patient_code=clean->>'patient_code' AND visit_date=(clean->>'visit_date')::date
        AND to_jsonb(v) @> clean ORDER BY id LIMIT 1;
      IF rec_id IS NOT NULL THEN
        INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
          VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'matched');
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
      INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
        VALUES(p_project_id,p_kind,row_hash,rec_id,p_batch_id,'inserted');
    END IF;
    added := added+1;
  END LOOP;
  -- Whole-row digest of every record this batch inserted, taken once all rows are in;
  -- undo_import_batch deletes only records still matching it.
  IF p_kind <> 'baseline' THEN
    record_table := CASE p_kind WHEN 'visits' THEN 'visits_long' WHEN 'labs' THEN 'labs_long'
      WHEN 'meds' THEN 'meds_long' WHEN 'biopsies' THEN 'biopsies_long' WHEN 'fields' THEN 'patient_field_values'
      WHEN 'imaging' THEN 'imaging_long' ELSE 'events_long' END;
    UPDATE public.registry_import_records ir SET record_sha256=registry_private.import_record_digest(record_table,ir.record_id)
      WHERE ir.project_id=p_project_id AND ir.kind=p_kind AND ir.batch_id=p_batch_id AND ir.action='inserted';
  END IF;
  result := jsonb_build_object('inserted',added,'updated',changed,'skipped',skipped,'total',row_no,'replayed',false);
  INSERT INTO public.registry_import_batches(project_id,batch_id,kind,content_sha256,actor_id,result,undo_tracked)
    VALUES(p_project_id,p_batch_id,p_kind,payload_hash,auth.uid(),result,p_kind <> 'baseline');
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.undo_import_batch(p_project_id uuid,p_batch_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.registry_import_batches%ROWTYPE; reason text := btrim(p_reason); tbl text; m record;
  ins_sha text; ins_undone boolean;
  n_deleted int := 0; n_kept int := 0; n_referenced int := 0; n_missing int := 0; old_reason text; outcome jsonb; found_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  IF reason IS NULL OR char_length(reason) NOT BETWEEN 2 AND 500 OR reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'undo_reason_required' USING HINT='请填写撤销原因（2–500 字，不含身份信息）。';
  END IF;
  IF public._contains_pii(reason) THEN
    RAISE EXCEPTION 'pii_detected_blocked' USING HINT='撤销原因中检测到疑似个人身份信息，请删除后重试。';
  END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  SELECT * INTO b FROM public.registry_import_batches
    WHERE project_id=p_project_id AND batch_id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import_batch_not_found'; END IF;
  IF b.kind NOT IN ('visits','labs','meds','events','biopsies','fields','imaging') THEN
    RAISE EXCEPTION 'batch_kind_not_undoable' USING HINT='患者基线批次不能整批撤销，请在记录纠错中逐条更正。';
  END IF;
  IF b.undone_at IS NOT NULL THEN
    RETURN b.undo_result || jsonb_build_object('already_undone',true);
  END IF;
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF NOT b.undo_tracked THEN
    RAISE EXCEPTION 'batch_undo_not_tracked'
      USING HINT='该批次在系统支持撤销之前导入，没有逐条记录写入了哪些数据，不能自动撤销；请在记录纠错中逐条核实。';
  END IF;
  tbl := CASE b.kind WHEN 'visits' THEN 'visits_long' WHEN 'labs' THEN 'labs_long'
    WHEN 'meds' THEN 'meds_long' WHEN 'biopsies' THEN 'biopsies_long' WHEN 'fields' THEN 'patient_field_values'
    WHEN 'imaging' THEN 'imaging_long' ELSE 'events_long' END;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason','撤销导入批次 ' || p_batch_id::text || '：' || reason,true);
  -- Candidates: every record this batch inserted or skipped (own = inserted by this batch).
  FOR m IN SELECT r.record_id,bool_or(r.action='inserted') AS own FROM public.registry_import_records r
    WHERE r.project_id=p_project_id AND r.kind=b.kind AND r.batch_id=p_batch_id
    GROUP BY r.record_id ORDER BY r.record_id LOOP
    -- Digest taken when the record was inserted, and whether its inserting batch is undone.
    ins_sha := NULL; ins_undone := NULL;
    SELECT i.record_sha256,(ib.undone_at IS NOT NULL) INTO ins_sha,ins_undone
      FROM public.registry_import_records i
      JOIN public.registry_import_batches ib ON ib.project_id=i.project_id AND ib.batch_id=i.batch_id
      WHERE i.project_id=p_project_id AND i.kind=b.kind AND i.record_id=m.record_id AND i.action='inserted'
      LIMIT 1;
    IF NOT m.own AND ins_undone IS NOT TRUE THEN CONTINUE; END IF;
    EXECUTE format('SELECT t.id FROM public.%I t WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE',tbl)
      INTO found_id USING m.record_id,p_project_id;
    IF found_id IS NULL THEN
      IF m.own THEN n_missing := n_missing+1; END IF;
    ELSIF registry_private.import_record_digest(tbl,m.record_id) IS DISTINCT FROM ins_sha THEN
      IF m.own THEN n_kept := n_kept+1; END IF;
      CONTINUE;
    ELSIF EXISTS (SELECT 1 FROM public.registry_import_records o
        JOIN public.registry_import_batches ob ON ob.project_id=o.project_id AND ob.batch_id=o.batch_id
        WHERE o.project_id=p_project_id AND o.kind=b.kind AND o.record_id=m.record_id
          AND o.batch_id<>p_batch_id AND ob.undone_at IS NULL) THEN
      IF m.own THEN n_referenced := n_referenced+1; END IF;
      CONTINUE;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE id=$1 AND project_id=$2',tbl) USING m.record_id,p_project_id;
      n_deleted := n_deleted+1;
    END IF;
    DELETE FROM public.registry_import_records
      WHERE project_id=p_project_id AND kind=b.kind AND record_id=m.record_id;
  END LOOP;
  outcome := jsonb_build_object('deleted',n_deleted,'kept_changed',n_kept,'kept_referenced',n_referenced,
    'missing',n_missing,'already_undone',false);
  UPDATE public.registry_import_batches SET undone_at=now(),undone_by=auth.uid(),undo_reason=reason,
    undo_result=outcome - 'already_undone'
    WHERE project_id=p_project_id AND batch_id=p_batch_id;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'import_batch_undone',jsonb_build_object('batch_id',p_batch_id,'kind',b.kind,
      'reason',reason,'deleted',n_deleted,'kept_changed',n_kept,'kept_referenced',n_referenced,'missing',n_missing,
      'file_sha256',b.file_sha256,'chunk_index',b.chunk_index,'chunk_total',b.chunk_total));
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN outcome;
END $$;

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
    rows_9 AS MATERIALIZED (SELECT * FROM public.biopsies_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_10 AS MATERIALIZED (SELECT * FROM public.project_fields WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_11 AS MATERIALIZED (SELECT * FROM public.patient_field_values WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    rows_12 AS MATERIALIZED (SELECT * FROM public.imaging_long WHERE project_id=p_project_id ORDER BY id LIMIT 10001),
    bounds AS MATERIALIZED (SELECT ((SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_0 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_1 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_2 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_3 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_4 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_5 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_6 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_7 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_8 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_9 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_10 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_11 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_12 t)) AS row_bytes, ((SELECT count(*) FROM rows_0)>10000 OR (SELECT count(*) FROM rows_1)>10000 OR (SELECT count(*) FROM rows_2)>10000 OR (SELECT count(*) FROM rows_3)>10000 OR (SELECT count(*) FROM rows_4)>10000 OR (SELECT count(*) FROM rows_5)>10000 OR (SELECT count(*) FROM rows_6)>10000 OR (SELECT count(*) FROM rows_7)>10000 OR (SELECT count(*) FROM rows_8)>10000 OR (SELECT count(*) FROM rows_9)>10000 OR (SELECT count(*) FROM rows_10)>10000 OR (SELECT count(*) FROM rows_11)>10000 OR (SELECT count(*) FROM rows_12)>10000) AS over_rows)
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
        'followup_interval_days','项目设置的计划随访间隔（天），用于提醒排程，不是临床判定标准。',
        'biopsy_kind','肾活检记录（biopsies_long）的活检类型：native 自体肾；transplant 移植肾。',
        'is_index','肾活检记录的基准活检标记：true 表示按活检日对齐的导出以这次活检的日期为第 0 天（通常是确诊活检），每位患者最多一次；未标记时由导出配置决定对齐日期。',
        'crescent_pct','肾活检记录的新月体比例：含新月体的肾小球占全部肾小球的百分比（0–100）。与牛津分型 C 同时填写时须一致：C0 为 0，C1 小于 25，C2 为 25 及以上。',
        'field_key','自定义入组字段的代码：project_fields 为本项目的字段定义（显示名称、类型、选项、单位与范围），patient_field_values 为每位患者每个字段的取值。',
        'value_codes','自定义入组字段的取值：单选与“是/否”（yes/no）及文本存在 value_text，多选存选项代码数组 value_codes（按定义中的选项顺序），数值存 value_num，日期存 value_date；选项代码的含义见 project_fields.choices。',
        'modality','影像记录（imaging_long）的检查方式：ultrasound 超声；ct；mri 磁共振。',
        'tkv_ml','影像记录的总肾体积（mL），由系统按椭球公式自动计算：π/6 × 长 × 宽 × 厚，左右肾相加；只有左右肾三条径线都填写时才有值。没有用分割软件测量，用于 Mayo 分级时需研究者核对。',
        'mayo_image_class','影像记录的 Mayo 影像分型：typical 典型（双肾弥漫、对称的囊肿）；atypical 非典型。只适用于 CT 或磁共振；Mayo 1A–1E 分级只用于典型病例，由分析包计算。',
        'liver_cysts','影像记录的肝囊肿：present 有；absent 无；空值为未记录。'),
      'tables',jsonb_build_object(
      'patients_baseline',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_0 t),
      'visits_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_1 t),
      'labs_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_2 t),
      'meds_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_3 t),
      'variants_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_4 t),
      'events_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_5 t),
      'ktx_baseline_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_6 t),
      'ktx_visits_ext',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_7 t),
      'data_issues',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_8 t),
      'biopsies_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_9 t),
      'project_fields',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_10 t),
      'patient_field_values',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_11 t),
      'imaging_long',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_12 t)
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

-- ---- Serum total bilirubin (TBIL) ---------------------------------------------------------------
-- The existing lab normalization (0040) converts to the standard unit: 1 mg/dL = 17.104 umol/L.
INSERT INTO public.lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  ('TBIL', '血清总胆红素', 'Serum total bilirubin', 'GENERAL', false, '14631-6', 'μmol/L',
           '报告单位为 mg/dL 时由系统换算为 μmol/L（1 mg/dL = 17.104 μmol/L）。参考范围以检测实验室为准。')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  ('TBIL', 'μmol/L', 1,      0, true),
  ('TBIL', 'umol/L', 1,      0, false),
  ('TBIL', 'mg/dL',  17.104, 0, false)
ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

INSERT INTO public.abbreviation_dictionary(abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('TKV',   '总肾体积',           '影像指标', '首次显示建议：总肾体积（Total kidney volume，TKV）'),
  ('htTKV', '身高校正总肾体积',   '影像指标', '首次显示建议：身高校正总肾体积（height-adjusted TKV，htTKV，单位 mL/m）')
ON CONFLICT (abbr) DO NOTHING;

-- ---- Field notes for the workbench and exports ------------------------------------------------
INSERT INTO public.concept_dictionary(code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn, affects_export, affects_qc)
VALUES
  ('modality', 'GENERAL', '影像检查方式', '检查方式', 'ultrasound 超声；ct；mri 磁共振。', '每次影像检查填写。', NULL, true, false),
  ('tkv_ml', 'GENERAL', '总肾体积（椭球公式）', 'TKV', '左右肾三条径线都填写后由系统按 π/6 × 长 × 宽 × 厚计算并相加，不能手工填写。', '系统自动计算。', 'mL', true, false),
  ('mayo_image_class', 'GENERAL', 'Mayo 影像分型（典型 / 非典型）', 'Mayo 分型', '只适用于 CT 或磁共振；Mayo 1A–1E 分级只用于典型病例，由分析包计算。', '有 CT 或磁共振报告时填写。', NULL, true, false)
ON CONFLICT (code) DO UPDATE SET
  domain = EXCLUDED.domain,
  display_name_cn = EXCLUDED.display_name_cn,
  short_name_cn = EXCLUDED.short_name_cn,
  help_text_cn = EXCLUDED.help_text_cn,
  when_to_fill_cn = EXCLUDED.when_to_fill_cn,
  unit_cn = EXCLUDED.unit_cn,
  affects_export = EXCLUDED.affects_export,
  affects_qc = EXCLUDED.affects_qc;

INSERT INTO public.registry_schema_versions(version) VALUES('0047_imaging_records') ON CONFLICT(version) DO NOTHING;
COMMIT;
