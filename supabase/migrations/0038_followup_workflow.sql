-- 0038: follow-up workflow for the workbench and the patient follow-up page.
-- Additive, transactional and safe to re-run on existing production data.
--  * Research consent becomes an explicit five-state field. The legacy boolean
--    consent_research only ever held its schema default (true): no screen let anyone
--    fill it in. It is cleared to NULL (= unconfirmed, field-audited with a reason) and
--    from now on derived from consent_status; conflicting direct writes are refused.
--  * Follow-up status per patient. Declined/withdrawn consent or a withdrawn/deceased
--    follow-up status revokes that patient's usable links on every write path.
--  * Per-project follow-up interval and the study details shown to patients
--    (title, institution, ethics approval number, research team contact).
--  * Caller-privilege (security_invoker) views for "who is due / who has not
--    submitted", relying on the base tables' RLS. No clinical threshold is defined
--    here: the interval is a project setting the study team confirms.
BEGIN;

ALTER TABLE public.patients_baseline
  ADD COLUMN IF NOT EXISTS consent_status text NOT NULL DEFAULT 'unconfirmed'
    CONSTRAINT patients_baseline_consent_status_check
    CHECK (consent_status IN ('unconfirmed','consented','waiver','declined','withdrawn')),
  ADD COLUMN IF NOT EXISTS consent_date date,
  ADD COLUMN IF NOT EXISTS consent_version text
    CONSTRAINT patients_baseline_consent_version_length
    CHECK (char_length(consent_version) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS followup_status text NOT NULL DEFAULT 'active'
    CONSTRAINT patients_baseline_followup_status_check
    CHECK (followup_status IN ('active','lost','withdrawn','deceased','kidney_failure','transferred')),
  ADD COLUMN IF NOT EXISTS followup_status_date date;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS followup_interval_days int NOT NULL DEFAULT 90
    CONSTRAINT projects_followup_interval_days_range CHECK (followup_interval_days BETWEEN 7 AND 730),
  ADD COLUMN IF NOT EXISTS public_title text
    CONSTRAINT projects_public_title_length CHECK (char_length(public_title) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS institution_name text
    CONSTRAINT projects_institution_name_length CHECK (char_length(institution_name) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS ethics_approval_no text
    CONSTRAINT projects_ethics_approval_no_length CHECK (char_length(ethics_approval_no) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS contact_display text
    CONSTRAINT projects_contact_display_length CHECK (char_length(contact_display) BETWEEN 1 AND 120);

-- The legacy default must never again stand in for a research consent decision.
ALTER TABLE public.patients_baseline ALTER COLUMN consent_research DROP DEFAULT;
ALTER TABLE public.patients_baseline ALTER COLUMN consent_research DROP NOT NULL;
-- Clear the never-entered default exactly once (a re-run must not erase derived values).
-- The account write guard and metadata trigger are bypassed only for this statement:
-- expired trials must not block the migration, and updated_at/updated_by stay the
-- record's real last edit. The field audit trigger stays enabled and records each row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0038_followup_workflow') THEN
    PERFORM set_config('app.registry_change_reason',
      '系统升级（0038）：原“研究同意”只是系统默认值，从未由人工填写，现统一改为“未确认”；请按知情同意记录核实后更新。',true);
    ALTER TABLE public.patients_baseline DISABLE TRIGGER tr_patients_trial_lock;
    ALTER TABLE public.patients_baseline DISABLE TRIGGER tr_patients_updated_meta;
    UPDATE public.patients_baseline SET consent_research=NULL WHERE consent_research IS NOT NULL;
    ALTER TABLE public.patients_baseline ENABLE TRIGGER tr_patients_updated_meta;
    ALTER TABLE public.patients_baseline ENABLE TRIGGER tr_patients_trial_lock;
    PERFORM set_config('app.registry_change_reason','',true);
  END IF;
END $$;

-- consented/waiver -> true, declined/withdrawn -> false, unconfirmed -> NULL.
-- A conflicting explicit value is refused rather than silently replaced.
CREATE OR REPLACE FUNCTION registry_private.derive_consent_research()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE derived boolean := CASE NEW.consent_status
  WHEN 'consented' THEN true WHEN 'waiver' THEN true
  WHEN 'declined' THEN false WHEN 'withdrawn' THEN false ELSE NULL END;
BEGIN
  IF NEW.consent_research IS DISTINCT FROM derived AND (CASE WHEN TG_OP='INSERT'
      THEN NEW.consent_research IS NOT NULL
      ELSE NEW.consent_research IS DISTINCT FROM OLD.consent_research END) THEN
    RAISE EXCEPTION 'consent_research_is_derived'
      USING HINT='研究同意请按“同意状态”记录（未确认、已同意、豁免知情同意、拒绝、撤回），原是/否字段由系统自动生成。';
  END IF;
  NEW.consent_research := derived;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION registry_private.derive_consent_research() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_consent_research_derived ON public.patients_baseline;
CREATE TRIGGER registry_consent_research_derived
  BEFORE INSERT OR UPDATE OF consent_status,consent_research ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.derive_consent_research();

-- Leaving the study stops link-based data collection on every write path: consent
-- declined/withdrawn or follow-up withdrawn/deceased revokes the patient's usable links.
-- Lost to follow-up, transfer and kidney failure keep links (the protocol may continue).
CREATE OR REPLACE FUNCTION registry_private.revoke_links_on_study_exit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE why text; n int;
BEGIN
  IF NEW.consent_status IS DISTINCT FROM OLD.consent_status AND NEW.consent_status IN ('declined','withdrawn') THEN
    why := 'consent_' || NEW.consent_status;
  ELSIF NEW.followup_status IS DISTINCT FROM OLD.followup_status AND NEW.followup_status IN ('withdrawn','deceased') THEN
    why := 'followup_' || NEW.followup_status;
  ELSE RETURN NULL; END IF;
  UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason=why
    WHERE project_id=NEW.project_id AND patient_code=NEW.patient_code AND active AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO public.security_audit_logs(project_id,patient_code,actor_uid,event_type,severity,details)
      VALUES(NEW.project_id,NEW.patient_code,auth.uid(),'study_exit_tokens_revoked','INFO',
        jsonb_build_object('reason',why,'revoked_token_count',n));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION registry_private.revoke_links_on_study_exit() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS registry_study_exit_links ON public.patients_baseline;
CREATE TRIGGER registry_study_exit_links
  AFTER UPDATE OF consent_status,followup_status ON public.patients_baseline
  FOR EACH ROW EXECUTE FUNCTION registry_private.revoke_links_on_study_exit();

COMMENT ON COLUMN public.patients_baseline.consent_status IS
  '研究同意状态：unconfirmed 未确认；consented 已签署知情同意；waiver 伦理委员会批准免除知情同意；declined 拒绝；withdrawn 撤回同意。';
COMMENT ON COLUMN public.patients_baseline.consent_research IS
  '由 consent_status 自动生成，不可单独填写：consented/waiver 为 true，declined/withdrawn 为 false，unconfirmed 为空值（空值表示未确认，不表示否）。';
COMMENT ON COLUMN public.patients_baseline.followup_status IS
  '随访状态：active 随访中；lost 失访；withdrawn 退出研究；deceased 死亡；kidney_failure 进入肾衰竭（判定标准以研究方案为准）；transferred 转至其他机构。';
COMMENT ON COLUMN public.projects.followup_interval_days IS
  '计划随访间隔（天，7–730）。默认 90 天仅用于提醒排程，应由研究负责人按研究方案确认。';
COMMENT ON COLUMN public.projects.contact_display IS
  '随访页向患者显示的研究团队联系方式，例如“研究护士 王老师”。';

-- CSV import and audited corrections may carry the explicit study status fields.
-- The derived legacy boolean is no longer an accepted input column.
CREATE OR REPLACE FUNCTION public._registry_input_columns(p_kind text)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
SELECT CASE p_kind
  WHEN 'baseline' THEN ARRAY['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr',
    'baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit',
    'consent_status','consent_date','consent_version','followup_status','followup_status_date',
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
    IF k IN ('baseline_date','biopsy_date','ln_biopsy_date','randomization_date','visit_date','lab_date','consent_date','followup_status_date') THEN
      IF v !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END IF;
      -- An impossible calendar date (e.g. 2025-02-30) is an input error, not a server error.
      BEGIN d := v::date;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_iso_date: %',k; END;
      IF d::text <> v OR d > current_date THEN RAISE EXCEPTION 'invalid_or_future_date: %',k; END IF;
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
REVOKE ALL ON FUNCTION public._registry_input_columns(text),public._registry_validate_input(text,jsonb)
  FROM PUBLIC,anon,authenticated;

-- Consent and follow-up status changes for one patient, with an optional reason.
-- Every changed field is written to field_audit_log by _registry_audit_changes.
CREATE OR REPLACE FUNCTION public.set_patient_study_status(
  p_project_id uuid,p_patient_code text,p_changes jsonb,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; changes jsonb := p_changes; clean jsonb; before_row jsonb; rec_id uuid; assignments text;
  reason text := nullif(btrim(p_reason),''); old_reason text; changed boolean := false;
  after_row public.patients_baseline%ROWTYPE;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'write');
  -- SHARE conflicts with membership changes (NO KEY UPDATE); recheck after waiting.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'write');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF jsonb_typeof(changes) IS DISTINCT FROM 'object' OR changes='{}'::jsonb THEN
    RAISE EXCEPTION 'study_status_changes_required';
  END IF;
  FOR k IN SELECT jsonb_object_keys(changes) LOOP
    IF NOT k = ANY(ARRAY['consent_status','consent_date','consent_version','followup_status','followup_status_date']) THEN
      RAISE EXCEPTION 'unsupported_column: %',k;
    END IF;
  END LOOP;
  IF changes ? 'consent_status' AND jsonb_typeof(changes->'consent_status') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_consent_status';
  END IF;
  IF changes ? 'followup_status' AND jsonb_typeof(changes->'followup_status') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_followup_status';
  END IF;
  -- An empty form field clears an optional value; it is never stored as blank text.
  FOR k IN SELECT unnest(ARRAY['consent_date','consent_version','followup_status_date']) LOOP
    IF jsonb_typeof(changes->k) = 'string' THEN
      changes := jsonb_set(changes,ARRAY[k],coalesce(to_jsonb(nullif(btrim(changes->>k),'')),'null'::jsonb));
    END IF;
  END LOOP;
  PERFORM public._registry_validate_input('baseline',changes);
  IF length(reason) > 500 THEN RAISE EXCEPTION 'reason_too_long'; END IF;
  IF public._contains_pii(coalesce(reason,'')) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  -- Leaving the study revokes this patient's links in the same transaction: take the
  -- link rows before the baseline row, the same order a patient submission uses.
  IF changes->>'consent_status' IN ('declined','withdrawn') OR changes->>'followup_status' IN ('withdrawn','deceased') THEN
    PERFORM 1 FROM public.patient_tokens WHERE project_id=p_project_id AND patient_code=p_patient_code FOR UPDATE;
  END IF;
  SELECT b.id,to_jsonb(b) INTO rec_id,before_row FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code FOR UPDATE;
  IF rec_id IS NULL THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  clean := (SELECT jsonb_object_agg(key,(to_jsonb(jsonb_populate_record(NULL::public.patients_baseline,changes)))->key)
            FROM jsonb_object_keys(changes) AS keys(key));
  IF NOT (before_row @> clean) THEN
    SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.patients_baseline,$1)).%I',key,key),',' ORDER BY key)
      INTO assignments FROM jsonb_object_keys(clean) AS keys(key);
    old_reason := current_setting('app.registry_change_reason',true);
    PERFORM set_config('app.registry_change_reason',coalesce(reason,'研究同意或随访状态更新（未填写原因）'),true);
    EXECUTE format('UPDATE public.patients_baseline SET %s WHERE id=$2 AND project_id=$3',assignments)
      USING clean,rec_id,p_project_id;
    PERFORM set_config('app.registry_change_reason',coalesce(old_reason,''),true);
    changed := true;
  END IF;
  SELECT * INTO after_row FROM public.patients_baseline WHERE id=rec_id;
  RETURN jsonb_build_object('patient_code',after_row.patient_code,
    'consent_status',after_row.consent_status,'consent_date',after_row.consent_date,
    'consent_version',after_row.consent_version,'followup_status',after_row.followup_status,
    'followup_status_date',after_row.followup_status_date,'changed',changed);
END $$;

-- Project follow-up settings and patient-facing study details: owner only.
CREATE OR REPLACE FUNCTION public.set_project_settings(p_project_id uuid,p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE k text; v jsonb; t text; n numeric; clean jsonb := '{}'::jsonb;
  before_row jsonb; after_row jsonb; changed boolean := false;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'manage');
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'settings_must_be_object'; END IF;
  FOR k, v IN SELECT key,value FROM jsonb_each(p_settings) LOOP
    IF k = 'followup_interval_days' THEN
      IF jsonb_typeof(v) = 'number' THEN n := (v #>> '{}')::numeric;
      ELSIF jsonb_typeof(v) = 'string' AND btrim(v #>> '{}') ~ '^[0-9]{1,4}$' THEN n := btrim(v #>> '{}')::numeric;
      ELSE RAISE EXCEPTION 'invalid_followup_interval'; END IF;
      IF n <> trunc(n) OR n NOT BETWEEN 7 AND 730 THEN RAISE EXCEPTION 'invalid_followup_interval'; END IF;
      clean := clean || jsonb_build_object(k,n::int);
    ELSIF k IN ('public_title','institution_name','ethics_approval_no','contact_display') THEN
      IF jsonb_typeof(v) = 'null' THEN t := NULL;
      ELSIF jsonb_typeof(v) = 'string' THEN t := nullif(btrim(v #>> '{}'),'');
      ELSE RAISE EXCEPTION 'setting_text_required: %',k; END IF;
      IF t ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_setting_text: %',k; END IF;
      IF char_length(t) > (CASE k WHEN 'ethics_approval_no' THEN 80 ELSE 120 END) THEN
        RAISE EXCEPTION 'setting_too_long: %',k;
      END IF;
      clean := clean || jsonb_build_object(k,t);
    ELSE RAISE EXCEPTION 'unsupported_setting: %',k;
    END IF;
  END LOOP;
  SELECT jsonb_build_object('followup_interval_days',p.followup_interval_days,'public_title',p.public_title,
      'institution_name',p.institution_name,'ethics_approval_no',p.ethics_approval_no,'contact_display',p.contact_display)
    INTO before_row FROM public.projects p WHERE p.id=p_project_id FOR UPDATE;
  IF before_row IS NULL THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF NOT (before_row @> clean) THEN
    UPDATE public.projects p SET
      followup_interval_days=CASE WHEN clean ? 'followup_interval_days' THEN (clean->>'followup_interval_days')::int ELSE p.followup_interval_days END,
      public_title=CASE WHEN clean ? 'public_title' THEN clean->>'public_title' ELSE p.public_title END,
      institution_name=CASE WHEN clean ? 'institution_name' THEN clean->>'institution_name' ELSE p.institution_name END,
      ethics_approval_no=CASE WHEN clean ? 'ethics_approval_no' THEN clean->>'ethics_approval_no' ELSE p.ethics_approval_no END,
      contact_display=CASE WHEN clean ? 'contact_display' THEN clean->>'contact_display' ELSE p.contact_display END
    WHERE p.id=p_project_id;
    changed := true;
  END IF;
  SELECT jsonb_build_object('followup_interval_days',p.followup_interval_days,'public_title',p.public_title,
      'institution_name',p.institution_name,'ethics_approval_no',p.ethics_approval_no,'contact_display',p.contact_display)
    INTO after_row FROM public.projects p WHERE p.id=p_project_id;
  IF changed THEN
    INSERT INTO public.audit_log(project_id,actor_uid,action,details)
      VALUES(p_project_id,auth.uid(),'project_settings_updated',jsonb_build_object('before',before_row,'after',after_row));
  END IF;
  RETURN after_row || jsonb_build_object('changed',changed);
END $$;

REVOKE ALL ON FUNCTION public.set_patient_study_status(uuid,text,jsonb,text),
  public.set_project_settings(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_patient_study_status(uuid,text,jsonb,text),
  public.set_project_settings(uuid,jsonb) TO authenticated;

-- Workbench views. security_invoker: every base table is read with the caller's
-- privileges and RLS, so another project's rows never appear and link columns are
-- empty (0/NULL) for members without link-management permission.
CREATE OR REPLACE VIEW public.v_patient_followup_status WITH (security_invoker = true) AS
SELECT b.project_id,
  b.id AS patient_id,
  p.center_code,
  b.patient_code,
  b.baseline_date,
  b.consent_status,
  b.followup_status,
  coalesce(v.visit_count,0)::int AS visit_count,
  v.first_visit_date,
  v.last_visit_date,
  current_date - v.last_visit_date AS days_since_last_visit,
  d.next_due_date,
  CASE WHEN b.followup_status <> 'active' THEN 'inactive'
    WHEN coalesce(v.visit_count,0) = 0 THEN 'no_visit'
    WHEN current_date > d.next_due_date THEN 'overdue'
    WHEN d.next_due_date - current_date BETWEEN 0 AND 14 THEN 'due_soon'
    ELSE 'ok' END AS followup_state,
  coalesce(l.active_link_count,0)::int AS active_link_count,
  r.created_at AS last_link_created_at,
  r.expires_at AS last_link_expires_at,
  v.last_patient_submission_at
FROM public.patients_baseline b
JOIN public.projects p ON p.id = b.project_id
LEFT JOIN LATERAL (
  SELECT count(*) AS visit_count, min(x.visit_date) AS first_visit_date, max(x.visit_date) AS last_visit_date,
    max(x.created_at) FILTER (WHERE x.submitted_via_token_id IS NOT NULL) AS last_patient_submission_at
  FROM public.visits_long x WHERE x.project_id = b.project_id AND x.patient_code = b.patient_code
) v ON true
CROSS JOIN LATERAL (
  SELECT coalesce(v.last_visit_date,b.baseline_date) + p.followup_interval_days AS next_due_date
) d
LEFT JOIN LATERAL (
  SELECT count(*) AS active_link_count FROM public.patient_tokens t
  WHERE t.project_id = b.project_id AND t.patient_code = b.patient_code
    AND t.active AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
    AND NOT (t.single_use AND t.used_at IS NOT NULL)
) l ON true
LEFT JOIN LATERAL (
  SELECT t.created_at, t.expires_at FROM public.patient_tokens t
  WHERE t.project_id = b.project_id AND t.patient_code = b.patient_code
  ORDER BY t.created_at DESC, t.id DESC LIMIT 1
) r ON true;

CREATE OR REPLACE VIEW public.v_project_overview WITH (security_invoker = true) AS
SELECT p.id AS project_id,
  p.followup_interval_days,
  coalesce(f.n_patients,0)::int AS n_patients,
  coalesce(f.n_active,0)::int AS n_active,
  coalesce(v.n_visits,0)::int AS n_visits,
  coalesce(v.n_visits_30d,0)::int AS n_visits_30d,
  coalesce(v.n_core_complete_visits,0)::int AS n_core_complete_visits,
  CASE WHEN coalesce(v.n_visits,0) = 0 THEN NULL
    ELSE round(v.n_core_complete_visits::numeric / v.n_visits, 4) END AS core_completeness,
  coalesce(f.n_overdue,0)::int AS n_overdue,
  coalesce(f.n_due_soon,0)::int AS n_due_soon,
  coalesce(f.n_no_visit,0)::int AS n_no_visit,
  v.last_visit_date,
  coalesce(f.n_consent_confirmed,0)::int AS n_consent_confirmed,
  coalesce(f.n_consent_unconfirmed,0)::int AS n_consent_unconfirmed,
  coalesce(i.n_open_issues,0)::int AS n_open_issues
FROM public.projects p
LEFT JOIN LATERAL (
  SELECT count(*) AS n_patients,
    count(*) FILTER (WHERE s.followup_status = 'active') AS n_active,
    count(*) FILTER (WHERE s.followup_state = 'overdue') AS n_overdue,
    count(*) FILTER (WHERE s.followup_state = 'due_soon') AS n_due_soon,
    count(*) FILTER (WHERE s.followup_state = 'no_visit') AS n_no_visit,
    count(*) FILTER (WHERE s.consent_status IN ('consented','waiver')) AS n_consent_confirmed,
    count(*) FILTER (WHERE s.consent_status = 'unconfirmed') AS n_consent_unconfirmed
  FROM public.v_patient_followup_status s WHERE s.project_id = p.id
) f ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n_visits,
    count(*) FILTER (WHERE x.visit_date >= current_date - 30) AS n_visits_30d,
    count(*) FILTER (WHERE x.visit_date IS NOT NULL AND x.sbp IS NOT NULL AND x.dbp IS NOT NULL
      AND x.scr_umol_l IS NOT NULL AND x.upcr IS NOT NULL) AS n_core_complete_visits,
    max(x.visit_date) AS last_visit_date
  FROM public.visits_long x WHERE x.project_id = p.id
) v ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n_open_issues FROM public.data_issues di
  WHERE di.project_id = p.id AND di.status NOT IN ('RESOLVED','WONT_FIX')
) i ON true;

REVOKE ALL ON public.v_patient_followup_status,public.v_project_overview FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_patient_followup_status,public.v_project_overview TO authenticated;
COMMENT ON VIEW public.v_patient_followup_status IS
  '工作台随访视图（按调用者权限）。next_due_date = 最近随访日期（无随访时为基线日期）+ 项目随访间隔；followup_state：inactive 非随访中、no_visit 尚无随访、overdue 已逾期、due_soon 14 天内到期、ok。last_link_* 为最近生成的一条随访链接（含已撤销）；active_link_count 只计未过期、未撤销、未用完的链接。';
COMMENT ON VIEW public.v_project_overview IS
  '项目概况（按调用者权限）。n_visits_30d：随访日期在最近 30 天内；core_completeness：随访日期、收缩压、舒张压、血肌酐、UPCR 均已填写的随访占比（无随访时为空）；n_open_issues：未解决的数据质控问题。';

-- Patient page: unchanged columns, then the study details the project chose to show.
DROP FUNCTION IF EXISTS public.patient_get_context(text);
CREATE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE(project_id uuid,project_name text,center_code text,module text,
  patient_code text,sex text,birth_year int,trial_expires_at timestamptz,
  trial_grace_until timestamptz,subscription_plan text,subscription_active_until timestamptz,
  can_write boolean,write_block_reason text,single_use boolean,token_expires_at timestamptz,
  public_title text,institution_name text,ethics_approval_no text,contact_display text)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p.id,p.name,p.center_code,p.module,t.patient_code,b.sex,b.birth_year,
    p.trial_expires_at,p.trial_grace_until,p.subscription_plan,p.subscription_active_until,
    w.can_write,w.write_block_reason,t.single_use,t.expires_at,
    p.public_title,p.institution_name,p.ethics_approval_no,p.contact_display
  FROM registry_private.patient_token(p_token) t
  JOIN public.projects p ON p.id=t.project_id
  JOIN public.patients_baseline b ON b.project_id=t.project_id AND b.patient_code=t.patient_code
  CROSS JOIN LATERAL registry_private.project_write_status(p.id) w;
$$;
REVOKE ALL ON FUNCTION public.patient_get_context(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patient_get_context(text) TO anon,authenticated;

-- Frozen exports are SELECT * and already carry the new columns. Add the reviewed
-- project settings and the consent/follow-up semantics to the immutable package.
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
    bounds AS MATERIALIZED (SELECT ((SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_0 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_1 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_2 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_3 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_4 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_5 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_6 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_7 t) + (SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) FROM rows_8 t)) AS row_bytes, ((SELECT count(*) FROM rows_0)>10000 OR (SELECT count(*) FROM rows_1)>10000 OR (SELECT count(*) FROM rows_2)>10000 OR (SELECT count(*) FROM rows_3)>10000 OR (SELECT count(*) FROM rows_4)>10000 OR (SELECT count(*) FROM rows_5)>10000 OR (SELECT count(*) FROM rows_6)>10000 OR (SELECT count(*) FROM rows_7)>10000 OR (SELECT count(*) FROM rows_8)>10000) AS over_rows)
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
        'consent_date','签署或确认研究同意的日期，可为空。',
        'consent_version','知情同意书版本，可为空。',
        'followup_status','随访状态：active 随访中；lost 失访；withdrawn 退出研究；deceased 死亡；kidney_failure 进入肾衰竭（判定标准以研究方案为准）；transferred 转至其他机构。',
        'followup_status_date','随访状态变更日期，可为空。',
        'followup_interval_days','项目设置的计划随访间隔（天），用于提醒排程，不是临床判定标准。'),
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
REVOKE ALL ON FUNCTION public.create_registry_export(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_registry_export(uuid,uuid) TO authenticated;

INSERT INTO public.registry_schema_versions(version) VALUES('0038_followup_workflow') ON CONFLICT(version) DO NOTHING;
COMMIT;
