// Exercise the exact production SQL and verifier against a synthetic native DB.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {root,createDatabase,applyMigrations} from './helpers/pg17-fixture.mjs';
const db=await createDatabase();
try{
 await applyMigrations(db);
 const sql=execFileSync('python3',['-c',"import sys;sys.path.insert(0,'scripts');from capture_registry_database import approved_preflight_sql;print(approved_preflight_sql())"],{cwd:root,encoding:'utf8'});
 const results=await db.exec(sql);
 const report=results.find(r=>r.rows?.[0]?.jsonb_build_object)?.rows[0]?.jsonb_build_object;
 assert.equal(report.server_version_num,170006);
 assert.equal(report.transaction_read_only,'on');
 assert.ok(Object.values(report.checks).every(x=>x===true));
 // Synthetic transport labels ONLY for testing the verifier. This is never
 // written out as a deployable report or presented as a verified hosted connection.
 report.project_ref='etsyglgpiutflethgirs';
 report.identity_source='verified_connection_host';
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'releases/registry-integrated-pg17-v3-20260914/registry-integrated-pg17-v3-20260914.manifest.json')));
 const checked=execFileSync('python3',['-c',"import sys,json;sys.path.insert(0,'scripts');from registry_integrated_release import verify_db;x=json.load(sys.stdin);print(verify_db(x['report'],x['manifest']))"],{cwd:root,input:JSON.stringify({report,manifest}),encoding:'utf8',maxBuffer:4*1024*1024});
 assert.equal(checked.trim(),'canonical');
 console.log('PG17_PREFLIGHT_OK: exact read-only query and v3 verifier agree on native PostgreSQL 17.6; synthetic database only');
}finally{await db.close();}
