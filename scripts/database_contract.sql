-- Catalog-only contract shared by the strict local builder and live preflight.
-- Extension-owned routines are excluded: Supabase may install pgcrypto in a
-- different schema. Every application routine in public/registry_private counts.
SELECT jsonb_build_object(
 'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(p.oid)),
   'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
   'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'))
   ORDER BY p.oid::regprocedure::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('public','registry_private') AND p.prokind='f'
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),'[]'::jsonb),
 'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'trigger',t.tgname,
   'definition_md5',md5(pg_get_triggerdef(t.oid)),'enabled',t.tgenabled)
   ORDER BY n.nspname,c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','registry_private') AND NOT t.tgisinternal),'[]'::jsonb),
 'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',schemaname,'table',tablename,'policy',policyname,'permissive',permissive,
   'roles',(SELECT array_agg(role_name ORDER BY role_name) FROM unnest(roles) AS role_name),'command',cmd,'qual',qual,'with_check',with_check)
   ORDER BY schemaname,tablename,policyname)
  FROM pg_policies WHERE schemaname IN ('public','registry_private') OR (schemaname='storage' AND tablename='objects')),'[]'::jsonb),
 'tables',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
   'anon_select',has_table_privilege('anon',c.oid,'SELECT'),'anon_insert',has_table_privilege('anon',c.oid,'INSERT'),
   'anon_update',has_table_privilege('anon',c.oid,'UPDATE'),'anon_delete',has_table_privilege('anon',c.oid,'DELETE'),
   'auth_select',has_table_privilege('authenticated',c.oid,'SELECT'),'auth_insert',has_table_privilege('authenticated',c.oid,'INSERT'),
   'auth_update',has_table_privilege('authenticated',c.oid,'UPDATE'),'auth_delete',has_table_privilege('authenticated',c.oid,'DELETE'),
   'constraints',CASE WHEN n.nspname='storage' THEN '[]'::jsonb ELSE COALESCE((
     SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition_md5',md5(pg_get_constraintdef(k.oid)),
       'validated',k.convalidated,'type',k.contype) ORDER BY k.conname)
     FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb) END)
   ORDER BY n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND (n.nspname IN ('public','registry_private') OR (n.nspname='storage' AND c.relname='objects'))
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),'[]'::jsonb)
);
