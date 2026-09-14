-- First-step production inventory. Works before the new migrations exist.
-- Catalog metadata only: no patient values, tokens, emails, passwords or function bodies.
BEGIN READ ONLY;
SELECT jsonb_pretty(jsonb_build_object(
  'inventory_version','registry-inventory-v1',
  'checked_at',clock_timestamp(),
  'transaction_read_only',current_setting('transaction_read_only'),
  'database',current_database(),
  'server_version',current_setting('server_version'),
  'note','Database catalogs do not identify the Supabase project region. Confirm the project URL and region separately.',
  'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
  'tables',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'rls_enabled',c.relrowsecurity,
    'estimated_rows',c.reltuples::bigint,
    'anon_select',has_table_privilege('anon',c.oid,'SELECT'),
    'anon_insert',has_table_privilege('anon',c.oid,'INSERT'),
    'authenticated_select',has_table_privilege('authenticated',c.oid,'SELECT'),
    'authenticated_insert',has_table_privilege('authenticated',c.oid,'INSERT'),
    'authenticated_update',has_table_privilege('authenticated',c.oid,'UPDATE'),
    'authenticated_delete',has_table_privilege('authenticated',c.oid,'DELETE')) ORDER BY n.nspname,c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','registry_private') AND c.relkind='r'),
  'functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'security_definer',p.prosecdef,
    'definition_md5',md5(pg_get_functiondef(p.oid)),
    'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE')) ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','registry_private') AND p.prokind='f'),
  'policies',(SELECT jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename,'name',policyname,
    'roles',roles,'command',cmd,'permissive',permissive,'definition_md5',md5(coalesce(qual,'')||':'||coalesce(with_check,'')))
    ORDER BY schemaname,tablename,policyname) FROM pg_policies WHERE schemaname IN ('public','registry_private','storage')),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'type',contype,
    'validated',convalidated,'definition_md5',md5(pg_get_constraintdef(oid))) ORDER BY conrelid::regclass::text,conname)
    FROM pg_constraint WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','registry_private'))),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,
    'function',tgfoid::regprocedure::text,'definition_md5',md5(pg_get_triggerdef(t.oid))) ORDER BY tgrelid::regclass::text,tgname)
    FROM pg_trigger t WHERE NOT tgisinternal AND tgrelid IN
      (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','registry_private')))
)) AS registry_inventory;
ROLLBACK;
