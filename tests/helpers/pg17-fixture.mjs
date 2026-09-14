// Isolated PG17 fixture: synthetic Auth/Storage; never connects to Supabase.
import {initdb,pg_ctl} from '@embedded-postgres/linux-x64';
import pg from 'pg';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const migrationPath=path.join(root,'supabase/migration-manifest.json');
export const migrations=JSON.parse(fs.readFileSync(migrationPath)).migrations;
export const migrationManifestHash=crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
const execute=promisify(execFile);
export async function createDatabase({bootstrap=true}={}){
 assert.equal(typeof bootstrap,'boolean');
 assert.equal(process.platform,'linux','PG17 reference uses the pinned Linux x64 runtime');
 assert.equal(process.arch,'x64');
 const native=path.resolve(path.dirname(initdb),'..');
 // npm ci --ignore-scripts is retained; hydrate only package-local library links.
 for(const link of JSON.parse(fs.readFileSync(path.join(native,'pg-symlinks.json')))){
  const packageRoot=path.dirname(native);
  const source=path.resolve(packageRoot,link.source), target=path.resolve(packageRoot,link.target);
  assert.ok(source.startsWith(native+'/lib/')&&target.startsWith(native+'/lib/'));
  if(!fs.existsSync(target))fs.symlinkSync(path.relative(path.dirname(target),source),target);
 }
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'ksr-pg17-'));
 fs.chmodSync(folder,0o700);
 const isRoot=process.getuid()===0;
 if(isRoot){
  try{fs.chownSync(folder,65534,65534);}catch(error){fs.rmSync(folder,{recursive:true,force:true});throw new Error('Native PG17 needs a non-root user or mapped unprivileged UID; use the Linux CI job. Do not bypass PostgreSQL privilege checks.',{cause:error});}
 }
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
 Object.assign(env,{LD_LIBRARY_PATH:path.join(native,'lib'),LC_ALL:'C'});
 const options={cwd:folder,env,timeout:30000,maxBuffer:2*1024*1024,...(isRoot?{uid:65534,gid:65534}:{})};
 const data=path.join(folder,'data');
 let started=false,client;
 const close=async()=>{
  try{if(client)await client.end();}finally{
   try{if(started)await execute(pg_ctl,['-D',data,'-m','immediate','-w','stop'],options);}
   finally{fs.rmSync(folder,{recursive:true,force:true});}
  }
 };
 try{
  await execute(initdb,['-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C'],options);
  await execute(pg_ctl,['-D',data,'-l',path.join(folder,'server.log'),'-o',`-F -c listen_addresses='' -c unix_socket_directories='${folder}' -c unix_socket_permissions=0700 -p 55432`,'-w','start'],options);
  started=true;
  client=new pg.Client({host:folder,port:55432,user:'postgres',database:'postgres',ssl:false});
  await client.connect();
 }catch(error){await close();throw error;}
 // Native tools always target this fixture's private socket. There is no host,
 // URL, credential or database-name argument that a caller can override.
 const clientTool=async (name,args)=>{
  assert.ok(['pg_dump','pg_restore'].includes(name));
  const binary=`/usr/lib/postgresql/17/bin/${name}`;
  // System client packages use their own matching libpq, not the embedded
  // server's packaged libraries. All ambient PG* settings remain removed.
  const clientEnv={...env}; delete clientEnv.LD_LIBRARY_PATH;
  const clientOptions={...options,env:clientEnv};
  const version=(await execute(binary,['--version'],clientOptions)).stdout.trim();
  assert.match(version,/\(PostgreSQL\) 17(?:\.|\s|$)/,'Backup clients must be PostgreSQL 17');
  const output=await execute(binary,args,{...clientOptions,timeout:60000});
  return {version,...output};
 };
 const connectionArgs=['--host',folder,'--port','55432','--username','postgres','--dbname','postgres','--no-password'];
 const db={query:(sql,args)=>client.query(sql,args),exec:async sql=>{const r=await client.query(sql);return Array.isArray(r)?r:[r];},close,
  dumpCustom:async()=>{
   const destination=path.join(folder,'synthetic-backup.dump');
   const {version}=await clientTool('pg_dump',[...connectionArgs,'--format=custom','--file',destination]);
   const archive=fs.readFileSync(destination);
   assert.equal(archive.subarray(0,5).toString('ascii'),'PGDMP');
   return {archive,sha256:crypto.createHash('sha256').update(archive).digest('hex'),clientVersion:version};
  },
  restoreCustom:async archive=>{
   assert.equal(bootstrap,false,'Restore requires a fresh fixture without application bootstrap');
   assert.ok(Buffer.isBuffer(archive));
   assert.equal(archive.subarray(0,5).toString('ascii'),'PGDMP','Expected a real custom-format pg_dump archive');
   const {n}=(await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname IN ('public','auth','storage','extensions','registry_private')")).rows[0];
   assert.equal(n,0,'Refuse to restore over any existing application objects');
   const source=path.join(folder,'synthetic-restore.dump');
   fs.writeFileSync(source,archive,{mode:0o600});
   if(isRoot)fs.chownSync(source,65534,65534);
   // Preserve owners, table grants and default grants; errors roll back together.
   return clientTool('pg_restore',[...connectionArgs,'--exit-on-error','--single-transaction',source]);
  }
 };
 const {major}=(await db.query("select current_setting('server_version_num')::int/10000 as major")).rows[0];
 assert.equal(major,17,'PG17 reference must run on major 17');
 await db.exec("SET timezone='UTC'; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
 // pg_dump does not contain cluster-global roles. Empty restore fixtures create
 // just the same synthetic role names; every application object must be restored.
 if(!bootstrap)return db;
 await db.exec("CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;");
 await db.exec(`
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
 return db;
}
export async function applyMigrations(db,{historicalCrlf=false,phase='all'}={}){
 assert.ok(['all','baseline','upgrade'].includes(phase));
 let count=0;
 for(const m of migrations){
  const historical=Number(m.file.slice(0,4))<32;
  if((phase==='baseline'&&!historical)||(phase==='upgrade'&&historical))continue;
  const bytes=fs.readFileSync(path.join(root,'supabase/migrations',m.file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),m.sha256,m.file);
  let sql=bytes.toString('utf8');
  // Exactly two source-derived profiles, not normalization of a live report.
  // Old SQL transported as CRLF is executed as those exact reviewed bytes;
  // the five new migrations are always the committed LF bytes.
  if(historicalCrlf&&historical){assert.ok(!sql.includes('\r'));sql=sql.replaceAll('\n','\r\n');}
  try{await db.exec(sql);}catch(e){throw new Error(m.file+': '+e.message,{cause:e});}
  count++;
 }
 return count;
}
export async function readContract(db){
 const sql=fs.readFileSync(path.join(root,'scripts/database_contract.sql'),'utf8');
 const results=await db.exec("BEGIN READ ONLY; SET LOCAL timezone='UTC'; SET LOCAL search_path=pg_catalog,public;\n"+sql+"\nROLLBACK;");
 const result=results.find(r=>r.rows?.[0]?.jsonb_build_object)?.rows[0]?.jsonb_build_object;
 assert.ok(result,'contract query must return one JSON object');
 return typeof result==='string'?JSON.parse(result):result;
}
