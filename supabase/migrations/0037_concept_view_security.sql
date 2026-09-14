-- The export mapping contains the public, read-only concept dictionary only.
-- Evaluate its source relation with the caller's privileges and RLS policies,
-- so future restrictions on the dictionary cannot be bypassed by the view owner.
BEGIN;
ALTER VIEW public.v_concept_export_mapping SET (security_invoker = true);
REVOKE ALL ON public.v_concept_export_mapping FROM PUBLIC,anon,authenticated;
-- Table-level REVOKE does not remove independently granted column privileges.
REVOKE ALL (english_code,chinese_column_name,chinese_short_name,domain,affects_export)
  ON public.v_concept_export_mapping FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_concept_export_mapping TO anon,authenticated;
INSERT INTO public.registry_schema_versions(version) VALUES('0037_concept_view_security') ON CONFLICT(version) DO NOTHING;
COMMIT;
