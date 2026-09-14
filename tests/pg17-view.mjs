// Native PG17 acceptance for the public concept mapping view. Synthetic only.
// Its ordinary dictionary content stays public; it must obey any future RLS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,createDatabase,applyMigrations,readContract} from './helpers/pg17-fixture.mjs';

assert.equal(process.argv.length,2,'Synthetic view acceptance accepts no external input');
const db=await createDatabase();
const marker='SYNTHETIC_VIEW_RLS';
let groups=0;
const pass=label=>{groups++;console.log(`PASS ${label}`);};
const permissionDenied=error=>error.code==='42501';
const contents=async()=>{
 const result=await db.query('SELECT * FROM public.v_concept_export_mapping ORDER BY english_code');
 return {columns:result.fields.map(field=>({name:field.name,type:field.dataTypeID})),rows:result.rows};
};
async function asRole(role,operation){
 assert.ok(['anon','authenticated'].includes(role));
 await db.exec(`SET ROLE ${role}`);
 try{return await operation();}
 finally{await db.exec('RESET ROLE');}
}
const markerCount=async relation=>Number((await db.query(
 `SELECT count(*) AS n FROM public.${relation} WHERE ${relation==='concept_dictionary'?'code':'english_code'}=$1`,[marker]
)).rows[0].n);

try{
 assert.equal(await applyMigrations(db,{phase:'baseline'}),33);
 await db.query("INSERT INTO public.concept_dictionary(code,display_name_cn,short_name_cn,domain,affects_export) VALUES($1,'Synthetic view concept','Synthetic','SYNTHETIC',true)",[marker]);
 const before=await contents();
 assert.ok(before.rows.some(row=>row.english_code===marker));
 assert.deepEqual(before.columns.map(column=>column.name),[
  'english_code','chinese_column_name','chinese_short_name','domain','affects_export'
 ]);
 // Independently granted column rights survive table-only REVOKE. Seed them
 // deliberately to ensure migration 0037 removes this secondary write path.
 await db.exec(`GRANT INSERT(english_code),UPDATE(domain)
  ON public.v_concept_export_mapping TO PUBLIC,anon,authenticated;`);
 pass('historical mapping columns and dictionary contents captured with synthetic column grants');

 assert.equal(await applyMigrations(db,{phase:'upgrade'}),6);
 assert.deepEqual(await contents(),before,'View names, column types and data stay unchanged');
 const {reloptions}=(await db.query("SELECT reloptions FROM pg_class WHERE oid='public.v_concept_export_mapping'::regclass")).rows[0];
 assert.ok(reloptions.includes('security_invoker=true'));
 assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.registry_schema_versions WHERE version='0037_concept_view_security'")).rows[0].n),1);
 pass('upgrade enables caller privileges and preserves the complete public mapping');

 for(const role of ['anon','authenticated']){
  await asRole(role,async()=>{
   assert.deepEqual(await contents(),before,`${role}: dictionary mapping remains readable`);
   for(const [privilege,column] of [['INSERT','english_code'],['UPDATE','domain'],['REFERENCES','english_code']]){
    assert.equal((await db.query('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',[
     'public.v_concept_export_mapping',column,privilege])).rows[0].allowed,false,
    `${role}: ${privilege} cannot survive through PUBLIC or column grants`);
   }
   await assert.rejects(db.query("INSERT INTO public.v_concept_export_mapping(english_code,chinese_column_name,chinese_short_name,domain,affects_export) VALUES('SYNTHETIC_DENIED','Denied','Denied','SYNTHETIC',true)"),permissionDenied);
   await assert.rejects(db.query('UPDATE public.v_concept_export_mapping SET domain=\'DENIED\' WHERE english_code=$1',[marker]),permissionDenied);
   await assert.rejects(db.query('DELETE FROM public.v_concept_export_mapping WHERE english_code=$1',[marker]),permissionDenied);
  });
 }
 pass('anonymous and authenticated mapping reads work; inserts, updates, deletes and column write grants are denied');

 // This restrictive policy exists only in a rolled-back synthetic transaction.
 // Positive control: temporarily switch to historical owner execution and prove
 // that the same marker becomes visible through the view, but not its base table.
 await db.exec('BEGIN');
 try{
  await db.exec(`CREATE POLICY synthetic_view_rls_guard ON public.concept_dictionary
   AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(code <> 'SYNTHETIC_VIEW_RLS');`);
  for(const role of ['anon','authenticated']){
   await asRole(role,async()=>{
    assert.equal(await markerCount('concept_dictionary'),0,`${role}: base-table RLS hides marker`);
    assert.equal(await markerCount('v_concept_export_mapping'),0,`${role}: invoker view obeys base-table RLS`);
   });
  }
  await db.exec('ALTER VIEW public.v_concept_export_mapping SET (security_invoker=false)');
  for(const role of ['anon','authenticated']){
   await asRole(role,async()=>{
    assert.equal(await markerCount('concept_dictionary'),0);
    assert.equal(await markerCount('v_concept_export_mapping'),1,`${role}: historical owner execution bypasses the same RLS`);
   });
  }
 }finally{await db.exec('ROLLBACK');await db.exec('RESET ROLE');}
 for(const role of ['anon','authenticated'])await asRole(role,async()=>assert.deepEqual(await contents(),before));
 pass('transactional RLS test proves caller isolation with an owner-execution positive control; all temporary changes rolled back');

 const reference=JSON.parse(fs.readFileSync(path.join(root,'supabase/database-contract-pg17.json'),'utf8'));
 assert.deepEqual(await readContract(db),reference.database_contract_profiles.canonical,
  'Complete reviewed contract, including view security and ACL, remains exact after acceptance');
 pass('complete reviewed catalog contract retained after view and RLS tests');
 console.log(`PG17_VIEW_OK ${groups} groups; synthetic database only.`);
}finally{await db.close();}
