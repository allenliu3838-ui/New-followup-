-- 0044: custom enrollment fields defined per project.
-- Additive, transactional and safe to re-run. No stored value is changed.
--  * public.project_fields: the fields a project defines, changed only by the project owner through
--    save_project_field: a stable key, a Chinese label and help text, a type (choice,
--    multi_choice, yes_no, number, date, text), the options of a choice, the unit and range of a
--    number, the display order, whether the field is in use and where its definition came from.
--    A key and its type never change; an option code is never removed (labels may be edited and
--    options added); a field leaves the forms by being deactivated, so values recorded under it
--    keep their meaning. Labels are unique within a project (CSV headers may use them).
--  * public.patient_field_values: one value per patient and field, checked against the field's
--    definition on every write path (trigger). It has the protections of the other clinical
--    tables: member row security, immutable identity, the read-only lock and created/updated
--    metadata; its audit names the field (field_audit_log.field_name = 'x_' || key) with the old
--    and new value as text, for changes and deletions.
--  * public.set_patient_field_values: saves several fields of one patient in one call.
--  * Batch import kind 'fields': one row per patient with a column per field key. Blank cells are
--    ignored; a value that already exists and differs refuses the batch (no silent overwrite);
--    undo like the other kinds.
--  * The frozen export carries project_fields and patient_field_values with field notes.
--  * Re-created from 0043's text with only these additions (generated, see commit message):
--    import_record_digest, import_registry_rows, undo_import_batch, create_registry_export.
BEGIN;

DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0043_biopsy_records') THEN
    RAISE EXCEPTION '迁移 0044 已中止：尚未执行迁移 0043。请先按顺序执行 0032–0043，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.projects','public.patients_baseline','public.registry_import_batches',
      'public.registry_import_records','public.field_audit_log','public.audit_log','public.biopsies_long']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['registry_private.import_record_digest(text,uuid)','public.import_registry_rows(uuid,text,jsonb,uuid)',
        'public.undo_import_batch(uuid,uuid,text)','public.create_registry_export(uuid,uuid)',
        'registry_private.guard_clinical_identity()','public._set_created_by()','public._trial_block_write()',
        'public._set_updated_meta()','public._contains_pii(text)','registry_private.local_today()',
        'registry_private.project_ids_with_permission(text)','public.assert_project_permission(uuid,text)',
        'public.assert_project_write_allowed(uuid)']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0044 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0043 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Field definitions (project_fields) -----------------------------------------------------
-- Options: 2–60 objects {code, label}; codes are lower-case ASCII, labels 1–60 characters; both
-- unique within the field.
CREATE OR REPLACE FUNCTION registry_private.valid_field_choices(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p) = 'array' AND jsonb_array_length(p) BETWEEN 2 AND 60
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p) e
      WHERE jsonb_typeof(e) <> 'object' OR NOT (e ? 'code' AND e ? 'label')
        OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 2
        OR jsonb_typeof(e->'code') <> 'string' OR jsonb_typeof(e->'label') <> 'string'
        OR (e->>'code') !~ '^[a-z0-9_]{1,40}$'
        OR char_length(e->>'label') NOT BETWEEN 1 AND 60 OR (e->>'label') <> btrim(e->>'label')
        OR (e->>'label') ~ '[[:cntrl:]]')
    AND (SELECT count(DISTINCT e->>'code') FROM jsonb_array_elements(p) e) = jsonb_array_length(p)
    AND (SELECT count(DISTINCT e->>'label') FROM jsonb_array_elements(p) e) = jsonb_array_length(p)
$$;
REVOKE ALL ON FUNCTION registry_private.valid_field_choices(jsonb) FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS public.project_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  field_key   text NOT NULL,
  label_cn    text NOT NULL,
  help_cn     text,
  value_type  text NOT NULL,
  choices     jsonb,
  unit        text,
  min_value   numeric,
  max_value   numeric,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  source      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_fields_key_format CHECK (field_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Bounds are written as two comparisons, not BETWEEN inside AND: the stored definition then
  -- survives pg_dump/pg_restore unchanged (a BETWEEN nested in AND is flattened on restore).
  CONSTRAINT project_fields_label_text CHECK (char_length(label_cn) >= 1 AND char_length(label_cn) <= 60 AND label_cn = btrim(label_cn) AND label_cn !~ '[[:cntrl:]]'),
  CONSTRAINT project_fields_help_text CHECK (help_cn IS NULL OR (char_length(help_cn) >= 1 AND char_length(help_cn) <= 300 AND help_cn !~ '[[:cntrl:]]')),
  CONSTRAINT project_fields_type_check CHECK (value_type IN ('choice','multi_choice','yes_no','number','date','text')),
  CONSTRAINT project_fields_choices_shape CHECK ((value_type IN ('choice','multi_choice')) = (choices IS NOT NULL)
    AND (choices IS NULL OR registry_private.valid_field_choices(choices))),
  CONSTRAINT project_fields_number_only CHECK (value_type = 'number' OR (unit IS NULL AND min_value IS NULL AND max_value IS NULL)),
  CONSTRAINT project_fields_range_order CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CONSTRAINT project_fields_range_finite CHECK ((min_value IS NULL OR min_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))
    AND (max_value IS NULL OR max_value NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric))),
  CONSTRAINT project_fields_unit_text CHECK (unit IS NULL OR (char_length(unit) >= 1 AND char_length(unit) <= 20 AND unit !~ '[[:cntrl:]]')),
  CONSTRAINT project_fields_sort_range CHECK (sort_order BETWEEN 0 AND 99999),
  CONSTRAINT project_fields_source_text CHECK (source IS NULL OR (char_length(source) >= 1 AND char_length(source) <= 60 AND source !~ '[[:cntrl:]]')),
  CONSTRAINT project_fields_key_unique UNIQUE (project_id, field_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_fields_label_unique ON public.project_fields(project_id, label_cn);
COMMENT ON TABLE public.project_fields IS
  '项目自定义入组字段的定义（只由项目负责人通过 save_project_field 修改）。字段代码与类型创建后不变；已有选项代码不能删除（可改显示名称、可增加选项）；不再使用的字段停用而不删除，已录入的值保持原意。';
COMMENT ON COLUMN public.project_fields.value_type IS 'choice 单选；multi_choice 多选；yes_no 是/否；number 数值（可带单位与范围）；date 日期；text 文本（最多 200 字）。';
COMMENT ON COLUMN public.project_fields.choices IS '单选、多选的选项：[{"code": 选项代码, "label": 显示名称}]，2–60 个。';
COMMENT ON COLUMN public.project_fields.source IS '定义来源说明，例如“REIGNITE 入组字段草案”。';

ALTER TABLE public.project_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_read ON public.project_fields;
CREATE POLICY member_read ON public.project_fields FOR SELECT TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('read')));
-- Definitions change only through save_project_field (owner); no direct client writes.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES ON public.project_fields FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.project_fields TO authenticated;

