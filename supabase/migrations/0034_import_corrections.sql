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
