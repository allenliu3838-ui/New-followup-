// Source-only, isolated reference generation. Never accepts a production report.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {root,createDatabase,applyMigrations,readContract,migrationManifestHash} from '../tests/helpers/pg17-fixture.mjs';

const destination=path.join(root,'supabase/database-contract-pg17.json');
const args=process.argv.slice(2);
assert.ok(args.length===1&&['--check','--write'].includes(args[0]),'Use --check or --write (new reviewed source artifact only).');
const profiles={};
const runtimes=new Set();
for(const [name,historicalCrlf] of [['canonical',false],['historical_crlf',true]]){
 const db=await createDatabase();
 try{
  const version=(await db.query("select current_setting('server_version') as version")).rows[0].version;
  runtimes.add(version);
  assert.equal(await applyMigrations(db,{historicalCrlf,phase:'baseline'}),33);
  assert.equal(await applyMigrations(db,{phase:'upgrade'}),6);
  profiles[name]=await readContract(db);
  console.log('PG17_PROFILE_OK '+name+' '+version);
 }finally{await db.close();}
}
assert.equal(runtimes.size,1);
const artifact={
 contract_protocol:'registry-contract-v3-pg17',
 database_server_major:17,
 reference_server_version:[...runtimes][0],
 runtime:'@embedded-postgres/linux-x64@17.6.0-beta.15',
 migration_manifest_sha256:migrationManifestHash,
 database_contract_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'scripts/database_contract.sql'))).digest('hex'),
 profile_definition:'canonical: all reviewed LF SQL; historical_crlf: first 33 reviewed SQL files encoded CRLF, then six new LF migrations. UTC and fixed search_path. Synthetic Auth/Storage only.',
 database_contract_profiles:profiles
};
const serialized=JSON.stringify(artifact,null,2)+'\n';
if(args[0]==='--check'){
 assert.equal(fs.readFileSync(destination,'utf8'),serialized,'PG17 contract differs; review source/runtime before updating reference');
 console.log('PG17_CONTRACT_REPRODUCED');
}else{
 fs.writeFileSync(destination,serialized);
 console.log('PG17_REFERENCE_WRITTEN: review and pin a new manifest before packaging');
}
