-- 0046: autosomal dominant polycystic kidney disease (ADPKD) module and the vasopressin V2
-- receptor antagonist medication class. Additive, transactional and safe to re-run; no stored
-- value is changed and no project, field or record is created.
--  * projects.module may be 'ADPKD' (0042's creation guard; whitelist extended by one value).
--  * drug_class gains 血管加压素V2受体拮抗剂 (tolvaptan's class) for batch import (0043's
--    validate_clinical_input; list extended by one value) and the meds_long column note.
--  * abbreviation_dictionary: ADPKD.
--  * The ADPKD enrollment-field draft lives in the workbench (site/lib/project-fields.js); a
--    project owner loads it through save_project_field (0044). This migration defines no field.
--  * The two functions are re-created from their reviewed text with only these additions
--    (generated, see commit message).
BEGIN;

-- Preconditions. Nothing below runs unless 0045 is in place and the objects this migration
-- re-creates or extends exist.
DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0045_cystatin_urine_rbc') THEN
    RAISE EXCEPTION '迁移 0046 已中止：尚未执行迁移 0045。请先按顺序执行 0032–0045，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.projects','public.meds_long','public.abbreviation_dictionary']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL THEN
    SELECT string_agg(t,'、' ORDER BY t) INTO missing
      FROM unnest(ARRAY['public._create_project_account_guard()','registry_private.validate_clinical_input(text,jsonb)',
        'public._account_access(uuid)','registry_private.local_today()','public._contains_pii(text)']) AS t
      WHERE to_regprocedure(t) IS NULL;
  END IF;
  IF missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.projects'::regclass
      AND tgname='tr_account_project_guard' AND NOT tgisinternal) THEN
    missing := 'trigger tr_account_project_guard';
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0046 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0045 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

-- ---- Project module ADPKD (0042's guard, unchanged except for the whitelist) -----------------
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
 if new.module not in ('IGAN','LN','MN','DKD','CKD','KTX','GENERAL','C3G','ADPKD') then raise exception 'invalid_module'; end if;
 new.created_by:=v_uid; new.subscription_plan:=v->>'plan'; new.subscription_active_until:=(v->>'ends_at')::timestamptz;
 select account_trial_started_at into v_started from user_profiles where user_id=v_uid;
 new.trial_enabled:=true;new.trial_started_at:=v_started;new.trial_expires_at:=(v->>'trial_expires_at')::timestamptz;new.trial_grace_until:=new.trial_expires_at+interval '7 days';
 return new;
end $$;
revoke all on function public._create_project_account_guard() from public,anon,authenticated;

-- ---- Medication class 血管加压素V2受体拮抗剂 (0043's validation, unchanged except for the list) ----
CREATE OR REPLACE FUNCTION registry_private.validate_clinical_input(p_kind text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v text; n numeric; d date; ts timestamptz; today date := registry_private.local_today();
  max_len jsonb := '{"result_text":50,"ref_range":50,"notes":500,"drug_name":200,"dose_unit":20,
    "frequency":20,"indication":100,"event_detail":500}';
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'row_must_be_object'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('labs','meds','events','biopsies') THEN RAISE EXCEPTION 'invalid_import_request'; END IF;
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
    IF k IN ('value_raw','dose_value','crescent_pct') THEN
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
    IF k IN ('lab_date','start_date','end_date','event_date','biopsy_date') THEN
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
REVOKE ALL ON FUNCTION registry_private.validate_clinical_input(text,jsonb) FROM PUBLIC,anon,authenticated;
COMMENT ON COLUMN public.meds_long.drug_class IS
  '药物类别（可空）：RAS阻断剂、SGLT2抑制剂、糖皮质激素、免疫抑制剂、利尿剂、降压药（其他）、降糖药（其他）、降脂药、抗凝/抗血小板、内皮素受体拮抗剂、补体抑制剂、盐皮质激素受体拮抗剂、预防性抗生素、试验药物、疫苗、血管加压素V2受体拮抗剂、其他。疫苗接种在此登记：药品名称写疫苗名称，开始日期为接种日期。托伐普坦归入“血管加压素V2受体拮抗剂”。';

-- ---- Chinese display dictionary ------------------------------------------------------------
INSERT INTO public.abbreviation_dictionary(abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('ADPKD', '常染色体显性多囊肾病', '病种相关', '首次显示建议：常染色体显性多囊肾病（ADPKD）')
ON CONFLICT (abbr) DO NOTHING;

INSERT INTO public.registry_schema_versions(version) VALUES('0046_adpkd_module') ON CONFLICT(version) DO NOTHING;
COMMIT;