-- ---- Field values (patient_field_values) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patient_field_values (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  patient_code  text NOT NULL,
  field_key     text NOT NULL,
  value_text    text,
  value_codes   text[],
  value_num     numeric,
  value_date    date,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_field_values_one_value CHECK (num_nonnulls(value_text, value_codes, value_num, value_date) = 1),
  CONSTRAINT patient_field_values_text_length CHECK (value_text IS NULL OR char_length(value_text) BETWEEN 1 AND 200),
  CONSTRAINT patient_field_values_codes_size CHECK (value_codes IS NULL OR cardinality(value_codes) BETWEEN 1 AND 60),
  CONSTRAINT patient_field_values_patient_fk FOREIGN KEY (project_id,patient_code)
    REFERENCES public.patients_baseline(project_id,patient_code) ON UPDATE CASCADE ON DELETE NO ACTION
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT patient_field_values_field_fk FOREIGN KEY (project_id,field_key)
    REFERENCES public.project_fields(project_id,field_key) ON DELETE NO ACTION,
  CONSTRAINT patient_field_values_unique UNIQUE (project_id,patient_code,field_key)
);
COMMENT ON TABLE public.patient_field_values IS
  '自定义入组字段的取值：每位患者每个字段一行，写入时按字段定义校验（选项、范围、日期、文本与身份信息）。修改与删除记入字段审计（field_name 为 x_字段代码）。';

-- Display text of a stored value (audit and messages): codes joined by ';'.
CREATE OR REPLACE FUNCTION registry_private.field_value_text(p_text text,p_codes text[],p_num numeric,p_date date)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(p_text, array_to_string(p_codes,';'), p_num::text, p_date::text)
$$;
REVOKE ALL ON FUNCTION registry_private.field_value_text(text,text[],numeric,date) FROM PUBLIC,anon,authenticated;

