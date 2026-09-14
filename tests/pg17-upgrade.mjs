// Isolated PostgreSQL 17 upgrade acceptance. All users and records are synthetic.
// This suite neither connects to a hosted project nor loads production metadata.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase, applyMigrations, readContract} from './helpers/pg17-fixture.mjs';

const db = await createDatabase();
const owner = randomUUID();
const otherOwner = randomUUID();
const project = randomUUID();
const otherProject = randomUUID();
const patientCode = 'SYNTHETIC-001';
const visitId = randomUUID();
const token = Object.fromEntries(['valid', 'expired', 'revoked', 'consumed', 'inactive']
  .map(name => [name, `synthetic-${name}-${randomUUID()}`]));
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const permissionDenied = error => error.code === '42501';

async function asRole(userId, operation) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
  await db.exec(`SET ROLE ${userId ? 'authenticated' : 'anon'}`);
  try { return await operation(); }
  finally {
    await db.exec('RESET ROLE');
    await db.exec('RESET request.jwt.claim.sub');
  }
}

const preservedTables = [
  'patients_baseline', 'visits_long', 'labs_long', 'meds_long', 'variants_long',
  'events_long', 'visit_receipts', 'patient_tokens', 'concept_dictionary',
  'concept_alias_dictionary', 'abbreviation_dictionary'
];

async function captureRows() {
  const result = {};
  for (const table of preservedTables) {
    result[table] = (await db.query(
      `SELECT to_jsonb(t) AS record FROM public.${table} t ORDER BY to_jsonb(t)::text`
    )).rows.map(r => r.record);
  }
  return result;
}

