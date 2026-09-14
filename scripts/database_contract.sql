-- registry-contract-v3-pg17: catalog-only, shared by isolated build and live preflight.
-- Caller MUST set LOCAL TimeZone=UTC and search_path=pg_catalog,public.
-- Function/source text is compared exactly; no whitespace or newline normalization.
-- Extension-owned routines are excluded: Supabase may install pgcrypto in a
-- different schema. Every application routine in public/registry_private counts.
SELECT jsonb_build_object(
 'views',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'name',c.relname,'owner',pg_get_userbyid(c.relowner),
   'definition_md5',md5(pg_get_viewdef(c.oid)),
   'options',COALESCE((SELECT jsonb_agg(opt ORDER BY opt) FROM unnest(c.reloptions) opt),'[]'::jsonb),
   'anon_select',has_table_privilege('anon',c.oid,'SELECT'),'anon_insert',has_table_privilege('anon',c.oid,'INSERT'),
   'anon_update',has_table_privilege('anon',c.oid,'UPDATE'),'anon_delete',has_table_privilege('anon',c.oid,'DELETE'),
   'auth_select',has_table_privilege('authenticated',c.oid,'SELECT'),'auth_insert',has_table_privilege('authenticated',c.oid,'INSERT'),
   'auth_update',has_table_privilege('authenticated',c.oid,'UPDATE'),'auth_delete',has_table_privilege('authenticated',c.oid,'DELETE'),
   'columns',(SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
     'anon_select',has_column_privilege('anon',c.oid,a.attnum,'SELECT'),
     'anon_insert',has_column_privilege('anon',c.oid,a.attnum,'INSERT'),
     'anon_update',has_column_privilege('anon',c.oid,a.attnum,'UPDATE'),
     'auth_select',has_column_privilege('authenticated',c.oid,a.attnum,'SELECT'),
     'auth_insert',has_column_privilege('authenticated',c.oid,a.attnum,'INSERT'),
     'auth_update',has_column_privilege('authenticated',c.oid,a.attnum,'UPDATE')) ORDER BY a.attnum)
     FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))
   ORDER BY n.nspname,c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='v' AND n.nspname IN ('public','registry_private')
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),'[]'::jsonb),
 'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(p.oid)),
   'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
   'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),
   'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,
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
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),'[]'::jsonb),
 'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'name',a.attname,
   'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
   'identity',a.attidentity,'generated',a.attgenerated,'array_dimensions',a.attndims,
   'has_default',a.atthasdef,'default_md5',CASE WHEN d.oid IS NULL THEN NULL ELSE md5(pg_get_expr(d.adbin,d.adrelid)) END,
   'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE (SELECT format('%I.%I',cn.nspname,co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation) END,
   'anon_select',has_column_privilege('anon',c.oid,a.attnum,'SELECT'),
   'anon_insert',has_column_privilege('anon',c.oid,a.attnum,'INSERT'),
   'anon_update',has_column_privilege('anon',c.oid,a.attnum,'UPDATE'),
   'auth_select',has_column_privilege('authenticated',c.oid,a.attnum,'SELECT'),
   'auth_insert',has_column_privilege('authenticated',c.oid,a.attnum,'INSERT'),
   'auth_update',has_column_privilege('authenticated',c.oid,a.attnum,'UPDATE'))
   ORDER BY n.nspname,c.relname,a.attname)
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p')
   AND n.nspname IN ('public','registry_private')
   AND NOT EXISTS(SELECT 1 FROM pg_depend dep WHERE dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.deptype='e')),'[]'::jsonb),
 'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'name',ic.relname,
   'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,
   'ready',i.indisready,'live',i.indislive,'immediate',i.indimmediate,
   'nulls_not_distinct',i.indnullsnotdistinct,'key_count',i.indnkeyatts,'attribute_count',i.indnatts,
   'definition_md5',md5(pg_get_indexdef(i.indexrelid)),
   'predicate_md5',CASE WHEN i.indpred IS NULL THEN NULL ELSE md5(pg_get_expr(i.indpred,i.indrelid)) END,
   'expressions_md5',CASE WHEN i.indexprs IS NULL THEN NULL ELSE md5(pg_get_expr(i.indexprs,i.indrelid)) END,
   'columns',(SELECT jsonb_agg(jsonb_build_object(
     'position',k.position,'column',a.attname,'included',k.position>i.indnkeyatts,'expression',k.attnum=0)
     ORDER BY k.position)
     FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum,position)
     LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum))
   ORDER BY n.nspname,c.relname,ic.relname)
  FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','registry_private')
   AND NOT EXISTS(SELECT 1 FROM pg_depend dep WHERE dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.deptype='e')),'[]'::jsonb),
 'schema_privileges',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'anon_usage',has_schema_privilege('anon',n.oid,'USAGE'),
   'anon_create',has_schema_privilege('anon',n.oid,'CREATE'),
   'auth_usage',has_schema_privilege('authenticated',n.oid,'USAGE'),
   'auth_create',has_schema_privilege('authenticated',n.oid,'CREATE')) ORDER BY n.nspname)
  FROM pg_namespace n WHERE n.nspname IN ('public','registry_private')),'[]'::jsonb),
 'buckets',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',b.id,'public',b.public,'file_size_limit',b.file_size_limit,
   'allowed_mime_types',(SELECT jsonb_agg(m ORDER BY m) FROM unnest(b.allowed_mime_types) AS m)) ORDER BY b.id)
  FROM storage.buckets b WHERE b.id='payment-proofs'),'[]'::jsonb)
);
