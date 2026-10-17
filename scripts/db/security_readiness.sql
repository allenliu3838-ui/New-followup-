-- Read-only preflight for 0032. Run against the explicitly selected registry database.
-- Outputs aggregate checks only, never patient rows or bearer credentials.
-- A PASS marker alone is not evidence of applied policy/function definitions.
BEGIN READ ONLY;
SELECT version,applied_at FROM public.registry_schema_versions ORDER BY version;
SELECT c.relname,c.relrowsecurity,
  has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
  has_table_privilege('authenticated',c.oid,'INSERT') AS authenticated_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') AS authenticated_update
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('visit_receipts','patient_tokens','data_issues',
  'field_audit_log','demo_requests','concept_dictionary','abbreviation_dictionary','concept_alias_dictionary');
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef,p.proconfig,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
  encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS definition_sha256
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('public','registry_private') AND p.proname IN (
  'upsert_lab_record','validate_visit_record','raise_or_update_issue','resolve_issue_if_exists',
  'log_field_change','patient_get_context','patient_submit_visit','patient_submit_visit_v2',
  'create_patient_token_v2','revoke_patient_token','assert_project_owner','patient_token','assert_token');
SELECT conrelid::regclass AS child_table,conname,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conname LIKE '%_patient_project_fk' ORDER BY conname;

-- NOT VALID preserves existing orphans. These counts must be reconciled before
-- VALIDATE CONSTRAINT; do not delete records or fabricate baselines to silence them.
SELECT 'visits_long' AS source,count(*) AS orphan_count FROM public.visits_long v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code)
UNION ALL SELECT 'labs_long',count(*) FROM public.labs_long v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code)
UNION ALL SELECT 'meds_long',count(*) FROM public.meds_long v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code)
UNION ALL SELECT 'variants_long',count(*) FROM public.variants_long v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code)
UNION ALL SELECT 'events_long',count(*) FROM public.events_long v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code)
UNION ALL SELECT 'patient_tokens',count(*) FROM public.patient_tokens v
 WHERE NOT EXISTS(SELECT 1 FROM public.patients_baseline b WHERE b.project_id=v.project_id AND b.patient_code=v.patient_code);
SELECT count(*) AS legacy_cd19_invalid_absolute_count FROM public.labs_long
  WHERE lab_test_code='CD19' AND unit_symbol='%' AND value_standard IS NOT NULL;
SELECT count(*) AS stale_or_missing_derived_egfr_count
FROM public.visits_long v JOIN public.patients_baseline b
  ON b.project_id=v.project_id AND b.patient_code=v.patient_code
WHERE v.egfr_formula_version='CKD-EPI-2021-Cr'
  AND b.sex IN ('M','F') AND b.birth_year IS NOT NULL AND v.scr_umol_l>0
  AND extract(year FROM v.visit_date)-b.birth_year BETWEEN 18 AND 120
  AND v.egfr IS DISTINCT FROM public.ckd_epi_2021(v.scr_umol_l/88.4,b.sex,extract(year FROM v.visit_date)-b.birth_year);
ROLLBACK;