try {
  assert.equal(Math.floor(Number((await row('SHOW server_version_num')).server_version_num) / 10000), 17);
  await applyMigrations(db, {historicalCrlf: false, phase: 'baseline'});
  assert.equal((await row("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'")).schema, 'extensions');

  for (const [id, email] of [[owner, 'pg17-owner@example.invalid'], [otherOwner, 'pg17-other@example.invalid']]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email]);
  }
  for (const [id, user, name] of [[project, owner, 'Synthetic upgrade project'], [otherProject, otherOwner, 'Synthetic separate project']]) {
    await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,$2,'SYNTHETIC','IGAN',$3)", [id, name, user]);
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,CURRENT_DATE-30,'F',1980,88.4,$3)", [id, patientCode, user]);
  }
  await db.query('INSERT INTO public.visits_long(id,project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,notes,created_by) VALUES($1,$2,$3,CURRENT_DATE-10,120,75,88.4,150,\'Synthetic historical visit\',$4)', [visitId, project, patientCode, owner]);
  await db.query("INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,created_by) VALUES($1,$2,CURRENT_DATE-10,'CREAT',88.4,'umol/L',$3)", [project, patientCode, owner]);
  await db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,dose,start_date,created_by) VALUES($1,$2,'Synthetic medication','Synthetic class','Synthetic dose',CURRENT_DATE-15,$3)", [project, patientCode, owner]);
  await db.query("INSERT INTO public.variants_long(project_id,patient_code,test_date,test_name,gene,variant,classification,created_by) VALUES($1,$2,CURRENT_DATE-15,'Synthetic panel','SYNTHETIC','Synthetic variant','VUS',$3)", [project, patientCode, owner]);
  await db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,confirmed,source,notes,created_by) VALUES($1,$2,'custom',CURRENT_DATE-10,false,'manual','Synthetic event',$3)", [project, patientCode, owner]);
  await db.query("INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at) VALUES($1,'synthetic-historical-receipt',now()+interval '1 day')", [visitId]);
  await db.exec("INSERT INTO public.concept_dictionary(code,display_name_cn,short_name_cn) VALUES('SYNTHETIC_CONCEPT','Synthetic concept','Synthetic'); INSERT INTO public.concept_alias_dictionary(concept_code,alias_cn) VALUES('SYNTHETIC_CONCEPT','Synthetic alias');");
  for (const [state, value] of Object.entries(token)) {
    await db.query(`INSERT INTO public.patient_tokens(project_id,patient_code,token,active,expires_at,single_use,used_at,revoked_at,created_by)
      VALUES($1,$2,$3,$4,CASE WHEN $5='expired' THEN now()-interval '1 day' ELSE now()+interval '1 day' END,
        $5='consumed',CASE WHEN $5='consumed' THEN now()-interval '1 hour' END,
        CASE WHEN $5='revoked' THEN now()-interval '1 hour' END,$6)`,
    [project, patientCode, value, state !== 'inactive', state, owner]);
  }

  // Reproduce a known historical gap before testing that the upgrade closes it.
  await asRole(null, async () => {
    assert.equal((await db.query('SELECT * FROM public.patient_list_labs($1,30)', [token.consumed])).rows.length, 1);
    assert.equal((await db.query("SELECT receipt_token FROM public.visit_receipts WHERE receipt_token='synthetic-historical-receipt'")).rows.length, 1);
  });
  const before = await captureRows();
  pass('PostgreSQL 17 historical schema and synthetic records are established');

  await applyMigrations(db, {phase: 'upgrade'});
  const after = await captureRows();
  for (const table of preservedTables) {
    // Added columns may change JSON sort order, so compare by each historical row's key.
    const key = record => table === 'concept_alias_dictionary' ? `${record.concept_code}:${record.alias_cn}`
      : record.id ?? record.visit_id ?? record.code ?? record.abbr;
    const upgraded = new Map(after[table].map(record => [key(record), record]));
    assert.equal(after[table].length, before[table].length, `${table}: historical row count`);
    for (const original of before[table]) {
      const current = upgraded.get(key(original));
      assert.ok(current, `${table}: historical row survives`);
      assert.deepEqual(Object.fromEntries(Object.keys(original).map(k => [k, current[k]])), original,
        `${table}: every pre-existing column value remains unchanged`);
    }
  }
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n), 5);
  pass('incremental 0032–0037 preserves historical clinical, token, receipt and dictionary values');

  const dictionaryInsertStatements = [
    "INSERT INTO public.abbreviation_dictionary(abbr,full_name_cn,category_cn) VALUES('DENIED','Denied','Denied')",
    "INSERT INTO public.concept_dictionary(code,display_name_cn,short_name_cn) VALUES('DENIED','Denied','Denied')",
    "INSERT INTO public.concept_alias_dictionary(concept_code,alias_cn) VALUES('SYNTHETIC_CONCEPT','Denied')"
  ];
  for (const user of [null, owner]) {
    await asRole(user, async () => {
      for (const statement of dictionaryInsertStatements) await assert.rejects(db.query(statement), permissionDenied);
      await assert.rejects(db.query("INSERT INTO public.visit_receipts(visit_id,receipt_token,expires_at) VALUES($1,'denied',now()+interval '1 hour')", [visitId]), permissionDenied);
      await assert.rejects(db.query('SELECT * FROM public.visit_receipts'), permissionDenied);
      for (const table of ['abbreviation_dictionary', 'concept_dictionary', 'concept_alias_dictionary']) {
        assert.ok((await db.query(`SELECT * FROM public.${table}`)).rows.length > 0, `${table}: public dictionary reading retained`);
        await assert.rejects(db.query(`DELETE FROM public.${table}`), permissionDenied);
      }
    });
  }
  pass('anonymous and ordinary users cannot write the four formerly unprotected tables; dictionary reading survives');

  const bucket = await row("SELECT public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='payment-proofs'");
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), 10 * 1024 * 1024);
  assert.ok(bucket.allowed_mime_types.includes('application/pdf'));
  pass('payment proof bucket remains private with the reviewed size and MIME settings');

  await asRole(owner, async () => {
    assert.equal((await db.query('SELECT project_id FROM public.patients_baseline')).rows.length, 1);
    assert.equal((await row('SELECT project_id FROM public.patients_baseline')).project_id, project);
    assert.equal((await db.query('SELECT id FROM public.visits_long WHERE project_id=$1', [project])).rows.length, 1);
  });
  await asRole(otherOwner, async () => {
    assert.equal((await row('SELECT project_id FROM public.patients_baseline')).project_id, otherProject);
    for (const table of ['patients_baseline', 'visits_long', 'labs_long', 'meds_long', 'variants_long', 'events_long']) {
      assert.equal((await db.query(`SELECT id FROM public.${table} WHERE project_id=$1`, [project])).rows.length, 0);
    }
    await assert.rejects(db.query('SELECT public.create_patient_token_v2($1,$2,1,true)', [project, patientCode]), permissionDenied);
  });
  await asRole(null, async () => assert.equal((await db.query('SELECT id FROM public.patients_baseline')).rows.length, 0));
  pass('clinical reads and token issuance remain isolated between two owners with the same patient code');

  const patientFunctions = ['patient_list_labs', 'patient_list_meds', 'patient_list_variants', 'patient_list_events'];
  await asRole(null, async () => {
    for (const fn of patientFunctions) {
      assert.equal((await db.query(`SELECT * FROM public.${fn}($1,30)`, [token.valid])).rows.length, 1, `${fn}: valid token reads own record`);
      for (const badToken of [token.expired, token.revoked, token.consumed, token.inactive, 'synthetic-unknown-token']) {
        await assert.rejects(db.query(`SELECT * FROM public.${fn}($1,30)`, [badToken]),
          error => error.code === '42501' && /token_invalid_or_expired/.test(error.message), `${fn}: invalid bearer denied`);
      }
    }
  });
  pass('all four patient list RPCs reject expired, revoked, consumed, inactive and unknown tokens');

  const newToken = await asRole(owner, async () => (await row('SELECT public.create_patient_token_v2($1,$2,1,true) AS token', [project, patientCode])).token);
  assert.equal(typeof newToken, 'string');
  await asRole(null, async () => assert.equal((await db.query('SELECT * FROM public.patient_list_labs($1,30)', [newToken])).rows.length, 1));
  await asRole(owner, () => db.query("SELECT public.revoke_patient_token($1,'Synthetic upgrade acceptance')", [newToken]));
  await asRole(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_list_labs($1,30)', [newToken]), permissionDenied));
  pass('new token creation and audited revocation execute on the PostgreSQL 17 extension layout');

  const contract = await readContract(db);
  assert.ok(contract.functions.length > 72);
  assert.ok(contract.columns.length > 399);
  assert.equal(contract.buckets.find(b => b.id === 'payment-proofs').public, false);
  pass('upgraded database exposes a complete catalog contract');
  console.log(`PG17_UPGRADE_OK ${groups} groups; synthetic local database only.`);
} finally {
  await db.close();
}
