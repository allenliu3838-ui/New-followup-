-- 0040: batch import of lab results, medications and endpoint events, with per-batch undo.
-- Additive, transactional and safe to re-run on existing production data.
--  * The existing import pipeline (import_registry_rows: one atomic transaction per call,
--    1–500 rows, idempotent per batch id, per-row content hashes in registry_import_records)
--    now also accepts kind 'labs', 'meds' and 'events'. Baseline and visit imports behave
--    exactly as in 0038; each imported record is now also linked to its batch so the batch
--    can be undone. Study status (consent, exit, death) is never changed by any import: it
--    is recorded only through set_patient_study_status. Imports never touch patients_baseline.
--  * eGFR decline and remission are endpoints computed from lab data by the analysis
--    scripts under the study protocol; they are refused by the import
--    (row_<n>_derived_endpoint_not_importable).
--  * Lab rows may be qualitative (result_text such as 阴性 / + / ++, no value or unit):
--    normalization_status 'qualitative', no standard value. Quantitative rows keep using
--    value_raw + unit_symbol + lab_test_code, converted by normalize_lab_row.
--  * Uploaded files are never stored: only the file SHA-256, the file name without its path,
--    and the chunk position (register_import_file). list_import_batches shows the history,
--    undo_import_batch removes the records a visit/lab/medication/event batch inserted,
--    except those corrected since the import (they are kept and counted).
--  * Medication and event rows are now field-audited on update and delete like visits and
--    labs (_registry_audit_changes), so an undo leaves a per-record deletion trail.
--  * The lab dictionaries (lab_test_catalog, lab_test_unit_map) are read-only for signed-in
--    and anonymous callers; only the database owner and service role maintain them.
-- Lock order is unchanged: projects row first (import, correction and undo take it FOR
-- UPDATE), then patient rows.
BEGIN;

-- Preconditions. Nothing below runs unless 0038/0039 are in place, the objects this
-- migration extends exist, and no stored medication ends before it starts.
DO $$
DECLARE missing text; n_bad bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0039_patient_token_hashing')
    OR NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0038_followup_workflow') THEN
    RAISE EXCEPTION '迁移 0040 已中止：尚未执行迁移 0038 与 0039。请先按顺序执行，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.registry_import_batches','public.registry_import_records','public.lab_test_catalog',
      'public.lab_test_unit_map','public.labs_long','public.meds_long','public.events_long']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['trg_normalize_lab_row','registry_audit_lab','tr_labs_trial_lock']) AS t
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.labs_long'::regclass AND tgname=t AND NOT tgisinternal);
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0040 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0039 完整升级，需人工核对后再迁移。',missing;
  END IF;
  SELECT count(*) INTO n_bad FROM public.meds_long WHERE end_date < start_date;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '迁移 0040 已中止：有 % 条用药记录的停药日期早于开始日期。迁移不会自动修改临床数据，需人工核对后再迁移：按原始病历逐条更正这些日期。',n_bad;
  END IF;
END $$;

-- ---- Table changes --------------------------------------------------------------------
ALTER TABLE public.labs_long
  ADD COLUMN IF NOT EXISTS result_text text
    CONSTRAINT labs_long_result_text_length CHECK (char_length(result_text) BETWEEN 1 AND 50),
  ADD COLUMN IF NOT EXISTS ref_range text
    CONSTRAINT labs_long_ref_range_length CHECK (char_length(ref_range) BETWEEN 1 AND 50),
  ADD COLUMN IF NOT EXISTS abnormal_flag text
    CONSTRAINT labs_long_abnormal_flag_check CHECK (abnormal_flag IN ('H','L','N')),
  ADD COLUMN IF NOT EXISTS notes text
    CONSTRAINT labs_long_notes_length CHECK (char_length(notes) <= 500);