-- Every write path is checked against the definition. Definer rights read the definition and
-- today's research date; callers without write permission on the project are refused first, so
-- the check cannot be used to probe another project's fields.
CREATE OR REPLACE FUNCTION registry_private.check_patient_field_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f public.project_fields%ROWTYPE; allowed text; v_role text := current_setting('role',true);
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(v_role,'') NOT IN ('service_role','supabase_admin','postgres')
    AND NOT EXISTS (SELECT 1 FROM registry_private.project_ids_with_permission('write') p WHERE p = NEW.project_id) THEN
    RAISE EXCEPTION 'project_access_denied' USING ERRCODE='42501';
  END IF;
  -- A value belongs to one field for good (the audit names the field).
  IF TG_OP = 'UPDATE' AND NEW.field_key IS DISTINCT FROM OLD.field_key THEN
    RAISE EXCEPTION 'field_key_is_immutable';
  END IF;
  SELECT * INTO f FROM public.project_fields WHERE project_id=NEW.project_id AND field_key=NEW.field_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_field: %',NEW.field_key
      USING HINT=format('本项目没有代码为 %s 的自定义入组字段。',NEW.field_key);
  END IF;
  IF NOT f.active AND (TG_OP = 'INSERT' OR registry_private.field_value_text(NEW.value_text,NEW.value_codes,NEW.value_num,NEW.value_date)
      IS DISTINCT FROM registry_private.field_value_text(OLD.value_text,OLD.value_codes,OLD.value_num,OLD.value_date)) THEN
    RAISE EXCEPTION 'field_inactive: %',f.field_key
      USING HINT=format('“%s”已停用，不能再录入；需要继续使用时请项目负责人在“自定义入组字段”中重新启用。',f.label_cn);
  END IF;
  IF f.value_type IN ('choice','multi_choice') THEN
    SELECT string_agg(format('%s（%s）',c->>'label',c->>'code'),'、' ORDER BY n) INTO allowed
      FROM jsonb_array_elements(f.choices) WITH ORDINALITY AS t(c,n);
  END IF;
  IF f.value_type = 'choice' AND (NEW.value_text IS NULL
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.choices) c WHERE c->>'code' = NEW.value_text)) THEN
    RAISE EXCEPTION 'invalid_field_value: %',f.field_key USING HINT=format('“%s”只能填：%s。',f.label_cn,allowed);
  ELSIF f.value_type = 'multi_choice' THEN
    IF NEW.value_codes IS NULL OR cardinality(NEW.value_codes) = 0
      OR EXISTS (SELECT 1 FROM unnest(NEW.value_codes) x WHERE x IS NULL
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.choices) c WHERE c->>'code' = x))
      OR (SELECT count(DISTINCT x) FROM unnest(NEW.value_codes) x) <> cardinality(NEW.value_codes) THEN
      RAISE EXCEPTION 'invalid_field_value: %',f.field_key
        USING HINT=format('“%s”可多选：%s；多个选项用分号分隔，不能重复。',f.label_cn,allowed);
    END IF;
    -- Stored in the order of the definition, so equal selections are equal values.
    NEW.value_codes := ARRAY(SELECT c->>'code' FROM jsonb_array_elements(f.choices) WITH ORDINALITY AS t(c,n)
      WHERE (c->>'code') = ANY(NEW.value_codes) ORDER BY n);
  ELSIF f.value_type = 'yes_no' AND (NEW.value_text IS NULL OR NEW.value_text NOT IN ('yes','no')) THEN
    RAISE EXCEPTION 'invalid_field_value: %',f.field_key USING HINT=format('“%s”只能填“是”或“否”。',f.label_cn);
  ELSIF f.value_type = 'number' AND (NEW.value_num IS NULL OR NEW.value_num IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
      OR NEW.value_num < f.min_value OR NEW.value_num > f.max_value) THEN
    RAISE EXCEPTION 'invalid_field_value: %',f.field_key
      USING HINT=format('“%s”须为数字%s%s。',f.label_cn,
        CASE WHEN f.min_value IS NULL AND f.max_value IS NULL THEN ''
          ELSE format('，范围 %s–%s',coalesce(f.min_value::text,'不限'),coalesce(f.max_value::text,'不限')) END,
        CASE WHEN f.unit IS NULL THEN '' ELSE format('（%s）',f.unit) END);
  ELSIF f.value_type = 'date' AND (NEW.value_date IS NULL OR NEW.value_date < DATE '1900-01-01'
      OR NEW.value_date > registry_private.local_today()) THEN
    RAISE EXCEPTION 'invalid_field_value: %',f.field_key
      USING HINT=format('“%s”须为不晚于今天（北京时间）、不早于 1900-01-01 的日期。',f.label_cn);
  ELSIF f.value_type = 'text' THEN
    IF NEW.value_text IS NULL OR char_length(NEW.value_text) NOT BETWEEN 1 AND 200 OR NEW.value_text <> btrim(NEW.value_text)
      OR NEW.value_text ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid_field_value: %',f.field_key
        USING HINT=format('“%s”为 1–200 字的单行文字，不能含换行等控制字符。',f.label_cn);
    END IF;
    IF public._contains_pii(NEW.value_text) THEN
      RAISE EXCEPTION 'pii_detected_blocked: %',f.field_key
        USING HINT=format('“%s”中检测到疑似个人身份信息（手机号、身份证号、住院号/病案号、姓名、邮箱或 8 位以上连续数字），请删除后重试。',f.label_cn);
    END IF;
  END IF;
  -- The value must sit in the column of the field's type (one value column per row).
  IF (f.value_type IN ('choice','yes_no','text') AND NEW.value_text IS NULL)
    OR (f.value_type = 'multi_choice' AND NEW.value_codes IS NULL)
    OR (f.value_type = 'number' AND NEW.value_num IS NULL)
    OR (f.value_type = 'date' AND NEW.value_date IS NULL) THEN
    RAISE EXCEPTION 'invalid_field_value: %',f.field_key USING HINT=format('“%s”的取值类型不正确。',f.label_cn);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.check_patient_field_value() FROM PUBLIC,anon,authenticated;

-- Field audit naming the field; insertions are not audited (as for the other clinical tables).
CREATE OR REPLACE FUNCTION registry_private.audit_patient_field_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE before_v text; after_v text; reason text := nullif(current_setting('app.registry_change_reason',true),'');
BEGIN
  before_v := registry_private.field_value_text(OLD.value_text,OLD.value_codes,OLD.value_num,OLD.value_date);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
      VALUES(TG_TABLE_NAME,OLD.id,OLD.project_id,OLD.patient_code,'x_'||OLD.field_key,before_v,NULL,auth.uid(),
        coalesce(reason,'清除取值'));
    RETURN OLD;
  END IF;
  after_v := registry_private.field_value_text(NEW.value_text,NEW.value_codes,NEW.value_num,NEW.value_date);
  IF before_v IS DISTINCT FROM after_v THEN
    INSERT INTO public.field_audit_log(table_name,record_id,project_id,patient_code,field_name,old_value,new_value,changed_by,change_reason)
      VALUES(TG_TABLE_NAME,NEW.id,NEW.project_id,NEW.patient_code,'x_'||NEW.field_key,before_v,after_v,auth.uid(),
        coalesce(reason,'通过数据录入更新'));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.audit_patient_field_value() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS a_registry_identity ON public.patient_field_values;
