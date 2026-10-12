-- 0039: patient follow-up links are stored only as SHA-256 digests.
-- digest = encode(sha256(convert_to(token,'UTF8')),'hex') with PostgreSQL's built-in
-- sha256() (no pgcrypto). This is the same digest that security_audit_logs.token_hash
-- has recorded since 0032, so audit rows and link rows now join on one value.
-- Existing links keep working: a presented link is hashed the same way and compared.
-- A stored value that is not a 32-character lowercase hex link (a legacy anomaly) is
-- still converted to its digest, but that link is revoked and the revocation audited.
-- From here on no plaintext link is stored: create_patient_token_v2 returns it once,
-- to its creator only, and workbench revocation uses revoke_patient_token_by_id.
-- Backups taken BEFORE this migration still contain the old plaintext links, and the
-- erased values stay in dead heap tuples until VACUUM FULL public.patient_tokens runs
-- after deployment (VACUUM cannot run inside this transaction). The two old indexes
-- on the plaintext column are dropped here, so their files leave the disk at commit.
-- Links of a participant who declined or withdrew consent, or who withdrew from the
-- study or died, are never issued, opened or used for a submission.
BEGIN;

-- Preconditions: the metadata trigger bypassed below exists, 0038 (study status) is
-- in place, and no plaintext link is stored twice (each digest must stay unique).
DO $$
DECLARE n_dup bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0038_followup_workflow') THEN
    RAISE EXCEPTION '迁移 0039 已中止：尚未执行迁移 0038（研究同意与随访状态）。请先执行 0038，需人工核对后再迁移。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.patient_tokens'::regclass
    AND tgname='tr_tokens_updated_meta' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '迁移 0039 已中止：随访链接表缺少本迁移依赖的触发器（tr_tokens_updated_meta）。请先确认数据库已按 0001–0038 完整升级，需人工核对后再迁移。';
  END IF;
  SELECT count(*) INTO n_dup FROM (SELECT 1 FROM public.patient_tokens WHERE token IS NOT NULL
    GROUP BY token HAVING count(*) > 1) AS dup;
  IF n_dup > 0 THEN
    RAISE EXCEPTION '迁移 0039 已中止：随访链接表中有 % 组链接明文重复，转换为摘要后无法区分。需人工核对后再迁移（确认重复链接的归属并撤销多余的记录）。',n_dup;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION registry_private.token_digest(p_token text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(p_token,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION registry_private.token_digest(text) FROM PUBLIC,anon,authenticated;

-- Every bearer lookup starts here. Issued links are 32 characters; NULL, empty, very
-- short or very long input is refused with the ordinary invalid-link error before any
-- lookup, so a legacy anomaly such as an empty stored link can never match.
CREATE OR REPLACE FUNCTION registry_private.token_lookup_digest(p_token text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 24 AND 200 THEN
    RAISE EXCEPTION 'token_invalid_or_expired' USING ERRCODE='42501';
  END IF;
  RETURN registry_private.token_digest(p_token);
END $$;
REVOKE ALL ON FUNCTION registry_private.token_lookup_digest(text) FROM PUBLIC,anon,authenticated;

ALTER TABLE public.patient_tokens ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE public.patient_tokens ALTER COLUMN token DROP NOT NULL;
-- Plaintext keys must not linger in index pages; token_hash gets its own unique index.
ALTER TABLE public.patient_tokens DROP CONSTRAINT IF EXISTS patient_tokens_token_key;
DROP INDEX IF EXISTS public.patient_tokens_token_idx;
-- Each digest is computed from the old value and the plaintext erased in the same row
-- update. The metadata trigger is bypassed so updated_at/updated_by keep the last real
-- change. Legacy-format values are revoked (and audited) as they are converted. The
-- counts are carried to the summary audit entry at the end of this migration.
ALTER TABLE public.patient_tokens DISABLE TRIGGER tr_tokens_updated_meta;
DO $$
DECLARE n_legacy bigint; n_regular bigint;
BEGIN
  WITH legacy AS (
    UPDATE public.patient_tokens SET token_hash=registry_private.token_digest(token),token=NULL,active=false,
      revoked_at=coalesce(revoked_at,now()),
      revoke_reason=CASE WHEN revoked_at IS NULL THEN 'legacy_token_format' ELSE revoke_reason END
    WHERE token IS NOT NULL AND token !~ '^[0-9a-f]{32}$'
    RETURNING id,project_id,patient_code,token_hash)
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
    SELECT project_id,patient_code,token_hash,'legacy_token_format_revoked','HIGH',
      jsonb_build_object('token_id',id,'migration','0039_patient_token_hashing')
    FROM legacy;
  GET DIAGNOSTICS n_legacy = ROW_COUNT;
  UPDATE public.patient_tokens SET token_hash=registry_private.token_digest(token),token=NULL
    WHERE token IS NOT NULL;
  GET DIAGNOSTICS n_regular = ROW_COUNT;
  PERFORM set_config('registry.migration_0039_erased',(n_legacy+n_regular)::text,true);
  PERFORM set_config('registry.migration_0039_legacy',n_legacy::text,true);
END $$;
ALTER TABLE public.patient_tokens ENABLE TRIGGER tr_tokens_updated_meta;
ALTER TABLE public.patient_tokens ALTER COLUMN token_hash SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.patient_tokens'::regclass AND conname='patient_tokens_token_hash_key') THEN
    ALTER TABLE public.patient_tokens ADD CONSTRAINT patient_tokens_token_hash_key UNIQUE(token_hash);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.patient_tokens'::regclass AND conname='patient_tokens_token_hash_format') THEN
    ALTER TABLE public.patient_tokens ADD CONSTRAINT patient_tokens_token_hash_format CHECK(token_hash ~ '^[0-9a-f]{64}$');
  END IF;
  -- The legacy column remains only for old readers; a plaintext value can never return.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.patient_tokens'::regclass AND conname='patient_tokens_plaintext_not_stored') THEN
    ALTER TABLE public.patient_tokens ADD CONSTRAINT patient_tokens_plaintext_not_stored CHECK(token IS NULL);
  END IF;
END $$;
COMMENT ON COLUMN public.patient_tokens.token IS '已停用：数据库不再保存随访链接明文，始终为空。';
COMMENT ON COLUMN public.patient_tokens.token_hash IS '随访链接的 SHA-256 摘要（UTF-8 编码后十六进制小写），与 security_audit_logs.token_hash 相同算法。';

-- Every patient-page lookup goes through the digest. A NULL, malformed or unknown link
-- finds no row. A participant who left the study (declined/withdrawn consent, withdrawn
-- or deceased) is not served by any link, including one that escaped revocation.
CREATE OR REPLACE FUNCTION registry_private.patient_token(p_token text)
RETURNS public.patient_tokens LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE; v_digest text := registry_private.token_lookup_digest(p_token);
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token_hash=v_digest;
  PERFORM registry_private.assert_token(v_token);
  IF EXISTS (SELECT 1 FROM public.patients_baseline b
    WHERE b.project_id=v_token.project_id AND b.patient_code=v_token.patient_code
      AND (b.consent_status IN ('declined','withdrawn') OR b.followup_status IN ('withdrawn','deceased'))) THEN
    RAISE EXCEPTION 'token_invalid_or_expired' USING ERRCODE='42501';
  END IF;
  RETURN v_token;
END $$;

-- Patient submission. Lock order: project (KEY SHARE), the patient's baseline row, then
-- the link row - the order of every staff write path, so a submission and a concurrent
-- study-exit change, import or correction wait for each other instead of deadlocking.
-- Structured, non-raising outcomes (the link revocation must commit):
--   rate_limited / same_day_limit_exceeded: the link is disabled;
--   token_revoked: the participant has left the study; this link is disabled now;
--   invalid_values: a value is outside the range the visit table accepts; invalid_fields
--     names the columns (sbp, dbp, scr_umol_l, upcr, egfr, visit_date, notes; a calculated
--     eGFR above 200 is reported as scr_umol_l). Nothing is stored; a single-use link stays unused.
DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text,uuid);
CREATE FUNCTION public.patient_submit_visit_v2(
  p_token text,p_visit_date date,p_sbp numeric DEFAULT NULL,p_dbp numeric DEFAULT NULL,
  p_scr_umol_l numeric DEFAULT NULL,p_upcr numeric DEFAULT NULL,p_egfr numeric DEFAULT NULL,
  p_notes text DEFAULT NULL,p_request_id uuid DEFAULT NULL
) RETURNS TABLE(visit_id uuid,server_time timestamptz,receipt_token text,
  receipt_expires_at timestamptz,status text,message text,invalid_fields text[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_digest text := registry_private.token_lookup_digest(p_token);
  v_found public.patient_tokens%ROWTYPE;
  v_token public.patient_tokens%ROWTYPE;
  v_existing public.visits_long%ROWTYPE;
  v_receipt public.visit_receipts%ROWTYPE;
  v_consent text; v_followup text; v_sex text; v_birth_year int; v_age numeric; v_egfr numeric;
  v_invalid text[] := ARRAY[]::text[]; v_constraint text; v_table text; v_column text;
  v_id uuid; v_hash text; v_count int; v_status text; v_message text;
BEGIN
  SELECT * INTO v_found FROM public.patient_tokens WHERE token_hash=v_digest;
  PERFORM registry_private.assert_token(v_found,true);
  PERFORM 1 FROM public.projects WHERE id=v_found.project_id FOR KEY SHARE;
  -- Serialize all token submissions for this patient, including different links.
  SELECT b.consent_status,b.followup_status,b.sex,b.birth_year
    INTO v_consent,v_followup,v_sex,v_birth_year
    FROM public.patients_baseline b WHERE b.project_id=v_found.project_id
      AND b.patient_code=v_found.patient_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  SELECT * INTO v_token FROM public.patient_tokens WHERE id=v_found.id FOR UPDATE;
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
        v_receipt.expires_at,'submitted'::text,'已提交，无需重复录入'::text,NULL::text[];
      RETURN;
    END IF;
  END IF;
  PERFORM registry_private.assert_token(v_token);
  -- A link that escaped revocation (e.g. issued while the exit was being recorded) is
  -- revoked here; nothing is stored.
  IF v_consent IN ('declined','withdrawn') OR v_followup IN ('withdrawn','deceased') THEN
    UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason='patient_exited' WHERE id=v_token.id;
    INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
      VALUES(v_token.project_id,v_token.patient_code,v_token.token_hash,'patient_exited_submission_refused','HIGH',
        jsonb_build_object('token_id',v_token.id,'consent_status',v_consent,'followup_status',v_followup));
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,'token_revoked'::text,
      '该患者已拒绝或撤回知情同意、或已退出研究，此随访链接已停用，本次未保存。'::text,NULL::text[];
    RETURN;
  END IF;
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
  -- The ranges of the visit table's CHECK constraints (0002, 0014). eGFR is calculated
  -- on the server from creatinine exactly as trg_auto_egfr does; an out-of-range result
  -- points at the creatinine value the participant entered.
  IF p_sbp NOT BETWEEN 40 AND 300 THEN v_invalid := v_invalid || 'sbp'::text; END IF;
  IF p_dbp NOT BETWEEN 20 AND 200 THEN v_invalid := v_invalid || 'dbp'::text; END IF;
  IF p_scr_umol_l NOT BETWEEN 10 AND 5000 THEN v_invalid := v_invalid || 'scr_umol_l'::text;
  ELSIF p_scr_umol_l IS NOT NULL AND upper(v_sex) IN ('M','F') AND v_birth_year IS NOT NULL THEN
    v_age := extract(year FROM p_visit_date) - v_birth_year;
    IF v_age BETWEEN 18 AND 120 THEN
      v_egfr := public.ckd_epi_2021(p_scr_umol_l/88.4,v_sex,v_age);
      IF v_egfr NOT BETWEEN 0 AND 200 THEN v_invalid := v_invalid || 'scr_umol_l'::text; END IF;
    END IF;
  END IF;
  IF p_upcr NOT BETWEEN 0 AND 50000 THEN v_invalid := v_invalid || 'upcr'::text; END IF;
  IF cardinality(v_invalid) > 0 THEN
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,'invalid_values'::text,
      '部分数值超出系统允许的范围，本次未保存，请核对后重新填写。'::text,v_invalid;
    RETURN;
  END IF;
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
      VALUES(v_token.project_id,v_token.patient_code,v_token.token_hash,
        v_status,'HIGH',jsonb_build_object('count',v_count));
    -- Return, do not RAISE: the revocation and audit must commit.
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,v_status,v_message,NULL::text[];
    RETURN;
  END IF;
  -- Any CHECK violation not anticipated above becomes the same structured outcome;
  -- the subtransaction leaves nothing behind.
  BEGIN
    INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,
      egfr,egfr_formula_version,notes,submission_request_id,submitted_via_token_id,submission_payload_hash)
      VALUES(v_token.project_id,v_token.patient_code,p_visit_date,p_sbp,p_dbp,p_scr_umol_l,p_upcr,
        NULL,'missing_inputs',coalesce(p_notes,''),p_request_id,v_token.id,v_hash)
      RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME, v_table = TABLE_NAME, v_column = COLUMN_NAME;
    IF coalesce(v_column,'') <> '' THEN v_invalid := ARRAY[v_column];
    ELSE
      SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum),ARRAY[]::text[]) INTO v_invalid
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
        WHERE c.conname=v_constraint AND c.conrelid=to_regclass(format('public.%I',v_table));
    END IF;
    RETURN QUERY SELECT NULL::uuid,now(),NULL::text,NULL::timestamptz,'invalid_values'::text,
      '部分数值超出系统允许的范围，本次未保存，请核对后重新填写。'::text,v_invalid;
    RETURN;
  END;
  IF v_token.single_use THEN UPDATE public.patient_tokens SET used_at=now() WHERE id=v_token.id; END IF;
  INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at)
    VALUES(v_id,replace(gen_random_uuid()::text,'-',''),now()+interval '24 hours') RETURNING * INTO v_receipt;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,v_token.token_hash,
      'visit_submitted','INFO',jsonb_build_object('visit_id',v_id,'single_use',v_token.single_use));
  RETURN QUERY SELECT v_id,now(),v_receipt.receipt_token,v_receipt.expires_at,'submitted'::text,'提交成功'::text,NULL::text[];
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
  where t.token_hash = registry_private.token_digest(p_token)
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
  where t.token_hash = registry_private.token_digest(p_token)
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
  where t.token_hash = registry_private.token_digest(p_token)
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
  where t.token_hash = registry_private.token_digest(p_token)
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
  where t.token_hash = registry_private.token_digest(p_token)
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by e.event_date desc nulls last, e.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;


