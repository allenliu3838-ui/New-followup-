// Recovery acceptance: real PGlite/pgcrypto, synthetic Auth/Storage schemas only.
// This is a new bounded regression suite, not the lost original test sources.
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const db=new PGlite({extensions:{pgcrypto}});
let groups=0;
const pass=label=>{groups++;console.log('PASS '+label);};
const value=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
async function asUser(id,fn){
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
 await db.exec('SET ROLE '+(id?'authenticated':'anon'));
 try{return await fn();}finally{await db.exec('RESET ROLE');await db.exec("RESET request.jwt.claim.sub");}
}
try {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE SCHEMA storage;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text UNIQUE,created_at timestamptz DEFAULT now(),email_confirmed_at timestamptz DEFAULT now());
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb,created_at timestamptz DEFAULT now());
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
 GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
 GRANT ALL ON storage.objects TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated,service_role;`);
 const manifest=JSON.parse(fs.readFileSync('supabase/migration-manifest.json'));
 for(const migration of manifest.migrations){
  const bytes=fs.readFileSync('supabase/migrations/'+migration.file);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),migration.sha256);
  try{await db.exec(bytes.toString());}catch(e){throw new Error(migration.file+': '+e.message);}
 }
 pass('38 canonical migrations execute strictly with real pgcrypto');
 const ids=Array.from({length:5},()=>crypto.randomUUID());
 for(let i=0;i<ids.length;i++)await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[ids[i],`recovery${i}@example.invalid`]);
 const project=await asUser(ids[0],async()=>(await value("select public.create_project('Synthetic recovery','RECOVERY','IGAN') as id")).id);
 for(const [i,role] of [[1,'editor'],[2,'analyst'],[3,'viewer']])await asUser(ids[0],async()=>assert.equal((await value('select public.add_project_member($1,$2,$3) as result',[project,`recovery${i}@example.invalid`,role])).result.status,'added'));
 for(const [i,role] of [[0,'owner'],[1,'editor'],[2,'analyst'],[3,'viewer']])await asUser(ids[i],async()=>{
  const a=(await value('select public.get_project_access($1) as result',[project])).result;
  assert.equal(a.role,role);assert.equal(a.can_write,i<2);assert.equal(a.can_export,i===0||i===2);
 });
 pass('owner/editor/analyst/viewer capabilities are authoritative');
 await asUser(ids[1],async()=>db.query("insert into public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr) values($1,'0001','2025-01-01','F',1980,88.4)",[project]));
 for(const i of [2,3,4])await asUser(ids[i],async()=>assert.rejects(db.query("insert into public.patients_baseline(project_id,patient_code,baseline_date) values($1,'DENIED','2025-01-01')",[project])));
 await asUser(ids[4],async()=>assert.equal((await db.query('select * from public.patients_baseline where project_id=$1',[project])).rows.length,0));
 pass('clinical RLS permits editor writes and denies read-role/cross-project writes');
 await asUser(ids[1],async()=>assert.equal((await value('select public.check_project_quota() as q')).q.used,0));
 const other=await asUser(ids[1],async()=>(await value("select public.create_project('Own synthetic','OTHER','GENERAL') as id")).id);
 await asUser(ids[1],async()=>assert.rejects(db.query('update public.patients_baseline set project_id=$1 where project_id=$2',[other,project]),/immutable|identity|project/i));
 pass('shared projects do not consume owned quota; records cannot move between authorized projects');
 const request=crypto.randomUUID();
 const exported=await asUser(ids[2],async()=>(await value('select public.create_registry_export($1,$2) as e',[project,request])).e);
 assert.equal(crypto.createHash('sha256').update(exported.content_text).digest('hex'),exported.content_sha256);
 assert.equal(Object.keys(JSON.parse(exported.content_text).tables).length,9);
 const replay=await asUser(ids[2],async()=>(await value('select public.create_registry_export($1,$2) as e',[project,request])).e);
 assert.equal(replay.content_text,exported.content_text);
 for(const i of [1,3,4])await asUser(ids[i],async()=>assert.rejects(db.query('select public.create_registry_export($1,$2)',[project,crypto.randomUUID()])));
 pass('frozen exports contain nine tables, match SHA256 and enforce export authority/idempotence');
 await asUser(ids[0],async()=>assert.rejects(db.query("select public.admin_set_subscription($1,'pro',now()+interval '1 year')",[project]),/admin/i));
 pass('project owners cannot grant themselves paid entitlements');
 await asUser(ids[0],async()=>db.query("select public.create_patient_token_v2($1,'0001',1,true)",[project]));
 const removed=await asUser(ids[0],async()=>(await value('select public.remove_project_member($1,$2) as r',[project,ids[1]])).r);
 assert.equal(removed.revoked_token_count,1);
 await asUser(ids[1],async()=>assert.equal((await db.query('select * from public.patients_baseline where project_id=$1',[project])).rows.length,0));
 pass('removing an editor revokes existing project links and subsequent clinical reads');
 await asUser(null,async()=>assert.rejects(db.query('select public.add_project_member($1,$2,$3)',[project,'recovery4@example.invalid','editor'])));
 pass('anonymous callers cannot administer membership');
 const inv=(await db.exec(fs.readFileSync('scripts/db/production_inventory.sql','utf8'))).find(r=>r.rows?.[0]?.registry_inventory);
 assert.ok(inv);assert.equal(JSON.parse(inv.rows[0].registry_inventory).transaction_read_only,'on');
 pass('production inventory runs in a read-only transaction');
 console.log(`RECOVERY_DATABASE_OK ${groups} groups; synthetic local database only.`);
} finally {await db.close();}
