// Actual pg_dump/pg_restore rehearsal using synthetic data and private sockets.
// No production dump, credentials, database URL or uploaded metadata is accepted.
// Storage rows below are metadata only; no object bytes are backed up or restored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root,createDatabase,applyMigrations,readContract} from './helpers/pg17-fixture.mjs';

assert.equal(process.argv.length,2,'Synthetic restore rehearsal accepts no external input');
const owner=randomUUID(), project=randomUUID(), visit=randomUUID();
const patient='SYNTHETIC-RESTORE-001', token=`synthetic-restore-${randomUUID()}`;
const preservedTables=[
 'auth.users','public.projects','public.patients_baseline','public.visits_long',
 'public.labs_long','public.meds_long','public.variants_long','public.events_long',
 'public.visit_receipts','public.patient_tokens','public.concept_dictionary',
 'public.concept_alias_dictionary','public.abbreviation_dictionary',
 'storage.buckets','storage.objects'
];
let source,restored,groups=0;
const pass=label=>{groups++;console.log(`PASS ${label}`);};
const quote=name=>`"${name.replaceAll('"','""')}"`;
const permissionDenied=error=>error.code==='42501';

async function captureRows(db){
 const tables=(await db.query(`SELECT n.nspname AS schema,c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth','storage','registry_private')
  ORDER BY n.nspname,c.relname`)).rows;
 const result={};
 for(const {schema,name} of tables){
  result[`${schema}.${name}`]=(await db.query(
   `SELECT to_jsonb(t) AS record FROM ${quote(schema)}.${quote(name)} t ORDER BY to_jsonb(t)::text`
  )).rows.map(r=>r.record);
 }
 return result;
}

async function captureSequences(db){
 const names=(await db.query(`SELECT n.nspname AS schema,c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='S' AND n.nspname IN ('public','auth','storage','registry_private')
  ORDER BY n.nspname,c.relname`)).rows;
 const result={};
 for(const {schema,name} of names){
  result[`${schema}.${name}`]=(await db.query(
   `SELECT last_value::text,is_called FROM ${quote(schema)}.${quote(name)}`
  )).rows[0];
 }
 return result;
}