ALTER TABLE public.meds_long
  ADD COLUMN IF NOT EXISTS dose_value numeric
    CONSTRAINT meds_long_dose_value_range CHECK (dose_value > 0 AND dose_value < 1000000),
  ADD COLUMN IF NOT EXISTS dose_unit text
    CONSTRAINT meds_long_dose_unit_length CHECK (char_length(dose_unit) BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS indication text
    CONSTRAINT meds_long_indication_length CHECK (char_length(indication) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS notes text
    CONSTRAINT meds_long_notes_length CHECK (char_length(notes) <= 500);
-- No stored row violates this (checked above), so it is added validated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.meds_long'::regclass
    AND conname='meds_long_end_not_before_start') THEN
    ALTER TABLE public.meds_long ADD CONSTRAINT meds_long_end_not_before_start CHECK (end_date >= start_date);
  END IF;
END $$;

-- Three clinical events added to the existing seven. Stored rows all use the old seven.
ALTER TABLE public.events_long DROP CONSTRAINT IF EXISTS events_long_event_type_check,
  ADD CONSTRAINT events_long_event_type_check CHECK (event_type IN ('egfr_decline_40pct','egfr_decline_57pct',
    'esrd','death','complete_remission','partial_remission','custom','dialysis_start','kidney_transplant','relapse'));
ALTER TABLE public.events_long
  ADD COLUMN IF NOT EXISTS evidence_source text
    CONSTRAINT events_long_evidence_source_check
    CHECK (evidence_source IN ('medical_record','lab_review','phone_followup','death_certificate','other')),
  ADD COLUMN IF NOT EXISTS event_detail text
    CONSTRAINT events_long_event_detail_length CHECK (char_length(event_detail) BETWEEN 1 AND 500);

ALTER TABLE public.registry_import_batches DROP CONSTRAINT IF EXISTS registry_import_batches_kind_check,
  ADD CONSTRAINT registry_import_batches_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events'));
ALTER TABLE public.registry_import_records DROP CONSTRAINT IF EXISTS registry_import_records_kind_check,
  ADD CONSTRAINT registry_import_records_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events'));
ALTER TABLE public.registry_import_batches
  ADD COLUMN IF NOT EXISTS file_sha256 text
    CONSTRAINT registry_import_batches_file_sha256_format CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS file_name text
    CONSTRAINT registry_import_batches_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS chunk_index int,
  ADD COLUMN IF NOT EXISTS chunk_total int,
  ADD COLUMN IF NOT EXISTS undo_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS undone_at timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS undo_reason text
    CONSTRAINT registry_import_batches_undo_reason_length CHECK (char_length(undo_reason) BETWEEN 2 AND 500),
  ADD COLUMN IF NOT EXISTS undo_result jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.registry_import_batches'::regclass
    AND conname='registry_import_batches_file_info') THEN
    ALTER TABLE public.registry_import_batches ADD CONSTRAINT registry_import_batches_file_info
      CHECK (num_nulls(file_sha256,file_name,chunk_index,chunk_total) IN (0,4)
        AND (chunk_total IS NULL
          OR (chunk_total >= 1 AND chunk_total <= 100000 AND chunk_index >= 1 AND chunk_index <= chunk_total)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.registry_import_batches'::regclass
    AND conname='registry_import_batches_undo_info') THEN
    ALTER TABLE public.registry_import_batches ADD CONSTRAINT registry_import_batches_undo_info
      CHECK (num_nulls(undone_at,undone_by,undo_reason,undo_result) IN (0,4));
  END IF;
END $$;
-- Which batch wrote or matched each content hash. Rows recorded before 0040 have no batch.
ALTER TABLE public.registry_import_records
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS action text
    CONSTRAINT registry_import_records_action_check CHECK (action IN ('inserted','matched')),
  ADD COLUMN IF NOT EXISTS record_sha256 text
    CONSTRAINT registry_import_records_record_sha256_format CHECK (record_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS registry_import_records_batch_idx
  ON public.registry_import_records(project_id,batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS registry_import_batches_project_created_idx
  ON public.registry_import_batches(project_id,created_at DESC);

COMMENT ON COLUMN public.labs_long.result_text IS '定性结果（如 阴性、+、++），1–50 字；只有定性结果时数值与单位为空，normalization_status 为 qualitative。';
COMMENT ON COLUMN public.labs_long.ref_range IS '化验单上的参考范围原文，1–50 字，仅供核对。';
COMMENT ON COLUMN public.labs_long.abnormal_flag IS '化验单上的异常标记：H 偏高；L 偏低；N 正常。';
COMMENT ON COLUMN public.labs_long.notes IS '备注，最多 500 字，不得含身份信息。';
COMMENT ON COLUMN public.meds_long.dose_value IS '单次剂量数值（大于 0）；与 dose_unit 同时填写时，旧的剂量文本列 dose 为“数值 单位”。';
COMMENT ON COLUMN public.meds_long.dose_unit IS '剂量单位，如 mg、g、IU，1–20 字。';
COMMENT ON COLUMN public.meds_long.indication IS '用药目的，1–100 字。';
COMMENT ON COLUMN public.meds_long.notes IS '备注，最多 500 字，不得含身份信息。';
COMMENT ON COLUMN public.events_long.evidence_source IS '判定依据来源：medical_record 病历；lab_review 化验复核；phone_followup 电话随访；death_certificate 死亡证明；other 其他。';
COMMENT ON COLUMN public.events_long.event_detail IS '事件细节，1–500 字；自定义事件（custom）导入时必填。';
COMMENT ON COLUMN public.registry_import_batches.file_sha256 IS '导入文件的 SHA-256（小写十六进制）；系统不保存上传的原始文件。同一文件的各块相同。';
COMMENT ON COLUMN public.registry_import_batches.file_name IS '导入文件名（已去除路径），最多 200 字。';
COMMENT ON COLUMN public.registry_import_batches.chunk_index IS '本批次是该文件的第几块（从 1 开始）。';
COMMENT ON COLUMN public.registry_import_batches.undo_tracked IS '是否逐条记录了本批次写入的记录（0040 起的随访、化验、用药、终点事件批次）；只有这样的批次可以撤销。';
COMMENT ON COLUMN public.registry_import_batches.undo_result IS '撤销结果：deleted 已删除条数，kept_changed 因导入后已更正而保留的条数，missing 撤销前已不存在的条数。';
COMMENT ON COLUMN public.registry_import_records.action IS 'inserted：该批次新写入的记录；matched：该批次的行与已有记录完全一致而跳过。';
COMMENT ON COLUMN public.registry_import_records.record_sha256 IS '新写入记录在批次结束时的整行摘要；撤销时与当前行比对，不一致说明导入后已被更正。';

-- ---- Lab normalization: qualitative rows -------------------------------------------------
-- 0032's normalization, plus qualitative rows: a mapped test with a result text and neither
-- value nor unit is stored without a standard value (normalization_status 'qualitative').
-- A unit without a value is still refused.
CREATE OR REPLACE FUNCTION registry_private.normalize_lab_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.lab_test_code IS NULL THEN
    NEW.value_standard:=NULL;NEW.standard_unit:=NULL;NEW.normalization_status:='unmapped';
    RETURN NEW;
  END IF;
  IF NEW.value_raw IS NULL AND NEW.unit_symbol IS NULL AND btrim(NEW.result_text) <> '' THEN
    NEW.lab_name:=NEW.lab_test_code;NEW.lab_value:=NULL;NEW.lab_unit:=NULL;
    NEW.value_standard:=NULL;NEW.standard_unit:=NULL;NEW.normalization_status:='qualitative';
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
REVOKE ALL ON FUNCTION registry_private.normalize_lab_row() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_normalize_lab_row ON public.labs_long;
CREATE TRIGGER trg_normalize_lab_row BEFORE INSERT OR UPDATE OF lab_test_code,value_raw,unit_symbol,result_text,
  lab_name,lab_value,lab_unit,value_standard,standard_unit,normalization_status ON public.labs_long
  FOR EACH ROW EXECUTE FUNCTION registry_private.normalize_lab_row();

-- ---- Identifying-information guard and field audit on the new free-text columns ----------
DROP TRIGGER IF EXISTS trg_pii_guard_labs ON public.labs_long;
CREATE TRIGGER trg_pii_guard_labs BEFORE INSERT OR UPDATE ON public.labs_long
  FOR EACH ROW EXECUTE FUNCTION public._pii_guard('qc_reason','notes','result_text','ref_range');
DROP TRIGGER IF EXISTS trg_pii_guard_meds ON public.meds_long;
CREATE TRIGGER trg_pii_guard_meds BEFORE INSERT OR UPDATE ON public.meds_long
  FOR EACH ROW EXECUTE FUNCTION public._pii_guard('notes','indication');
DROP TRIGGER IF EXISTS trg_pii_guard_events ON public.events_long;
CREATE TRIGGER trg_pii_guard_events BEFORE INSERT OR UPDATE ON public.events_long
  FOR EACH ROW EXECUTE FUNCTION public._pii_guard('notes','event_detail');
DROP TRIGGER IF EXISTS registry_audit_med ON public.meds_long;
CREATE TRIGGER registry_audit_med AFTER UPDATE OR DELETE ON public.meds_long
  FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();
DROP TRIGGER IF EXISTS registry_audit_event ON public.events_long;
CREATE TRIGGER registry_audit_event AFTER UPDATE OR DELETE ON public.events_long
  FOR EACH ROW EXECUTE FUNCTION public._registry_audit_changes();

-- ---- Lab dictionaries: read-only ---------------------------------------------------------
-- Readable through the existing catalog_select/map_select policies. Writes (including
-- TRUNCATE, which row-level security does not cover) belong to the owner and service role.
REVOKE ALL ON public.lab_test_catalog,public.lab_test_unit_map FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.lab_test_catalog,public.lab_test_unit_map TO anon,authenticated;

-- ---- No TRUNCATE / TRIGGER / REFERENCES for client roles on any public table -------------
-- Row-level security does not apply to TRUNCATE, so a default Supabase grant would let any
-- signed-in user empty every project's data. Client roles never need these privileges; the
-- owner and service role keep them. Default privileges cover tables created later by postgres.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind IN ('r','p') LOOP
    EXECUTE format('REVOKE TRUNCATE,TRIGGER,REFERENCES ON %s FROM PUBLIC,anon,authenticated', r.rel);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE,TRIGGER,REFERENCES ON TABLES FROM PUBLIC,anon,authenticated;

-- ---- Input columns and validation ----------------------------------------------------------
-- Baseline and visit columns are 0038's. Labs, medications and events list the columns an
-- import row may carry; labs keep measured_at, which the audited correction already accepts.
CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit',
    'consent_status','consent_date','consent_version','followup_status','followup_status_date',
    'biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class',
    'ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date']
  WHEN 'visits' THEN ARRAY['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes']
  WHEN 'labs' THEN ARRAY['patient_code','lab_date','lab_test_code','value_raw','unit_symbol','result_text',
    'ref_range','abnormal_flag','notes','measured_at']
  WHEN 'meds' THEN ARRAY['patient_code','drug_name','drug_class','dose_value','dose_unit','route','frequency',
    'start_date','end_date','indication','notes']
  WHEN 'events' THEN ARRAY['patient_code','event_type','event_date','event_detail','evidence_source','notes']
  ELSE NULL::text[] END;
$$;

-- Field-by-field checks for lab, medication and event values (import rows and lab
-- corrections). Raises "<code>" or "<code>: <column>"; the import adds "row_<n>_".
-- Dates: ISO yyyy-mm-dd, a real calendar date, from 1900-01-01 to today (Beijing).
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
      'partial_remission','custom','dialysis_start','kidney_transplant','relapse') THEN RAISE EXCEPTION 'invalid_event_type';
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

-- Whole-row rules for one lab, medication or event row (the values already passed
-- validate_clinical_input). Used by the import and, for labs, by the audited correction
-- on the row as it would be after the change.
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
    IF p_row->>'event_type' = 'custom' AND p_row->>'event_detail' IS NULL THEN
      RAISE EXCEPTION 'event_detail_required' USING HINT='自定义事件请在 event_detail 中写明事件内容。';
    END IF;
  ELSE RAISE EXCEPTION 'invalid_import_request';
  END IF;
END $$;
REVOKE ALL ON FUNCTION registry_private.check_clinical_row(text,jsonb) FROM PUBLIC,anon,authenticated;

-- Digest of a whole clinical row, rendered in UTC so that it does not depend on the
-- session time zone. Computed when an import batch ends and compared on undo.
CREATE OR REPLACE FUNCTION registry_private.import_record_digest(p_table text,p_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
DECLARE r jsonb;
BEGIN
  IF p_table IS NULL OR p_table NOT IN ('visits_long','labs_long','meds_long','events_long') THEN
    RAISE EXCEPTION 'unsupported_record_type';
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id=$1',p_table) INTO r USING p_id;
  RETURN encode(sha256(convert_to(r::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION registry_private.import_record_digest(text,uuid) FROM PUBLIC,anon,authenticated;

-- One lab, medication or event import row. Every refusal names the row:
-- row_<n>_<code> or row_<n>_<code>: <column>, and the whole batch is rolled back.
-- Duplicates follow the visit rule: a row identical to a stored record (business key and
-- every given column) is skipped and linked; the same business key with different content
-- refuses the batch (row_<n>_same_key_record_conflict). Business keys: labs = patient +
-- lab date + test code; medications = patient + drug name + start date; events = patient +
-- event type + event date. Returns 'inserted' or 'skipped'.
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
    IF p_kind = 'events' AND clean->>'event_type' NOT IN ('esrd','dialysis_start','kidney_transplant','death','relapse','custom') THEN
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
    WHERE project_id=p_project_id AND kind=p_kind AND content_sha256=row_hash;
  IF rec_id IS NOT NULL THEN
    EXECUTE format('SELECT CASE WHEN to_jsonb(t) @> $2 THEN 1 ELSE 0 END FROM public.%I t WHERE t.id=$1 AND t.project_id=$3',tbl)
      INTO k USING rec_id,clean,p_project_id;
    IF k IS NULL THEN RAISE EXCEPTION 'row_%_previously_imported_record_deleted_requires_review',p_row_no
      USING HINT='同样内容曾经导入，但该记录之后被删除；请先核实是否应重新录入。本批次未写入。'; END IF;
    IF k = '0' THEN RAISE EXCEPTION 'row_%_record_changed_since_import',p_row_no
      USING HINT = '记录已在导入后更正，请核对当前记录；不会覆盖更正或默默跳过差异。'; END IF;
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

-- 0038's validation for baseline and visit values, unchanged; lab, medication and event
-- values are checked by registry_private.validate_clinical_input.
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

-- 0038's import, unchanged for baseline and visits except that each visit record written
-- or matched is linked to its batch (for undo). Kind 'labs', 'meds' and 'events' rows are
-- handled by registry_private.import_clinical_row; none of them touches patients_baseline,
-- so the study status rules of 0038 are unaffected.
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
  IF p_kind IS NULL OR p_kind NOT IN ('baseline','visits','labs','meds','events') OR p_batch_id IS NULL THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
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
    IF p_kind IN ('labs','meds','events') THEN
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
      WHEN 'meds' THEN 'meds_long' ELSE 'events_long' END;
    UPDATE public.registry_import_records ir SET record_sha256=registry_private.import_record_digest(record_table,ir.record_id)
      WHERE ir.project_id=p_project_id AND ir.kind=p_kind AND ir.batch_id=p_batch_id AND ir.action='inserted';
  END IF;
  result := jsonb_build_object('inserted',added,'updated',changed,'skipped',skipped,'total',row_no,'replayed',false);
  INSERT INTO public.registry_import_batches(project_id,batch_id,kind,content_sha256,actor_id,result,undo_tracked)
    VALUES(p_project_id,p_batch_id,p_kind,payload_hash,auth.uid(),result,p_kind <> 'baseline');
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN result;
END $$;

-- 0038's audited correction, unchanged except for lab records: the corrected row must
-- still be a complete lab row (registry_private.check_clinical_row: date, mapped test,
-- value with an allowed unit or a qualitative result), and it is updated in place like
-- the other record types, so qualitative results, reference range, flag and notes can be
-- corrected too. Unit conversion and checks stay in normalize_lab_row.
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
  IF kind = 'labs' THEN
    PERFORM registry_private.check_clinical_row('labs',before_row || changes);
  END IF;
  IF kind = 'visits' THEN
    IF changes ? 'egfr' THEN
      changes := changes || jsonb_build_object('egfr_formula_version',CASE WHEN changes->>'egfr' IS NULL THEN NULL ELSE 'manual' END);
    END IF;
    IF changes ? 'visit_date' AND changes->>'visit_date' IS NULL THEN RAISE EXCEPTION 'visit_date_required'; END IF;
    PERFORM public._registry_validate_visit_payload(p_project_id,before_row || changes,p_record_id);
  END IF;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason',btrim(p_reason),true);
  changes := changes || jsonb_build_object('qc_reason',btrim(p_reason));
  SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.%I,$1)).%I',key,p_table,key),',' ORDER BY key)
    INTO assignments FROM jsonb_object_keys(changes) AS keys(key);
  EXECUTE format('UPDATE public.%I SET %s WHERE id=$2 AND project_id=$3',p_table,assignments)
    USING changes,p_record_id,p_project_id;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND project_id=$2',p_table)
    INTO after_row USING p_record_id,p_project_id;
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN jsonb_build_object('record',after_row,'changed',before_row IS DISTINCT FROM after_row);
END $$;

-- File details of one import chunk, recorded by the workbench after that chunk's
-- import_registry_rows call succeeded. Only the caller's own batch in the project, with
-- write permission. The file itself is never sent: a lowercase hex SHA-256, the file name
-- without any path (at most 200 characters, no identifying information) and the chunk
-- position (1-based). Repeating the same details is a no-op; different details for a batch
-- that already has them are refused. Recording file details is not a data write, so it is
-- not blocked when the account trial has ended.
CREATE OR REPLACE FUNCTION public.register_import_file(p_project_id uuid,p_batch_id uuid,p_file_sha256 text,
  p_file_name text,p_chunk_index int,p_chunk_total int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.registry_import_batches%ROWTYPE; fname text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_file_sha256' USING HINT='文件摘要应为 64 位小写十六进制 SHA-256。';
  END IF;
  fname := btrim(regexp_replace(coalesce(p_file_name,''),'^.*[/\\]',''));
  IF fname = '' OR char_length(fname) > 200 OR fname ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_file_name' USING HINT='文件名不能为空，最多 200 个字符。';
  END IF;
  IF public._contains_pii(fname) THEN
    RAISE EXCEPTION 'file_name_contains_pii'
      USING HINT='文件名疑似含个人信息（姓名、手机号、身份证号、病案号等），请改名后重新导入。';
  END IF;
  IF p_chunk_total IS NULL OR p_chunk_index IS NULL OR p_chunk_total NOT BETWEEN 1 AND 100000
    OR p_chunk_index NOT BETWEEN 1 AND p_chunk_total THEN
    RAISE EXCEPTION 'invalid_chunk_info' USING HINT='块序号从 1 开始，且不超过总块数。';
  END IF;
  SELECT * INTO b FROM public.registry_import_batches
    WHERE project_id=p_project_id AND batch_id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import_batch_not_found'; END IF;
  IF b.actor_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'import_batch_not_yours' USING HINT='只能登记自己导入的批次的文件信息。';
  END IF;
  IF b.file_sha256 IS NOT NULL THEN
    IF (b.file_sha256,b.file_name,b.chunk_index,b.chunk_total) IS NOT DISTINCT FROM (p_file_sha256,fname,p_chunk_index,p_chunk_total) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'import_file_already_registered' USING HINT='该批次已登记了不同的文件信息。';
  END IF;
  UPDATE public.registry_import_batches SET file_sha256=p_file_sha256,file_name=fname,
    chunk_index=p_chunk_index,chunk_total=p_chunk_total
    WHERE project_id=p_project_id AND batch_id=p_batch_id;
END $$;

-- Import history of a project for any member who may read it, newest first (at most
-- p_limit rows, 1–500). The importer's e-mail is read from the account table by this
-- function, never exposed through a table grant.
CREATE OR REPLACE FUNCTION public.list_import_batches(p_project_id uuid,p_limit int DEFAULT 100)
RETURNS TABLE(batch_id uuid,kind text,created_at timestamptz,created_by_email text,inserted int,updated int,
  skipped int,total int,file_sha256 text,file_name text,chunk_index int,chunk_total int,undo_supported boolean,
  undone_at timestamptz,undo_reason text,undo_result jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'read');
  RETURN QUERY
    SELECT b.batch_id,b.kind,b.created_at,u.email::text,
      (b.result->>'inserted')::int,(b.result->>'updated')::int,(b.result->>'skipped')::int,(b.result->>'total')::int,
      b.file_sha256,b.file_name,b.chunk_index,b.chunk_total,b.undo_tracked AND b.undone_at IS NULL,
      b.undone_at,b.undo_reason,b.undo_result
    FROM public.registry_import_batches b
    LEFT JOIN auth.users u ON u.id=b.actor_id
    WHERE b.project_id=p_project_id
    ORDER BY b.created_at DESC,b.batch_id
    LIMIT least(greatest(coalesce(p_limit,100),1),500);
END $$;

-- Undo one visit, lab, medication or event batch (owner or editor, account allowed to
-- write; reason of 2–500 characters without identifying information). Deletes each record
-- the batch inserted that is unchanged since the batch ended (whole-row digest); a record
-- corrected since then is kept (kept_changed) and stays linked, so re-importing the old
-- content is refused rather than silently skipped. Rows the batch skipped belong to
-- existing records and are never deleted. Each deletion is field-audited with the reason
-- (_registry_audit_changes) and the undo is written to the project audit log. A batch
-- already undone returns its earlier result with already_undone = true and changes nothing.
-- Baseline batches are refused (patients are not removed this way), and so are batches
-- imported before 0040, which did not record the records they wrote.
CREATE OR REPLACE FUNCTION public.undo_import_batch(p_project_id uuid,p_batch_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE b public.registry_import_batches%ROWTYPE; reason text := btrim(p_reason); tbl text; m record;
  n_deleted int := 0; n_kept int := 0; n_missing int := 0; old_reason text; outcome jsonb; found_id uuid;
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
  IF b.kind NOT IN ('visits','labs','meds','events') THEN
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
    WHEN 'meds' THEN 'meds_long' ELSE 'events_long' END;
  old_reason := current_setting('app.registry_change_reason',true);
  PERFORM set_config('app.registry_change_reason','撤销导入批次 ' || p_batch_id::text || '：' || reason,true);
  FOR m IN SELECT r.content_sha256,r.record_id,r.record_sha256 FROM public.registry_import_records r
    WHERE r.project_id=p_project_id AND r.kind=b.kind AND r.batch_id=p_batch_id AND r.action='inserted'
    ORDER BY r.record_id LOOP
    EXECUTE format('SELECT t.id FROM public.%I t WHERE t.id=$1 AND t.project_id=$2 FOR UPDATE',tbl)
      INTO found_id USING m.record_id,p_project_id;
    IF found_id IS NULL THEN
      n_missing := n_missing+1;
    ELSIF registry_private.import_record_digest(tbl,m.record_id) IS DISTINCT FROM m.record_sha256 THEN
      n_kept := n_kept+1;
      CONTINUE;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE id=$1 AND project_id=$2',tbl) USING m.record_id,p_project_id;
      n_deleted := n_deleted+1;
    END IF;
    DELETE FROM public.registry_import_records
      WHERE project_id=p_project_id AND kind=b.kind AND content_sha256=m.content_sha256;
  END LOOP;
  outcome := jsonb_build_object('deleted',n_deleted,'kept_changed',n_kept,'missing',n_missing,'already_undone',false);
  UPDATE public.registry_import_batches SET undone_at=now(),undone_by=auth.uid(),undo_reason=reason,
    undo_result=outcome - 'already_undone'
    WHERE project_id=p_project_id AND batch_id=p_batch_id;
  INSERT INTO public.audit_log(project_id,actor_uid,action,details)
    VALUES(p_project_id,auth.uid(),'import_batch_undone',jsonb_build_object('batch_id',p_batch_id,'kind',b.kind,
      'reason',reason,'deleted',n_deleted,'kept_changed',n_kept,'missing',n_missing,
      'file_sha256',b.file_sha256,'chunk_index',b.chunk_index,'chunk_total',b.chunk_total));
  PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
  RETURN outcome;
END $$;

REVOKE ALL ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text),
  public.register_import_file(uuid,uuid,text,text,int,int),public.list_import_batches(uuid,int),
  public.undo_import_batch(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid),
  public.correct_registry_record(uuid,text,uuid,jsonb,text),
  public.register_import_file(uuid,uuid,text,text,int,int),public.list_import_batches(uuid,int),
  public.undo_import_batch(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public._registry_input_columns(text),public._registry_validate_input(text,jsonb)
  FROM PUBLIC,anon,authenticated;
COMMENT ON FUNCTION public.import_registry_rows(uuid,text,jsonb,uuid) IS
  '原子批量导入（每次 1–500 行，按批次号幂等）：baseline 患者基线、visits 随访、labs 化验、meds 用药、events 终点事件。研究状态只能经 set_patient_study_status 修改；eGFR 下降与缓解终点不接受导入。';
COMMENT ON FUNCTION public.undo_import_batch(uuid,uuid,text) IS
  '撤销一个随访/化验/用药/终点事件导入批次：删除该批次新写入且导入后未被修改的记录，已更正的记录保留（kept_changed）；须填写原因并写入审计。';

INSERT INTO public.registry_schema_versions(version) VALUES('0040_batch_import') ON CONFLICT(version) DO NOTHING;
COMMIT;