CREATE TRIGGER a_registry_identity BEFORE UPDATE ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION registry_private.guard_clinical_identity();
DROP TRIGGER IF EXISTS registry_field_value_check ON public.patient_field_values;
CREATE TRIGGER registry_field_value_check BEFORE INSERT OR UPDATE ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION registry_private.check_patient_field_value();
DROP TRIGGER IF EXISTS registry_audit_field_value ON public.patient_field_values;
CREATE TRIGGER registry_audit_field_value AFTER UPDATE OR DELETE ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION registry_private.audit_patient_field_value();
DROP TRIGGER IF EXISTS tr_field_values_created_by ON public.patient_field_values;
CREATE TRIGGER tr_field_values_created_by BEFORE INSERT ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION public._set_created_by();
DROP TRIGGER IF EXISTS tr_field_values_trial_lock ON public.patient_field_values;
CREATE TRIGGER tr_field_values_trial_lock BEFORE INSERT OR UPDATE OR DELETE ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION public._trial_block_write();
DROP TRIGGER IF EXISTS tr_field_values_updated_meta ON public.patient_field_values;
CREATE TRIGGER tr_field_values_updated_meta BEFORE UPDATE ON public.patient_field_values
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_meta();

ALTER TABLE public.patient_field_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_read ON public.patient_field_values;
CREATE POLICY member_read ON public.patient_field_values FOR SELECT TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('read')));
DROP POLICY IF EXISTS member_insert ON public.patient_field_values;
CREATE POLICY member_insert ON public.patient_field_values FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
DROP POLICY IF EXISTS member_update ON public.patient_field_values;
CREATE POLICY member_update ON public.patient_field_values FOR UPDATE TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('write')))
  WITH CHECK (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
DROP POLICY IF EXISTS member_delete ON public.patient_field_values;
CREATE POLICY member_delete ON public.patient_field_values FOR DELETE TO authenticated
  USING (project_id IN (SELECT registry_private.project_ids_with_permission('write')));
REVOKE TRUNCATE,TRIGGER,REFERENCES ON public.patient_field_values FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.patient_field_values TO authenticated;
-- 0043's table, explicitly: client roles never truncate (row security does not cover TRUNCATE).
REVOKE TRUNCATE,TRIGGER,REFERENCES ON public.biopsies_long FROM PUBLIC,anon,authenticated;

-- ---- API values -> value columns ----------------------------------------------------------------
-- A choice is its code; several choices an array of codes or one text with ';' between codes;
-- yes/no is 'yes'/'no' (or a JSON boolean); a number a JSON number or plain decimal text; a date
-- YYYY-MM-DD; text is trimmed. Null or blank means "no value". Domain rules (options, range,
-- dates, identifying information) are the table trigger's.
CREATE OR REPLACE FUNCTION registry_private.field_value_columns(p_type text,p_key text,v jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE t text; codes text[]; d date;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    t := btrim(v #>> '{}');
    IF t = '' THEN RETURN NULL; END IF;
  END IF;
  IF p_type IN ('choice','text') THEN
    IF t IS NULL THEN RAISE EXCEPTION 'invalid_field_value: %',p_key; END IF;
    RETURN jsonb_build_object('value_text',t);
  ELSIF p_type = 'multi_choice' THEN
    IF jsonb_typeof(v) = 'array' THEN
      IF jsonb_array_length(v) = 0 THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN
        RAISE EXCEPTION 'invalid_field_value: %',p_key;
      END IF;
      codes := ARRAY(SELECT btrim(e) FROM jsonb_array_elements_text(v) AS x(e));
    ELSIF t IS NOT NULL THEN
      codes := ARRAY(SELECT btrim(x) FROM unnest(string_to_array(t,';')) AS u(x));
    ELSE RAISE EXCEPTION 'invalid_field_value: %',p_key;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(codes) x WHERE x = '') THEN RAISE EXCEPTION 'invalid_field_value: %',p_key; END IF;
    RETURN jsonb_build_object('value_codes',to_jsonb(codes));
  ELSIF p_type = 'yes_no' THEN
    IF jsonb_typeof(v) = 'boolean' THEN
      RETURN jsonb_build_object('value_text',CASE WHEN v = 'true'::jsonb THEN 'yes' ELSE 'no' END);
    END IF;
    IF t IN ('yes','no') THEN RETURN jsonb_build_object('value_text',t); END IF;
    RAISE EXCEPTION 'invalid_field_value: %',p_key;
  ELSIF p_type = 'number' THEN
    IF jsonb_typeof(v) = 'number' THEN RETURN jsonb_build_object('value_num',v); END IF;
    IF t ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' AND char_length(t) <= 30 THEN
      RETURN jsonb_build_object('value_num',t::numeric);
    END IF;
    RAISE EXCEPTION 'invalid_field_value: %',p_key;
  ELSIF p_type = 'date' THEN
    IF t IS NULL OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',p_key; END IF;
    BEGIN d := t::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_iso_date: %',p_key; END;
    IF d::text <> t THEN RAISE EXCEPTION 'invalid_iso_date: %',p_key; END IF;
    RETURN jsonb_build_object('value_date',t);
  END IF;
  RAISE EXCEPTION 'invalid_field_value: %',p_key;
END $$;
REVOKE ALL ON FUNCTION registry_private.field_value_columns(text,text,jsonb) FROM PUBLIC,anon,authenticated;

-- Do a stored row and value columns hold the same value? (multi-choice: same set of codes)
CREATE OR REPLACE FUNCTION registry_private.field_value_equals(r public.patient_field_values,cols jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN cols ? 'value_codes' THEN r.value_codes IS NOT NULL
      AND (SELECT array_agg(x ORDER BY x) FROM unnest(r.value_codes) x)
        = (SELECT array_agg(DISTINCT x ORDER BY x) FROM jsonb_array_elements_text(cols->'value_codes') x)
    WHEN cols ? 'value_num' THEN r.value_num = (cols->>'value_num')::numeric
    WHEN cols ? 'value_date' THEN r.value_date = (cols->>'value_date')::date
    ELSE r.value_text IS NOT DISTINCT FROM cols->>'value_text' END
$$;
REVOKE ALL ON FUNCTION registry_private.field_value_equals(public.patient_field_values,jsonb) FROM PUBLIC,anon,authenticated;

-- One project's current values of one patient: {key: value} (multi-choice as an array of codes).
CREATE OR REPLACE FUNCTION registry_private.patient_field_values_json(p_project_id uuid,p_patient_code text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_object_agg(v.field_key,
    CASE WHEN v.value_codes IS NOT NULL THEN to_jsonb(v.value_codes)
         WHEN v.value_num IS NOT NULL THEN to_jsonb(v.value_num)
         WHEN v.value_date IS NOT NULL THEN to_jsonb(v.value_date::text)
         ELSE to_jsonb(v.value_text) END ORDER BY v.field_key),'{}'::jsonb)
  FROM public.patient_field_values v WHERE v.project_id=p_project_id AND v.patient_code=p_patient_code
$$;
REVOKE ALL ON FUNCTION registry_private.patient_field_values_json(uuid,text) FROM PUBLIC,anon,authenticated;

-- ---- Field definitions: owner only ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_project_field(p_project_id uuid,p_field jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; old public.project_fields%ROWTYPE; is_new boolean; saved public.project_fields%ROWTYPE;
  v_key text; v_type text; v_label text; v_help text; v_choices jsonb; v_unit text; v_min numeric; v_max numeric;
  v_sort int; v_active boolean; v_source text; missing_codes text; bad text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'manage');
  IF jsonb_typeof(p_field) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'field_definition_must_be_object'; END IF;
  SELECT string_agg(key,'、') INTO bad FROM jsonb_object_keys(p_field) AS key
    WHERE key NOT IN ('field_key','label_cn','help_cn','value_type','choices','unit','min_value','max_value','sort_order','active','source');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unsupported_field_property: %',bad; END IF;
  v_key := p_field->>'field_key';
  IF jsonb_typeof(p_field->'field_key') IS DISTINCT FROM 'string' OR v_key !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'invalid_field_key'
      USING HINT='字段代码以小写英文字母开头，只含小写字母、数字和下划线，2–40 个字符，例如 ethnicity。';
  END IF;
  -- Import rows and exports put the patient and project identity in these columns.
  IF v_key IN ('id','project_id','center_code','module','patient_code') THEN
    RAISE EXCEPTION 'reserved_field_key: %',v_key
      USING HINT='id、project_id、center_code、module、patient_code 是系统列名，不能用作字段代码。';
  END IF;
  -- One definition change at a time per project.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  SELECT * INTO old FROM public.project_fields WHERE project_id=p_project_id AND field_key=v_key FOR UPDATE;
  is_new := NOT FOUND;
  IF is_new THEN
    v_type := p_field->>'value_type';
    IF v_type IS NULL OR v_type NOT IN ('choice','multi_choice','yes_no','number','date','text') THEN
      RAISE EXCEPTION 'invalid_field_type' USING HINT='字段类型为单选、多选、是/否、数值、日期或文本。';
    END IF;
    IF (SELECT count(*) FROM public.project_fields WHERE project_id=p_project_id) >= 100 THEN
      RAISE EXCEPTION 'too_many_fields' USING HINT='每个项目最多 100 个自定义字段；不再使用的字段请停用。';
    END IF;
  ELSE
    v_type := old.value_type;
    IF p_field ? 'value_type' AND p_field->>'value_type' IS DISTINCT FROM old.value_type THEN
      RAISE EXCEPTION 'field_type_is_fixed' USING HINT='字段类型创建后不能更改；需要不同类型时请新建字段并停用旧字段。';
    END IF;
  END IF;
  v_label := CASE WHEN p_field ? 'label_cn' THEN btrim(p_field->>'label_cn') ELSE old.label_cn END;
  IF v_label IS NULL OR char_length(v_label) NOT BETWEEN 1 AND 60 OR v_label ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_field_label' USING HINT='显示名称 1–60 字，不能含换行等控制字符。';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_fields WHERE project_id=p_project_id AND label_cn=v_label AND field_key<>v_key) THEN
    RAISE EXCEPTION 'duplicate_field_label' USING HINT='本项目已有同名字段；显示名称须唯一（导入时可用显示名称作列名）。';
  END IF;
  v_help := CASE WHEN p_field ? 'help_cn' THEN nullif(btrim(p_field->>'help_cn'),'') ELSE old.help_cn END;
  IF v_help IS NOT NULL AND (char_length(v_help) > 300 OR v_help ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_field_help' USING HINT='填写说明最多 300 字，不能含换行等控制字符。';
  END IF;
  IF v_type IN ('choice','multi_choice') THEN
    v_choices := CASE WHEN p_field ? 'choices' THEN p_field->'choices' ELSE old.choices END;
    IF jsonb_typeof(v_choices) = 'array' THEN
      -- Labels are compared and stored trimmed.
      v_choices := (SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'label') = 'string'
          THEN e || jsonb_build_object('label',btrim(e->>'label')) ELSE e END ORDER BY n)
        FROM jsonb_array_elements(v_choices) WITH ORDINALITY AS t(e,n));
    END IF;
    IF v_choices IS NULL OR NOT registry_private.valid_field_choices(v_choices) THEN
      RAISE EXCEPTION 'invalid_field_choices'
        USING HINT='选项 2–60 个；选项代码用小写字母、数字和下划线，显示名称 1–60 字，代码和名称都不能重复。';
    END IF;
    IF NOT is_new THEN
      SELECT string_agg(c->>'code','、') INTO missing_codes FROM jsonb_array_elements(old.choices) c
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_choices) n WHERE n->>'code' = c->>'code');
      IF missing_codes IS NOT NULL THEN
        RAISE EXCEPTION 'field_choice_removed: %',missing_codes
          USING HINT='已有选项不能删除（可以修改显示名称）；不再使用的选项可在名称中注明“停用”。';
      END IF;
    END IF;
  ELSIF p_field ? 'choices' AND jsonb_typeof(p_field->'choices') <> 'null' THEN
    RAISE EXCEPTION 'choices_not_allowed' USING HINT='只有单选和多选字段有选项。';
  END IF;
  IF v_type = 'number' THEN
    v_unit := CASE WHEN p_field ? 'unit' THEN nullif(btrim(p_field->>'unit'),'') ELSE old.unit END;
    IF v_unit IS NOT NULL AND (char_length(v_unit) > 20 OR v_unit ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'invalid_field_unit' USING HINT='单位最多 20 个字符。';
    END IF;
    BEGIN
      v_min := CASE WHEN p_field ? 'min_value' THEN nullif(btrim(p_field->>'min_value'),'')::numeric ELSE old.min_value END;
      v_max := CASE WHEN p_field ? 'max_value' THEN nullif(btrim(p_field->>'max_value'),'')::numeric ELSE old.max_value END;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_field_range' USING HINT='最小值和最大值须为数字。';
    END;
    IF v_min IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR v_max IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) THEN
      RAISE EXCEPTION 'invalid_field_range' USING HINT='最小值和最大值须为有限的数字。';
    END IF;
    IF v_min > v_max THEN RAISE EXCEPTION 'invalid_field_range' USING HINT='最小值不能大于最大值。'; END IF;
    IF NOT is_new AND EXISTS (SELECT 1 FROM public.patient_field_values WHERE project_id=p_project_id AND field_key=v_key
        AND (value_num < v_min OR value_num > v_max)) THEN
      RAISE EXCEPTION 'field_range_excludes_values' USING HINT='已录入的数值有超出新范围的，请先核对这些取值。';
    END IF;
  ELSIF (p_field ? 'unit' AND jsonb_typeof(p_field->'unit') <> 'null') OR (p_field ? 'min_value' AND jsonb_typeof(p_field->'min_value') <> 'null')
    OR (p_field ? 'max_value' AND jsonb_typeof(p_field->'max_value') <> 'null') THEN
    RAISE EXCEPTION 'number_properties_not_allowed' USING HINT='只有数值字段有单位和范围。';
  END IF;
  IF p_field ? 'sort_order' THEN
    IF jsonb_typeof(p_field->'sort_order') <> 'number' OR (p_field->>'sort_order')::numeric NOT BETWEEN 0 AND 99999
      OR (p_field->>'sort_order')::numeric <> trunc((p_field->>'sort_order')::numeric) THEN
      RAISE EXCEPTION 'invalid_field_sort_order';
    END IF;
    v_sort := (p_field->>'sort_order')::int;
  ELSE
    v_sort := CASE WHEN is_new THEN coalesce((SELECT max(sort_order) FROM public.project_fields WHERE project_id=p_project_id),0) + 10
      ELSE old.sort_order END;
  END IF;
  IF p_field ? 'active' THEN
    IF jsonb_typeof(p_field->'active') <> 'boolean' THEN RAISE EXCEPTION 'invalid_field_active'; END IF;
    v_active := (p_field->>'active')::boolean;
  ELSE v_active := CASE WHEN is_new THEN true ELSE old.active END;
  END IF;
  v_source := CASE WHEN p_field ? 'source' THEN nullif(btrim(p_field->>'source'),'') ELSE old.source END;
  IF v_source IS NOT NULL AND (char_length(v_source) > 60 OR v_source ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_field_source';
  END IF;
  IF is_new THEN
    INSERT INTO public.project_fields(project_id,field_key,label_cn,help_cn,value_type,choices,unit,min_value,max_value,
        sort_order,active,source,created_by,updated_by)
      VALUES(p_project_id,v_key,v_label,v_help,v_type,v_choices,v_unit,v_min,v_max,v_sort,v_active,v_source,auth.uid(),auth.uid())
      RETURNING * INTO saved;
  ELSE
    UPDATE public.project_fields SET label_cn=v_label,help_cn=v_help,choices=v_choices,unit=v_unit,min_value=v_min,max_value=v_max,
        sort_order=v_sort,active=v_active,source=v_source,updated_by=auth.uid(),updated_at=now()
      WHERE id=old.id RETURNING * INTO saved;
  END IF;
  IF is_new OR to_jsonb(old) - 'updated_at' - 'updated_by' IS DISTINCT FROM to_jsonb(saved) - 'updated_at' - 'updated_by' THEN
    INSERT INTO public.audit_log(project_id,actor_uid,action,details)
      VALUES(p_project_id,auth.uid(),CASE WHEN is_new THEN 'project_field_created' ELSE 'project_field_updated' END,
        jsonb_build_object('field_key',v_key,'before',CASE WHEN is_new THEN NULL ELSE to_jsonb(old) - 'created_by' - 'updated_by' END,
          'after',to_jsonb(saved) - 'created_by' - 'updated_by'));
  END IF;
  RETURN to_jsonb(saved) - 'created_by' - 'updated_by';
END $$;
REVOKE ALL ON FUNCTION public.save_project_field(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_project_field(uuid,jsonb) TO authenticated;

-- ---- Field values: several fields of one patient in one call ---------------------------------------
CREATE OR REPLACE FUNCTION public.set_patient_field_values(p_project_id uuid,p_patient_code text,p_values jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb; f public.project_fields%ROWTYPE; cols jsonb; cur public.patient_field_values%ROWTYPE;
  changed int := 0; has_row boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required'; END IF;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR p_values = '{}'::jsonb THEN RAISE EXCEPTION 'field_values_required'; END IF;
  -- The patient's baseline row serializes concurrent saves of the same patient.
  PERFORM 1 FROM public.patients_baseline WHERE project_id=p_project_id AND patient_code=p_patient_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each(p_values) ORDER BY key LOOP
    SELECT * INTO f FROM public.project_fields WHERE project_id=p_project_id AND field_key=k;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown_field: %',k USING HINT=format('本项目没有代码为 %s 的自定义入组字段，请刷新页面后重试。',k);
    END IF;
    cols := registry_private.field_value_columns(f.value_type,k,v);
    SELECT * INTO cur FROM public.patient_field_values
      WHERE project_id=p_project_id AND patient_code=p_patient_code AND field_key=k FOR UPDATE;
    has_row := FOUND;
    IF cols IS NULL THEN
      IF has_row THEN
        DELETE FROM public.patient_field_values WHERE id=cur.id;
        changed := changed+1;
      END IF;
    ELSIF NOT has_row THEN
      INSERT INTO public.patient_field_values(project_id,patient_code,field_key,value_text,value_codes,value_num,value_date)
        VALUES(p_project_id,p_patient_code,k,cols->>'value_text',
          CASE WHEN cols ? 'value_codes' THEN ARRAY(SELECT jsonb_array_elements_text(cols->'value_codes')) END,
          (cols->>'value_num')::numeric,(cols->>'value_date')::date);
      changed := changed+1;
    ELSIF NOT registry_private.field_value_equals(cur,cols) THEN
      UPDATE public.patient_field_values SET value_text=cols->>'value_text',
          value_codes=CASE WHEN cols ? 'value_codes' THEN ARRAY(SELECT jsonb_array_elements_text(cols->'value_codes')) END,
          value_num=(cols->>'value_num')::numeric,value_date=(cols->>'value_date')::date
        WHERE id=cur.id;
      changed := changed+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('values',registry_private.patient_field_values_json(p_project_id,p_patient_code),'changed',changed);
END $$;
REVOKE ALL ON FUNCTION public.set_patient_field_values(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_patient_field_values(uuid,text,jsonb) TO authenticated;

-- ---- Batch import kind 'fields' ---------------------------------------------------------------
-- One row per patient: patient_code and a column per field key. Blank cells are ignored; an equal
-- stored value is linked as matched; a different stored value refuses the batch with the row
-- number. Returns 'inserted' when the row wrote a value, otherwise 'skipped'.
CREATE OR REPLACE FUNCTION registry_private.import_field_row(p_project_id uuid,p_row jsonb,p_row_no int,p_batch_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r jsonb := p_row; code text; k text; v jsonb; f public.project_fields%ROWTYPE; cols jsonb;
  cur public.patient_field_values%ROWTYPE; row_hash text; rec_id uuid; inserted int := 0; msg text; hint text;
BEGIN
  IF r ? 'project_id' AND r->>'project_id' IS DISTINCT FROM p_project_id::text THEN
    RAISE EXCEPTION 'row_%_project_mismatch',p_row_no;
  END IF;
  r := r - 'project_id';
  IF jsonb_typeof(r->'patient_code') IS DISTINCT FROM 'string' OR coalesce(r->>'patient_code','') = '' THEN
    RAISE EXCEPTION 'row_%_patient_code_required',p_row_no;
  END IF;
  code := r->>'patient_code';
  IF length(code) > 64 OR code <> btrim(code) OR code ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'row_%_invalid_patient_code',p_row_no; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients_baseline WHERE project_id=p_project_id AND patient_code=code) THEN
    RAISE EXCEPTION 'row_%_patient_not_registered',p_row_no
      USING HINT='该研究编号在本项目中没有患者基线记录，请先导入或建立患者；本批次未写入。';
  END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each(r) WHERE key <> 'patient_code' ORDER BY key LOOP
    BEGIN
      SELECT * INTO f FROM public.project_fields WHERE project_id=p_project_id AND field_key=k;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown_field: %',k
          USING HINT=format('列“%s”不是本项目的自定义入组字段，请按下载的模板填写列名；本批次未写入。',k);
      END IF;
      IF jsonb_typeof(v) NOT IN ('string','null') THEN RAISE EXCEPTION 'text_value_required: %',k; END IF;
      cols := registry_private.field_value_columns(f.value_type,k,v);
      IF cols IS NOT NULL THEN
        row_hash := encode(sha256(convert_to(jsonb_build_object('patient_code',code,'field_key',k,'value',cols)::text,'UTF8')),'hex');
        SELECT * INTO cur FROM public.patient_field_values WHERE project_id=p_project_id AND patient_code=code AND field_key=k FOR UPDATE;
        IF FOUND THEN
          IF NOT registry_private.field_value_equals(cur,cols) THEN
            RAISE EXCEPTION 'field_value_conflict: %',k
              USING HINT=format('该患者的“%s”已有不同的值，导入不会覆盖；请先在看板中打开该患者的“入组字段”核对；本批次未写入。',f.label_cn);
          END IF;
          INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
            VALUES(p_project_id,'fields',row_hash,cur.id,p_batch_id,'matched') ON CONFLICT DO NOTHING;
        ELSE
          IF NOT f.active THEN
            RAISE EXCEPTION 'field_inactive: %',k
              USING HINT=format('“%s”已停用，不能再导入；本批次未写入。',f.label_cn);
          END IF;
          INSERT INTO public.patient_field_values(project_id,patient_code,field_key,value_text,value_codes,value_num,value_date,created_by)
            VALUES(p_project_id,code,k,cols->>'value_text',
              CASE WHEN cols ? 'value_codes' THEN ARRAY(SELECT jsonb_array_elements_text(cols->'value_codes')) END,
              (cols->>'value_num')::numeric,(cols->>'value_date')::date,auth.uid())
            RETURNING id INTO rec_id;
          INSERT INTO public.registry_import_records(project_id,kind,content_sha256,record_id,batch_id,action)
            VALUES(p_project_id,'fields',row_hash,rec_id,p_batch_id,'inserted');
          inserted := inserted+1;
        END IF;
      END IF;
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, hint = PG_EXCEPTION_HINT;
      RAISE EXCEPTION 'row_%_%',p_row_no,msg USING HINT=coalesce(nullif(hint,''),'请按模板说明更正该行；本批次未写入。');
    END;
  END LOOP;
  RETURN CASE WHEN inserted > 0 THEN 'inserted' ELSE 'skipped' END;
END $$;
REVOKE ALL ON FUNCTION registry_private.import_field_row(uuid,jsonb,int,uuid) FROM PUBLIC,anon,authenticated;

ALTER TABLE public.registry_import_batches DROP CONSTRAINT IF EXISTS registry_import_batches_kind_check,
  ADD CONSTRAINT registry_import_batches_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events','biopsies','fields'));
ALTER TABLE public.registry_import_records DROP CONSTRAINT IF EXISTS registry_import_records_kind_check,
  ADD CONSTRAINT registry_import_records_kind_check CHECK (kind IN ('baseline','visits','labs','meds','events','biopsies','fields'));

-- ---- Import and export (0043's functions, extended) -------------------------------------
CREATE OR REPLACE FUNCTION registry_private.import_record_digest(p_table text,p_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp SET timezone = 'UTC' AS $$
DECLARE r jsonb;
BEGIN
  IF p_table IS NULL OR p_table NOT IN ('visits_long','labs_long','meds_long','events_long','biopsies_long',
    'patient_field_values') THEN
    RAISE EXCEPTION 'unsupported_record_type';
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id=$1',p_table) INTO r USING p_id;
  RETURN encode(sha256(convert_to(r::text,'UTF8')),'hex');
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
  IF p_kind IS NULL OR p_kind NOT IN ('baseline','visits','labs','meds','events','biopsies','fields') OR p_batch_id IS NULL THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
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
    IF p_kind IN ('labs','meds','events','biopsies') THEN
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
      ELSE 'events_long' END;
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
  IF b.kind NOT IN ('visits','labs','meds','events','biopsies','fields') THEN
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
    ELSE 'events_long' END;
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
    bounds AS MATERIALIZED (SELECT ((SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_0 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_1 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_2 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_3 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_4 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_5 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_6 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_7 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_8 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_9 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_10 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_11 t)) AS row_bytes, ((SELECT count(*) FROM rows_0)>10000 OR (SELECT count(*) FROM rows_1)>10000 OR (SELECT count(*) FROM rows_2)>10000 OR (SELECT count(*) FROM rows_3)>10000 OR (SELECT count(*) FROM rows_4)>10000 OR (SELECT count(*) FROM rows_5)>10000 OR (SELECT count(*) FROM rows_6)>10000 OR (SELECT count(*) FROM rows_7)>10000 OR (SELECT count(*) FROM rows_8)>10000 OR (SELECT count(*) FROM rows_9)>10000 OR (SELECT count(*) FROM rows_10)>10000 OR (SELECT count(*) FROM rows_11)>10000) AS over_rows)
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
        'value_codes','自定义入组字段的取值：单选与“是/否”（yes/no）及文本存在 value_text，多选存选项代码数组 value_codes（按定义中的选项顺序），数值存 value_num，日期存 value_date；选项代码的含义见 project_fields.choices。'),
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
      'patient_field_values',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM rows_11 t)
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

REVOKE ALL ON FUNCTION registry_private.import_record_digest(text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_registry_export(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_registry_export(uuid,uuid) TO authenticated;

INSERT INTO public.registry_schema_versions(version) VALUES('0044_project_fields') ON CONFLICT(version) DO NOTHING;
COMMIT;