async function captureAccess(db){
 // Role names are recreated by the fixture because pg_dump omits global roles.
 // Compare effective definitions plus all schema/default grants by role names;
 // numeric catalog OIDs must not be used across independent clusters.
 const roles=(await db.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,
  rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles
  WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`)).rows;
 const defaults=(await db.query(`SELECT pg_get_userbyid(d.defaclrole) AS owner,
  n.nspname AS schema,d.defaclobjtype AS type,pg_get_userbyid(a.grantor) AS grantor,
  CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type,a.is_grantable
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  ORDER BY owner,schema,type,grantor,grantee,a.privilege_type,a.is_grantable`)).rows;
 const schemas=(await db.query(`SELECT n.nspname AS schema,pg_get_userbyid(n.nspowner) AS owner,
  pg_get_userbyid(a.grantor) AS grantor,
  CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type,a.is_grantable FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
  WHERE n.nspname IN ('public','auth','storage','registry_private','extensions')
  ORDER BY schema,owner,grantor,grantee,a.privilege_type,a.is_grantable`)).rows;
 return {roles,defaults,schemas};
}

async function asRole(db,user,operation){
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user||'']);
 await db.exec(`SET ROLE ${user?'authenticated':'anon'}`);
 try{return await operation();}
 finally{await db.exec('RESET ROLE; RESET request.jwt.claim.sub;');}
}

try{
 source=await createDatabase();
 assert.equal(await applyMigrations(source,{phase:'baseline'}),33);
 await source.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[owner,'restore-only@example.invalid']);
 await source.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic restore project','SYNTHETIC','IGAN',$2)",[project,owner]);
 await source.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,CURRENT_DATE-30,'F',1980,88.4,$3)",[project,patient,owner]);
 await source.query("INSERT INTO public.visits_long(id,project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,notes,created_by) VALUES($1,$2,$3,CURRENT_DATE-10,120,75,88.4,'Synthetic restore visit',$4)",[visit,project,patient,owner]);
 await source.query("INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,created_by) VALUES($1,$2,CURRENT_DATE-10,'CREAT',88.4,'umol/L',$3)",[project,patient,owner]);
 await source.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,dose,start_date,created_by) VALUES($1,$2,'Synthetic medication','Synthetic dose',CURRENT_DATE-15,$3)",[project,patient,owner]);
 await source.query("INSERT INTO public.variants_long(project_id,patient_code,test_date,test_name,gene,variant,classification,created_by) VALUES($1,$2,CURRENT_DATE-15,'Synthetic panel','SYNTHETIC','Synthetic variant','VUS',$3)",[project,patient,owner]);
 await source.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,confirmed,source,notes,created_by) VALUES($1,$2,'custom',CURRENT_DATE-10,false,'manual','Synthetic event',$3)",[project,patient,owner]);
 await source.query("INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at) VALUES($1,'synthetic-restore-receipt',now()+interval '1 day')",[visit]);
 await source.query("INSERT INTO public.patient_tokens(project_id,patient_code,token,active,expires_at,created_by) VALUES($1,$2,$3,true,now()+interval '1 day',$4)",[project,patient,token,owner]);
 await source.exec("INSERT INTO public.concept_dictionary(code,display_name_cn,short_name_cn) VALUES('SYNTHETIC_RESTORE','Synthetic restore concept','Synthetic'); INSERT INTO public.concept_alias_dictionary(concept_code,alias_cn) VALUES('SYNTHETIC_RESTORE','Synthetic alias'); INSERT INTO public.abbreviation_dictionary(abbr,full_name_cn,category_cn) VALUES('SYNTHETIC_RESTORE','Synthetic abbreviation','Synthetic');");
 await source.query(`INSERT INTO storage.objects(bucket_id,name,owner,metadata)
  VALUES('payment-proofs','synthetic/metadata-only.pdf',$1,
   '{"synthetic":true,"object_bytes_present":false,"purpose":"metadata restore test only"}'::jsonb)`,[owner]);
 const beforeRows=await captureRows(source), beforeSequences=await captureSequences(source);
 const beforeContract=await readContract(source), beforeAccess=await captureAccess(source);
 for(const table of preservedTables)assert.ok(beforeRows[table]?.length>0,`${table}: seeded representative rows`);
 pass('33 historical migrations with synthetic clinical, auth and Storage metadata records');

 const backup=await source.dumpCustom();
 assert.ok(backup.archive.length>1024,'Custom archive must contain the synthetic database');
 assert.equal(createHash('sha256').update(backup.archive).digest('hex'),backup.sha256);
 await assert.rejects(source.restoreCustom(backup.archive),/fresh fixture/);
 console.log(`SYNTHETIC_BACKUP ${backup.clientVersion}; ${backup.archive.length} bytes; SHA256 ${backup.sha256}`);
 await source.close();source=undefined;
 pass('real custom-format pg_dump archive captured; original cluster stopped and removed');

 restored=await createDatabase({bootstrap:false});
 assert.deepEqual(await captureRows(restored),{},'Fresh destination contains no application tables');
 const restoreResult=await restored.restoreCustom(backup.archive);
 console.log(`SYNTHETIC_RESTORE ${restoreResult.version}`);
 // No baseline migration or application bootstrap has run on this destination.
 assert.deepEqual(await captureRows(restored),beforeRows,'Every dumped row and column restored exactly');
 assert.deepEqual(await captureSequences(restored),beforeSequences,'Sequence values and is_called flags restored');
 assert.deepEqual(await readContract(restored),beforeContract,'Functions, policies, indexes, constraints and grants restored');
 assert.deepEqual(await captureAccess(restored),beforeAccess,'Role definitions, schema ACLs and default ACLs preserved');
 await assert.rejects(restored.restoreCustom(backup.archive),/existing application objects/);
 pass('actual pg_restore reproduces every dumped table, value, sequence and reviewed catalog/ACL');

 assert.equal(await applyMigrations(restored,{phase:'upgrade'}),6);
 const upgradedRows=await captureRows(restored);
 for(const table of preservedTables){
  const old=beforeRows[table],current=upgradedRows[table];
  assert.equal(current.length,old.length,`${table}: historical row count survives upgrade`);
  const columns=Object.keys(old[0]);
  const projection=records=>records.map(record=>JSON.stringify(
   Object.fromEntries(columns.map(column=>[column,record[column]])))).sort();
  assert.deepEqual(projection(current),projection(old),`${table}: every historical field value survives upgrade`);
 }
 const reference=JSON.parse(fs.readFileSync(path.join(root,'supabase/database-contract-pg17.json'),'utf8'));
 assert.deepEqual(await readContract(restored),reference.database_contract_profiles.canonical,
  'Restored then upgraded database must match one complete reviewed canonical profile');
 pass('0032–0037 upgrade preserves 15 populated tables and matches the complete approved PG17 profile');

 await asRole(restored,null,async()=>{
  await assert.rejects(restored.query('SELECT * FROM public.visit_receipts'),permissionDenied);
  await assert.rejects(restored.query("INSERT INTO public.abbreviation_dictionary(abbr,full_name_cn,category_cn) VALUES('DENIED','Denied','Denied')"),permissionDenied);
  assert.equal((await restored.query("SELECT code FROM public.concept_dictionary WHERE code='SYNTHETIC_RESTORE'")).rows.length,1);
  assert.equal((await restored.query('SELECT * FROM public.patient_list_labs($1,30)',[token])).rows.length,1);
  await assert.rejects(restored.query('SELECT * FROM public.patient_list_labs($1,30)',['synthetic-unknown']),permissionDenied);
 });
 await asRole(restored,owner,async()=>{
  assert.equal((await restored.query('SELECT id FROM public.patients_baseline WHERE project_id=$1',[project])).rows.length,1);
 });
 pass('restored application retains authorized reads and rejects public writes and invalid follow-up tokens');

 console.log(`PG17_RESTORE_OK ${groups} groups; native database backup/restore of synthetic records only.`);
 console.log('LIMITATION: Storage metadata restored, but no Storage file bytes, real Auth sessions or production backup were tested.');
}finally{
 if(source)await source.close();
 if(restored)await restored.close();
}