-- A participant who declined or withdrew consent, withdrew from the study or died gets
-- no new link. FOR SHARE on the baseline row orders this with a concurrent exit change:
-- either the exit committed first and is seen here, or it waits for this transaction and
-- its trigger then revokes the link inserted below.
CREATE OR REPLACE FUNCTION public.create_patient_token_v2(
  p_project_id uuid,p_patient_code text,p_expires_in_days int DEFAULT 30,
  p_single_use boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token text; v_consent text; v_followup text;
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  -- SHARE conflicts with membership changes' NO KEY UPDATE lock. Recheck after waiting:
  -- a concurrently removed editor must not mint a fresh bearer token after bulk revocation.
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR SHARE;
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  PERFORM public.assert_project_write_allowed(p_project_id);
  IF p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 365
    OR p_single_use IS NULL THEN RAISE EXCEPTION 'invalid_token_options'; END IF;
  SELECT b.consent_status,b.followup_status INTO v_consent,v_followup FROM public.patients_baseline b
    WHERE b.project_id=p_project_id AND b.patient_code=p_patient_code FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'patient_not_found'; END IF;
  IF v_consent IN ('declined','withdrawn') OR v_followup IN ('withdrawn','deceased') THEN
    RAISE EXCEPTION 'patient_not_eligible_for_links'
      USING HINT='该患者已拒绝或撤回知情同意，或已退出研究、死亡，不能再发放随访链接。';
  END IF;
  v_token:=replace(gen_random_uuid()::text,'-','');
  -- Only the digest is stored; the plaintext is returned to this caller once.
  INSERT INTO public.patient_tokens(project_id,patient_code,token_hash,expires_at,single_use,created_by)
    VALUES(p_project_id,p_patient_code,registry_private.token_digest(v_token),
      now()+make_interval(days=>p_expires_in_days),p_single_use,auth.uid());
  RETURN v_token;
END $$;

-- Kept for links still held in a browser session; looks the link up by digest. Same
-- rules as revoke_patient_token_by_id: a link revoked before keeps its first revocation
-- time and reason and is not audited again; a deactivated link keeps its reason.
CREATE OR REPLACE FUNCTION public.revoke_patient_token(p_token text,p_revoke_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE; v_digest text := registry_private.token_lookup_digest(p_token);
BEGIN
  SELECT * INTO v_token FROM public.patient_tokens WHERE token_hash=v_digest FOR UPDATE;
  PERFORM public.assert_project_permission(v_token.project_id,'tokens');
  IF v_token.revoked_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.patient_tokens SET active=false,revoked_at=now(),
    revoke_reason=coalesce(revoke_reason,left(p_revoke_reason,500))
    WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,v_token.token_hash,
      auth.uid(),'token_revoked','INFO',jsonb_build_object('token_id',v_token.id));
END $$;

-- Workbench revocation by link id, for owners/editors. Allowed after a trial ends:
-- withdrawing a bearer link must never depend on the account entitlement.
-- A link revoked before keeps its first revocation; a deactivated link keeps its reason.
CREATE OR REPLACE FUNCTION public.revoke_patient_token_by_id(p_project_id uuid,p_token_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_token public.patient_tokens%ROWTYPE; v_reason text := btrim(p_reason);
BEGIN
  PERFORM public.assert_project_permission(p_project_id,'tokens');
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'revoke_reason_required'; END IF;
  IF public._contains_pii(v_reason) THEN RAISE EXCEPTION 'pii_detected_blocked'; END IF;
  -- Scoped to the authorized project: another project's link id is indistinguishable from none.
  SELECT * INTO v_token FROM public.patient_tokens WHERE id=p_token_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'token_not_found'; END IF;
  IF v_token.revoked_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.patient_tokens SET active=false,revoked_at=now(),revoke_reason=coalesce(revoke_reason,v_reason)
    WHERE id=v_token.id;
  INSERT INTO public.security_audit_logs(project_id,patient_code,token_hash,actor_uid,event_type,severity,details)
    VALUES(v_token.project_id,v_token.patient_code,v_token.token_hash,auth.uid(),'token_revoked','INFO',
      jsonb_build_object('token_id',v_token.id,'reason',v_reason,'method','by_id'));
END $$;

-- Replacements retain their ACLs; restate the exposed contract explicitly.
REVOKE ALL ON FUNCTION registry_private.patient_token(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
  public.revoke_patient_token_by_id(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_patient_token_v2(uuid,text,int,boolean),public.revoke_patient_token(text,text),
  public.revoke_patient_token_by_id(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.patient_list_visits(text,int),public.patient_list_labs(text,int),
  public.patient_list_meds(text,int),public.patient_list_variants(text,int),public.patient_list_events(text,int),
  public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patient_list_visits(text,int),public.patient_list_labs(text,int),
  public.patient_list_meds(text,int),public.patient_list_variants(text,int),public.patient_list_events(text,int),
  public.patient_submit_visit_v2(text,date,numeric,numeric,numeric,numeric,numeric,text,uuid) TO anon,authenticated;

-- One summary audit entry, written when this migration is first applied: how many
-- plaintext links were erased (and how many legacy-format links were revoked). It
-- carries counts only, never link material.
DO $$
DECLARE n_erased bigint := coalesce(nullif(current_setting('registry.migration_0039_erased',true),''),'0')::bigint;
  n_legacy bigint := coalesce(nullif(current_setting('registry.migration_0039_legacy',true),''),'0')::bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0039_patient_token_hashing')
    OR n_erased > 0 THEN
    INSERT INTO public.security_audit_logs(event_type,severity,details)
      VALUES('plaintext_tokens_erased','INFO',jsonb_build_object('migration','0039_patient_token_hashing',
        'erased_count',n_erased,'legacy_format_revoked_count',n_legacy,
        'summary',format('已清除 %s 条明文链接（其中 %s 条格式异常的旧链接已同时停用）',n_erased,n_legacy)));
  END IF;
  PERFORM set_config('registry.migration_0039_erased','',true);
  PERFORM set_config('registry.migration_0039_legacy','',true);
END $$;

INSERT INTO public.registry_schema_versions(version) VALUES('0039_patient_token_hashing') ON CONFLICT(version) DO NOTHING;
COMMIT;
