// Native PG17 acceptance for 0040 (batch import of labs, medications and endpoint events,
// file details, import history and per-batch undo). The database is first built to 0039 and
// filled the way production looks today (a few legacy lab, medication and event rows and a
// pre-0040 visit import); 0040 is then applied as the reviewed increment. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

assert.equal(process.argv.length, 2, 'Synthetic batch import acceptance accepts no external input');
const NEW_MIGRATION = '0040_batch_import.sql';
const db = await createDatabase();
// The registry's "today" is the Beijing date; this session uses the same zone for fixtures.
await db.exec("SET timezone='Asia/Shanghai'");
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => Number((await row(sql, args)).n);
const denied = error => error.code === '42501';
// Exact error text (string) or pattern; prints the actual message when it does not match.
const is = expected => error => {
  const ok = typeof expected === 'string' ? error.message === expected : expected.test(error.message);
  if (!ok) console.error(`expected ${expected}, got ${error.message}`);
  return ok;
};

async function as(user, operation) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  await db.exec(`SET ROLE ${user ? 'authenticated' : 'anon'}`);
  try { return await operation(); }
  finally { await db.exec('RESET ROLE; RESET request.jwt.claim.sub;'); }
}

function reviewedSql(file) {
  const entry = migrations.find(m => m.file === file);
  assert.ok(entry, `${file} is listed in the reviewed migration manifest`);
  const bytes = fs.readFileSync(path.join(root, 'supabase/migrations', file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, file);
  return bytes.toString('utf8');
}
async function apply(file) {
  try { await db.exec(reviewedSql(file)); } catch (e) { throw new Error(`${file}: ${e.message}`, {cause: e}); }
}

const [owner, editor, analyst, viewer, outsider] = Array.from({length: 5}, () => randomUUID());
const email = {[owner]: 'batch-owner@example.invalid', [editor]: 'batch-editor@example.invalid',
  [analyst]: 'batch-analyst@example.invalid', [viewer]: 'batch-viewer@example.invalid', [outsider]: 'batch-outsider@example.invalid'};
const project = randomUUID(), otherProject = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const importRows = (user, kind, list, batch = randomUUID(), pid = project) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const undo = (user, batch, reason, pid = project) => as(user, async () =>
  (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [pid, batch, reason])).r);
const registerFile = (user, batch, sha, name, index = 1, total = 1, pid = project) => as(user, () =>
  db.query('SELECT public.register_import_file($1,$2,$3,$4,$5,$6)', [pid, batch, sha, name, index, total]));
const listBatches = (user, limit = 100, pid = project) => as(user, async () =>
  rows('SELECT * FROM public.list_import_batches($1,$2)', [pid, limit]));
const labCount = () => count('SELECT count(*) AS n FROM public.labs_long WHERE project_id=$1', [project]);
const medCount = () => count('SELECT count(*) AS n FROM public.meds_long WHERE project_id=$1', [project]);
const eventCount = () => count('SELECT count(*) AS n FROM public.events_long WHERE project_id=$1', [project]);
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

try {
  // ---- Production-like database at 0039 ------------------------------------------------
  const upTo39 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 39);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 39), [NEW_MIGRATION],
    'exactly one reviewed increment follows 0039');
  for (const file of upTo39) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 8);
  for (const id of [owner, editor, analyst, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic batch import project','SYN','IGAN',$2)", [project, owner]);
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic separate project','OTH','IGAN',$2)", [otherProject, outsider]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r',
      [project, email[user], role])).r.status, 'added'));
  }
  for (const code of ['P-001', 'P-002', 'P-003', 'P-004', 'P-005']) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,CURRENT_DATE-400,'F',1980,88.4,$3)", [project, code, owner]);
  }
  await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,'P-OTHER',CURRENT_DATE-400,'M',1975,90,$2)", [otherProject, outsider]);
  // Legacy rows as production holds them: an unmapped lab, free-text medication, a manual event.
  await db.query("INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_name,lab_value,lab_unit,created_by) VALUES($1,'P-001',CURRENT_DATE-200,'CREAT',88.4,'umol/L',$2)", [project, owner]);
  await db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,dose,start_date,created_by) VALUES($1,'P-001','Synthetic medication','Synthetic class','Synthetic dose',CURRENT_DATE-150,$2)", [project, owner]);
  await db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,confirmed,source,notes,created_by) VALUES($1,'P-001','custom',CURRENT_DATE-100,false,'manual','Synthetic event',$2)", [project, owner]);
  // A visit import made before 0040: it cannot be undone (it did not record what it wrote).
  const legacyVisitBatch = randomUUID();
  assert.equal((await importRows(editor, 'visits', [{patient_code: 'P-005', visit_date: await day(-60), sbp: 120, dbp: 80}], legacyVisitBatch)).inserted, 1);
  const legacyTables = ['labs_long', 'meds_long', 'events_long', 'patients_baseline', 'visits_long', 'registry_import_batches', 'registry_import_records'];
  const snapshot = async () => {
    const out = {};
    for (const t of legacyTables) out[t] = (await rows(`SELECT to_jsonb(t) AS r FROM public.${t} t ORDER BY to_jsonb(t)::text`)).map(r => r.r);
    return out;
  };
  const before = await snapshot();
  pass('0039 database holds production-like legacy lab, medication and event rows and a pre-0040 visit import');

  // ---- The increment refuses to run where a person must review first --------------------
  const badMed = (await row("INSERT INTO public.meds_long(project_id,patient_code,drug_name,start_date,end_date,created_by) VALUES($1,'P-002','Synthetic bad dates',CURRENT_DATE-10,CURRENT_DATE-20,$2) RETURNING id", [project, owner])).id;
  await assert.rejects(apply(NEW_MIGRATION), /有 1 条用药记录的停药日期早于开始日期.*需人工核对后再迁移/);
  await db.exec('ROLLBACK');
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 8);
  assert.equal(await count("SELECT count(*) AS n FROM information_schema.columns WHERE table_name='labs_long' AND column_name='result_text'"), 0);
  await db.query('DELETE FROM public.meds_long WHERE id=$1', [badMed]);
  pass('0040 stops before any change when a stored medication ends before it starts');

  // ---- Upgrade and re-run -----------------------------------------------------------------
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 9);
  const after = await snapshot();
  const added = {
    labs_long: {result_text: null, ref_range: null, abnormal_flag: null, notes: null},
    meds_long: {dose_value: null, dose_unit: null, indication: null, notes: null},
    events_long: {evidence_source: null, event_detail: null},
    registry_import_batches: {file_sha256: null, file_name: null, chunk_index: null, chunk_total: null,
      undo_tracked: false, undone_at: null, undone_by: null, undo_reason: null, undo_result: null},
    registry_import_records: {batch_id: null, action: null, record_sha256: null}
  };
  for (const t of legacyTables) {
    assert.equal(after[t].length, before[t].length, `${t}: row count unchanged`);
    const byId = new Map(after[t].map(r => [JSON.stringify([r.id ?? r.batch_id ?? r.content_sha256]), r]));
    for (const old of before[t]) {
      const now = byId.get(JSON.stringify([old.id ?? old.batch_id ?? old.content_sha256]));
      assert.deepEqual(now, {...old, ...(added[t] || {})}, `${t}: every existing value unchanged, new columns empty`);
    }
  }
  await apply(NEW_MIGRATION);
  assert.deepEqual(await snapshot(), after, 're-running 0040 changes nothing');
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 9);
  pass('0040 keeps every existing value (new columns empty, no data rewritten) and re-runs without effect');

  // ---- Re-run by a non-superuser migrating role next to a table it neither owns nor may use --------
  // Production migrations run as a role that owns the registry tables but not, for example,
  // supabase_admin's or an extension's tables in public; 0040 must leave those alone.
  await db.exec(`CREATE ROLE registry_other_owner NOLOGIN; CREATE ROLE registry_migrator NOLOGIN NOSUPERUSER;
    GRANT postgres TO registry_migrator;
    CREATE TABLE public.registry_foreign_owned(id int);
    ALTER TABLE public.registry_foreign_owned OWNER TO registry_other_owner;
    REVOKE ALL ON public.registry_foreign_owned FROM PUBLIC,anon,authenticated,service_role,postgres;
    GRANT TRUNCATE ON public.registry_foreign_owned TO anon;`);
  assert.equal((await row("SELECT has_table_privilege('registry_migrator','public.registry_foreign_owned','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS p")).p, false);
  await db.exec('SET ROLE registry_migrator');
  try { await apply(NEW_MIGRATION); }
  finally { await db.exec('ROLLBACK; RESET ROLE'); }
  assert.deepEqual(await snapshot(), after, 're-running 0040 as a non-superuser changes nothing');
  assert.equal((await row("SELECT has_table_privilege('anon','public.registry_foreign_owned','TRUNCATE') AS p")).p, true,
    'a table of another owner is left to that owner');
  await db.exec(`DROP TABLE public.registry_foreign_owned; DROP ROLE registry_other_owner;
    REVOKE postgres FROM registry_migrator; DROP ROLE registry_migrator;`);
  pass('0040 re-runs as a non-superuser migrating role and skips public tables it does not own instead of aborting');

  // ---- Grants -----------------------------------------------------------------------------
  const fns = ['public.import_registry_rows(uuid,text,jsonb,uuid)', 'public.register_import_file(uuid,uuid,text,text,integer,integer)',
    'public.list_import_batches(uuid,integer)', 'public.undo_import_batch(uuid,uuid,text)', 'public.correct_registry_record(uuid,text,uuid,jsonb,text)'];
  for (const fn of fns) {
    assert.deepEqual(await row(`SELECT p.prosecdef,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn]),
    {prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], auth: true, anon: false}, fn);
  }
  for (const fn of ['registry_private.validate_clinical_input(text,jsonb)', 'registry_private.check_clinical_row(text,jsonb)',
    'registry_private.import_record_digest(text,uuid)', 'registry_private.import_clinical_row(uuid,text,jsonb,integer,uuid)',
    'public._registry_input_columns(text)', 'public._registry_validate_input(text,jsonb)']) {
    assert.deepEqual(await row(`SELECT has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn]), {auth: false, anon: false}, fn);
  }
  for (const user of [null, owner]) {
    await as(user, async () => {
      assert.ok((await rows('SELECT code,name_cn,name_en,standard_unit,module,is_core FROM public.lab_test_catalog')).length > 30);
      assert.ok((await rows('SELECT lab_test_code,unit_symbol,multiplier,offset_val FROM public.lab_test_unit_map')).length > 40);
      await assert.rejects(db.query("INSERT INTO public.lab_test_unit_map(lab_test_code,unit_symbol,multiplier,offset_val,is_standard) VALUES('CREAT','g/L',1,0,false)"), denied);
      await assert.rejects(db.query("UPDATE public.lab_test_unit_map SET multiplier=2 WHERE lab_test_code='CREAT'"), denied);
      await assert.rejects(db.query("DELETE FROM public.lab_test_catalog WHERE code='CREAT'"), denied);
      await assert.rejects(db.query('TRUNCATE public.lab_test_unit_map'), denied);
    });
  }
  for (const user of [null, owner]) {
    await as(user, async () => {
      for (const t of ['labs_long', 'meds_long', 'events_long', 'patients_baseline', 'visits_long', 'audit_log']) {
        await assert.rejects(db.query(`TRUNCATE public.${t}`), denied);
      }
    });
  }
  assert.equal((await rows(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (has_table_privilege('authenticated',c.oid,'TRUNCATE,TRIGGER,REFERENCES')
      OR has_table_privilege('anon',c.oid,'TRUNCATE,TRIGGER,REFERENCES'))`)).length, 0);
  for (const user of [null, viewer]) {
    await as(user, async () => {
      for (const t of ['registry_import_batches', 'registry_import_records']) await assert.rejects(db.query(`SELECT * FROM public.${t}`), denied);
    });
  }
  pass('new RPCs run with a fixed search path for signed-in users only; helpers are private; lab dictionaries are read-only (TRUNCATE too); no client role can TRUNCATE any public table; batch tables are not directly readable');

  const patientsBefore = await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b ORDER BY id');

  // ---- Labs: conversion, qualitative results, dedup -----------------------------------------
  const labDate = await day(-30);
  const labRows = [
    {patient_code: 'P-001', lab_date: labDate, lab_test_code: 'CREAT', value_raw: 88.4, unit_symbol: 'μmol/L', ref_range: '44-133', abnormal_flag: 'N'},
    {patient_code: 'P-001', lab_date: labDate, lab_test_code: 'UPCR', value_raw: '500', unit_symbol: 'mg/g', abnormal_flag: 'H', notes: '晨尿'},
    {patient_code: 'P-002', lab_date: labDate, lab_test_code: 'DSDNA', result_text: '阴性', lab_item_ignored: undefined},
    {patient_code: 'P-002', lab_date: labDate, lab_test_code: 'HGB', value_raw: ' 120 ', unit_symbol: 'g/L', result_text: '', notes: ''}
  ].map(r => JSON.parse(JSON.stringify(r)));
  const labBatch = randomUUID();
  assert.deepEqual(await importRows(editor, 'labs', labRows, labBatch), {inserted: 4, updated: 0, skipped: 0, total: 4, replayed: false});
  const labs = Object.fromEntries((await rows(`SELECT lab_test_code,value_raw::float8 AS raw,value_standard::float8 AS std,standard_unit,
    normalization_status,result_text,ref_range,abnormal_flag,notes,lab_name,lab_value::float8 AS lab_value,lab_unit,created_by
    FROM public.labs_long WHERE project_id=$1 AND lab_date=$2`, [project, labDate])).map(r => [r.lab_test_code, r]));
  assert.ok(Math.abs(labs.CREAT.std - 1) < 1e-9, 'creatinine 88.4 μmol/L = 1 mg/dL');
  assert.equal(labs.CREAT.standard_unit, 'mg/dL');
  assert.equal(labs.CREAT.normalization_status, 'normalized');
  assert.deepEqual([labs.CREAT.ref_range, labs.CREAT.abnormal_flag, labs.CREAT.lab_name, labs.CREAT.lab_value, labs.CREAT.lab_unit], ['44-133', 'N', 'CREAT', 88.4, 'μmol/L']);
  assert.ok(Math.abs(labs.UPCR.std - 0.5) < 1e-12, 'UPCR 500 mg/g = 0.5 g/g');
  assert.deepEqual([labs.UPCR.standard_unit, labs.UPCR.abnormal_flag, labs.UPCR.notes], ['g/g', 'H', '晨尿']);
  assert.deepEqual([labs.DSDNA.raw, labs.DSDNA.std, labs.DSDNA.standard_unit, labs.DSDNA.normalization_status, labs.DSDNA.result_text, labs.DSDNA.lab_unit],
    [null, null, null, 'qualitative', '阴性', null]);
  assert.ok(Math.abs(labs.HGB.std - 12) < 1e-9, 'haemoglobin 120 g/L = 12 g/dL');
  assert.equal(labs.HGB.result_text, null, 'an empty cell is an absent value');
  assert.equal(labs.HGB.created_by, editor);
  assert.deepEqual(await importRows(editor, 'labs', labRows, labBatch), {inserted: 4, updated: 0, skipped: 0, total: 4, replayed: true}, 'same batch id replays');
  await as(editor, () => assert.rejects(db.query('SELECT public.import_registry_rows($1,$2,$3,$4)', [project, 'labs', JSON.stringify(labRows.slice(1)), labBatch]), is('batch_id_content_conflict')));
  const labSkipBatch = randomUUID();
  assert.deepEqual(await importRows(owner, 'labs', labRows, labSkipBatch), {inserted: 0, updated: 0, skipped: 4, total: 4, replayed: false}, 'same file again: all skipped');
  const nLabs = await labCount();
  await assert.rejects(importRows(editor, 'labs', [{...labRows[0], value_raw: 90}]), is('row_1_same_key_record_conflict'));
  await assert.rejects(importRows(editor, 'labs', [
    {patient_code: 'P-003', lab_date: labDate, lab_test_code: 'K', value_raw: 4.1, unit_symbol: 'mmol/L'},
    {...labRows[2], result_text: '+'}
  ]), error => is('row_2_same_key_record_conflict')(error) && /同一患者同一业务键已有不同数据/.test(error.hint));
  await assert.rejects(importRows(editor, 'labs', [
    {patient_code: 'P-003', lab_date: labDate, lab_test_code: 'K', value_raw: 4.1, unit_symbol: 'mmol/L'},
    {patient_code: 'P-003', lab_date: labDate, lab_test_code: 'K', value_raw: 4.2, unit_symbol: 'mmol/L'}
  ]), is('row_2_same_key_record_conflict'), 'the same key twice in one file with different values');
  assert.equal(await labCount(), nLabs, 'a refused batch writes nothing');
  // An identical row that already existed before any import is skipped and linked, not duplicated.
  const day40 = await day(-40);
  await as(editor, () => db.query("INSERT INTO public.labs_long(project_id,patient_code,lab_date,lab_test_code,value_raw,unit_symbol) VALUES($1,'P-003',$2,'NA',140,'mmol/L')", [project, day40]));
  const preexisting = await importRows(editor, 'labs', [{patient_code: 'P-003', lab_date: await day(-40), lab_test_code: 'NA', value_raw: '140.0', unit_symbol: 'mmol/L'}]);
  assert.deepEqual([preexisting.inserted, preexisting.skipped], [0, 1]);
  pass('labs: units converted to the standard unit, qualitative results stored without a standard value, replay, identical rows skipped, same-key conflicts refuse the whole batch');

  // ---- Labs: refusals, named by row and column ------------------------------------------------
  const okLab = {patient_code: 'P-004', lab_date: labDate, lab_test_code: 'K', value_raw: 4, unit_symbol: 'mmol/L'};
  const labCases = [
    [{...okLab, lab_date: undefined}, 'row_1_lab_date_required'],
    [{...okLab, lab_test_code: ''}, 'row_1_lab_test_code_required'],
    [{...okLab, value_raw: null, unit_symbol: null}, 'row_1_lab_value_or_result_required'],
    [{...okLab, unit_symbol: ''}, 'row_1_unit_symbol_required'],
    [{...okLab, value_raw: null, result_text: '+'}, 'row_1_unit_requires_value'],
    [{...okLab, unit_symbol: 'g/L'}, 'row_1_unit_not_allowed: unit_symbol'],
    [{...okLab, lab_test_code: 'NOT_A_TEST'}, 'row_1_unknown_lab_test_code'],
    [{...okLab, value_raw: 'abc'}, 'row_1_invalid_number: value_raw'],
    [{...okLab, value_raw: '4 mmol/L'}, 'row_1_invalid_number: value_raw'],
    [{...okLab, value_raw: true}, 'row_1_invalid_number: value_raw'],
    [{...okLab, lab_date: await day(1)}, 'row_1_invalid_or_future_date: lab_date'],
    [{...okLab, lab_date: '2025-02-30'}, 'row_1_invalid_iso_date: lab_date'],
    [{...okLab, lab_date: '2025/01/03'}, 'row_1_invalid_iso_date: lab_date'],
    [{...okLab, lab_date: '1899-12-31'}, 'row_1_date_before_1900: lab_date'],
    [{...okLab, abnormal_flag: 'X'}, 'row_1_invalid_abnormal_flag'],
    [{...okLab, name: ''}, 'row_1_unsupported_column: name'],
    [{...okLab, patient_code: 'P-404'}, 'row_1_patient_not_registered'],
    [{...okLab, patient_code: 'P-OTHER'}, 'row_1_patient_not_registered'],
    [{...okLab, patient_code: ' P-004'}, 'row_1_invalid_patient_code'],
    [{...okLab, patient_code: ''}, 'row_1_patient_code_required'],
    [{...okLab, notes: '联系电话13812345678'}, 'row_1_pii_detected_blocked: notes'],
    [{...okLab, value_raw: null, unit_symbol: null, result_text: '姓名张三'}, 'row_1_pii_detected_blocked: result_text'],
    [{...okLab, value_raw: null, unit_symbol: null, result_text: 'x'.repeat(51)}, 'row_1_text_too_long: result_text'],
    [{...okLab, notes: 'x'.repeat(501)}, 'row_1_notes_too_long'],
    [{...okLab, ref_range: 3.5}, 'row_1_text_value_required: ref_range'],
    [{...okLab, project_id: otherProject}, 'row_1_project_mismatch']
  ];
  for (const [bad, expected] of labCases) {
    await assert.rejects(importRows(editor, 'labs', [JSON.parse(JSON.stringify(bad))]), is(expected), expected);
  }
  await assert.rejects(importRows(editor, 'labs', [okLab, {...okLab, lab_test_code: 'NA', value_raw: 'n/a'}]), is('row_2_invalid_number: value_raw'));
  await assert.rejects(importRows(editor, 'labs', [okLab, {...okLab, unit_symbol: 'g/L'}]),
    error => is('row_2_unit_not_allowed: unit_symbol')(error) && error.hint.includes('mmol/L'), 'the hint lists the allowed units');
  await assert.rejects(importRows(editor, 'labs', [{...okLab, lab_date: '2025-02-30'}]), error => error.hint.includes('本批次未写入'));
  assert.equal(await labCount(), nLabs + 1, 'nothing written by any refused batch');
  await assert.rejects(importRows(editor, 'labs', []), is('import_requires_1_to_500_rows'));
  await assert.rejects(importRows(editor, 'labs', {patient_code: 'P-004'}), is('import_requires_1_to_500_rows'));
  await assert.rejects(importRows(editor, 'labs', ['P-004']), is('row_1_must_be_object'));
  await assert.rejects(importRows(editor, 'pathology', [okLab]), is('invalid_import_request'));
  pass('labs: required columns, test code, unit, number, date, flag, unknown column, patient, identifying text and length refusals name the row and column');

  // ---- 500-row limit --------------------------------------------------------------------------
  const many = async (n, offset = 0) => {
    const list = [];
    for (let i = 1; i <= n; i++) list.push({patient_code: 'P-003', lab_date: await day(-600 - i - offset), lab_test_code: 'CA', value_raw: 2.3, unit_symbol: 'mmol/L'});
    return list;
  };
  await assert.rejects(importRows(editor, 'labs', await many(501)), is('import_requires_1_to_500_rows'));
  const bigBatch = randomUUID();
  assert.equal((await importRows(editor, 'labs', await many(500), bigBatch)).inserted, 500);
  pass('a batch holds 1 to 500 rows; 500 rows are written in one call');

  // ---- Medications -------------------------------------------------------------------------------
  const medRows = [
    {patient_code: 'P-002', drug_name: '氯沙坦', drug_class: 'RAS阻断剂', dose_value: 50, dose_unit: 'mg', route: 'PO', frequency: 'qd',
      start_date: await day(-90), end_date: await day(-10), indication: '降低蛋白尿', notes: '耐受良好'},
    {patient_code: 'P-002', drug_name: '达格列净', drug_class: 'SGLT2抑制剂', dose_value: '10', start_date: await day(-60)},
    {patient_code: 'P-003', drug_name: '泼尼松', drug_class: '糖皮质激素', dose_value: 0.5, dose_unit: 'mg/kg', route: 'PO', start_date: await day(-30)}
  ];
  const medBatch = randomUUID();
  assert.deepEqual(await importRows(editor, 'meds', medRows, medBatch), {inserted: 3, updated: 0, skipped: 0, total: 3, replayed: false});
  const meds = Object.fromEntries((await rows(`SELECT drug_name,drug_class,dose,dose_value::float8 AS dose_value,dose_unit,route,frequency,
    start_date::text,end_date::text,indication,notes FROM public.meds_long WHERE project_id=$1 AND drug_name IN ('氯沙坦','达格列净','泼尼松')`, [project])).map(r => [r.drug_name, r]));
  assert.deepEqual(meds['氯沙坦'], {drug_name: '氯沙坦', drug_class: 'RAS阻断剂', dose: '50 mg', dose_value: 50, dose_unit: 'mg', route: 'PO',
    frequency: 'qd', start_date: await day(-90), end_date: await day(-10), indication: '降低蛋白尿', notes: '耐受良好'});
  assert.equal(meds['达格列净'].dose, null, 'the legacy dose text is filled only when value and unit are both given');
  assert.equal(meds['泼尼松'].dose, '0.5 mg/kg');
  const medSkipBatch = randomUUID();
  assert.equal((await importRows(owner, 'meds', medRows, medSkipBatch)).skipped, 3, 'same file again: all skipped');
  await assert.rejects(importRows(editor, 'meds', [{...medRows[1], dose_value: 25}]), is('row_1_same_key_record_conflict'));
  const okMed = {patient_code: 'P-004', drug_name: '呋塞米', drug_class: '利尿剂', start_date: await day(-5)};
  const medCases = [
    [{...okMed, drug_name: ' '}, 'row_1_drug_name_required'],
    [{...okMed, start_date: null}, 'row_1_start_date_required'],
    [{...okMed, drug_class: 'ACEI'}, 'row_1_invalid_drug_class'],
    [{...okMed, route: 'oral'}, 'row_1_invalid_route'],
    [{...okMed, end_date: await day(-6)}, 'row_1_end_date_before_start_date'],
    [{...okMed, start_date: await day(2)}, 'row_1_invalid_or_future_date: start_date'],
    [{...okMed, end_date: await day(1)}, 'row_1_invalid_or_future_date: end_date'],
    [{...okMed, dose_value: 0}, 'row_1_value_must_be_positive: dose_value'],
    [{...okMed, dose_value: -5}, 'row_1_value_must_be_positive: dose_value'],
    [{...okMed, dose_value: '1e7'}, 'row_1_number_out_of_range: dose_value'],
    [{...okMed, frequency: 'x'.repeat(21)}, 'row_1_text_too_long: frequency'],
    [{...okMed, indication: 'x'.repeat(101)}, 'row_1_text_too_long: indication'],
    [{...okMed, indication: '病案号 12345678'}, 'row_1_pii_detected_blocked: indication'],
    [{...okMed, dose: '20mg'}, 'row_1_unsupported_column: dose'],
    [{...okMed, patient_code: 'P-404'}, 'row_1_patient_not_registered']
  ];
  const nMeds = await medCount();
  for (const [bad, expected] of medCases) {
    await assert.rejects(importRows(editor, 'meds', [JSON.parse(JSON.stringify(bad))]), is(expected), expected);
  }
  assert.equal(await medCount(), nMeds);
  await as(editor, () => assert.rejects(db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,start_date,end_date) VALUES($1,'P-004','Direct',CURRENT_DATE-1,CURRENT_DATE-2)", [project]),
    error => error.code === '23514' && /meds_long_end_not_before_start/.test(error.message)));
  pass('medications: dose value and unit (legacy dose text kept in step), class and route lists, date order, duplicates and refusals');

  // ---- Endpoint events ----------------------------------------------------------------------------
  const eventRows = [
    {patient_code: 'P-003', event_type: 'esrd', event_date: await day(-20), evidence_source: 'medical_record'},
    {patient_code: 'P-003', event_type: 'dialysis_start', event_date: await day(-19), evidence_source: 'medical_record', event_detail: '血液透析'},
    {patient_code: 'P-004', event_type: 'kidney_transplant', event_date: await day(-15), evidence_source: 'phone_followup'},
    {patient_code: 'P-004', event_type: 'relapse', event_date: await day(-14), evidence_source: 'lab_review', notes: '蛋白尿复现'},
    {patient_code: 'P-005', event_type: 'custom', event_date: await day(-13), evidence_source: 'other', event_detail: '因感染住院'},
    {patient_code: 'P-005', event_type: 'death', event_date: await day(-2), evidence_source: 'death_certificate'}
  ];
  const eventBatch = randomUUID();
  assert.deepEqual(await importRows(editor, 'events', eventRows, eventBatch), {inserted: 6, updated: 0, skipped: 0, total: 6, replayed: false});
  const events = await rows(`SELECT event_type,source,confirmed,evidence_source,event_detail FROM public.events_long
    WHERE project_id=$1 AND event_date >= $2 ORDER BY event_date`, [project, await day(-20)]);
  assert.deepEqual(events.map(e => e.event_type), eventRows.map(r => r.event_type), 'every imported event stored');
  assert.deepEqual(events.map(e => e.evidence_source), eventRows.map(r => r.evidence_source));
  assert.ok(events.every(e => e.source === 'manual' && e.confirmed === true), 'imported events are manual and confirmed');
  const eventSkipBatch = randomUUID();
  assert.equal((await importRows(owner, 'events', eventRows, eventSkipBatch)).skipped, 6, 'same file again: all skipped');
  await assert.rejects(importRows(editor, 'events', [{...eventRows[0], evidence_source: 'lab_review'}]), is('row_1_same_key_record_conflict'));
  const okEvent = {patient_code: 'P-004', event_type: 'relapse', event_date: await day(-1), evidence_source: 'medical_record'};
  const eventCases = [
    [{...okEvent, event_type: 'egfr_decline_40pct'}, 'row_1_derived_endpoint_not_importable'],
    [{...okEvent, event_type: 'egfr_decline_57pct'}, 'row_1_derived_endpoint_not_importable'],
    [{...okEvent, event_type: 'complete_remission'}, 'row_1_derived_endpoint_not_importable'],
    [{...okEvent, event_type: 'partial_remission'}, 'row_1_derived_endpoint_not_importable'],
    [{...okEvent, event_type: 'stroke'}, 'row_1_invalid_event_type'],
    [{...okEvent, event_type: ''}, 'row_1_event_type_required'],
    [{...okEvent, event_date: null}, 'row_1_event_date_required'],
    [{...okEvent, event_date: await day(1)}, 'row_1_invalid_or_future_date: event_date'],
    [{...okEvent, evidence_source: undefined}, 'row_1_evidence_source_required'],
    [{...okEvent, evidence_source: 'hearsay'}, 'row_1_invalid_evidence_source'],
    [{...okEvent, event_type: 'custom'}, 'row_1_event_detail_required'],
    [{...okEvent, event_detail: '患者姓名李四'}, 'row_1_pii_detected_blocked: event_detail'],
    [{...okEvent, source: 'computed'}, 'row_1_unsupported_column: source'],
    [{...okEvent, confirmed: false}, 'row_1_unsupported_column: confirmed']
  ];
  const nEvents = await eventCount();
  for (const [bad, expected] of eventCases) {
    await assert.rejects(importRows(editor, 'events', [JSON.parse(JSON.stringify(bad))]), is(expected), expected);
  }
  await assert.rejects(importRows(editor, 'events', [okEvent, {...okEvent, event_type: 'complete_remission'}]),
    error => is('row_2_derived_endpoint_not_importable')(error) && /分析脚本按研究方案判定/.test(error.hint));
  assert.equal(await eventCount(), nEvents, 'derived endpoints refuse the whole batch');
  pass('events: dialysis, transplant, relapse, ESRD, death and custom events import as confirmed manual events; eGFR decline and remission are refused for the whole batch');

  // ---- Study status never changes through an import ------------------------------------------------
  assert.deepEqual(await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b ORDER BY id'), patientsBefore,
    'patients_baseline unchanged, including the participant with an imported death event');
  assert.equal((await row("SELECT followup_status FROM public.patients_baseline WHERE project_id=$1 AND patient_code='P-005'", [project])).followup_status, 'active');
  pass('importing labs, medications and events (death and ESRD included) leaves every baseline row and study status unchanged');

  // ---- Permissions and the account write guard ---------------------------------------------------------
  const probe = [{patient_code: 'P-004', lab_date: await day(-3), lab_test_code: 'K', value_raw: 4.5, unit_symbol: 'mmol/L'}];
  for (const user of [analyst, viewer, outsider]) {
    for (const kind of ['labs', 'meds', 'events']) {
      await assert.rejects(importRows(user, kind, kind === 'labs' ? probe : kind === 'meds' ? [okMed] : [okEvent]), denied, `${kind} import refused`);
    }
  }
  await assert.rejects(importRows(null, 'labs', probe), denied, 'anonymous callers cannot import');
  await assert.rejects(importRows(outsider, 'labs', [{...probe[0], patient_code: 'P-OTHER'}], randomUUID(), project), denied);
  assert.equal((await importRows(outsider, 'labs', [{...probe[0], patient_code: 'P-OTHER'}], randomUUID(), otherProject)).inserted, 1, 'each owner imports into their own project');
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  for (const user of [owner, editor]) {
    await assert.rejects(importRows(user, 'labs', probe), is('subscription_required'), 'read-only after the trial');
    await assert.rejects(importRows(user, 'events', [okEvent]), is('subscription_required'));
  }
  await assert.rejects(undo(editor, medBatch, '核对后撤销'), is('subscription_required'));
  assert.ok((await listBatches(viewer)).length > 0, 'history stays readable');
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()+interval '30 days' WHERE user_id=$1", [owner]);
  assert.equal((await importRows(editor, 'labs', probe)).inserted, 1, 'writable again once the account may write');
  pass('owner and editor import; analyst, viewer, another project owner and anonymous callers cannot; an expired trial refuses imports and undo but keeps the history readable');

  // ---- File details --------------------------------------------------------------------------------------
  const fileSha = sha('synthetic labs file');
  await registerFile(editor, labBatch, fileSha, 'C:\\Users\\synthetic\\Desktop\\labs_2026.csv', 1, 2);
  await registerFile(editor, labBatch, fileSha, 'labs_2026.csv', 1, 2);
  await assert.rejects(registerFile(editor, labBatch, fileSha, 'labs_2026.csv', 2, 2), is('import_file_already_registered'));
  await assert.rejects(registerFile(editor, medBatch, fileSha.toUpperCase(), 'meds.csv'), is('invalid_file_sha256'));
  await assert.rejects(registerFile(editor, medBatch, fileSha.slice(1), 'meds.csv'), is('invalid_file_sha256'));
  await assert.rejects(registerFile(editor, medBatch, null, 'meds.csv'), is('invalid_file_sha256'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, '张三_13812345678.csv'), is('file_name_contains_pii'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, '/tmp/患者姓名张三.csv'), is('file_name_contains_pii'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, '/tmp/dir/'), is('invalid_file_name'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, 'x'.repeat(201)), is('invalid_file_name'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, 'meds.csv', 0, 1), is('invalid_chunk_info'));
  await assert.rejects(registerFile(editor, medBatch, fileSha, 'meds.csv', 3, 2), is('invalid_chunk_info'));
  await assert.rejects(registerFile(owner, medBatch, fileSha, 'meds.csv'), is('import_batch_not_yours'), 'only the importer records file details');
  await assert.rejects(registerFile(editor, randomUUID(), fileSha, 'meds.csv'), is('import_batch_not_found'));
  for (const user of [analyst, viewer, outsider, null]) {
    await assert.rejects(registerFile(user, medBatch, fileSha, 'meds.csv'), denied);
  }
  await registerFile(editor, medBatch, sha('synthetic meds file'), 'meds_2026.csv');
  const stored = await row('SELECT file_sha256,file_name,chunk_index,chunk_total FROM public.registry_import_batches WHERE batch_id=$1', [labBatch]);
  assert.deepEqual(stored, {file_sha256: fileSha, file_name: 'labs_2026.csv', chunk_index: 1, chunk_total: 2}, 'path removed; nothing else stored');
  pass('file details: SHA-256 format, path stripped, identifying file names refused, chunk position checked, only the importer of the batch, idempotent');

  // ---- Import history ------------------------------------------------------------------------------------
  for (const user of [owner, editor, analyst, viewer]) {
    const list = await listBatches(user);
    assert.ok(list.length >= 10);
    assert.deepEqual(list.map(b => b.created_at.getTime()), [...list.map(b => b.created_at.getTime())].sort((a, b) => b - a), 'newest first');
    const lab = list.find(b => b.batch_id === labBatch);
    assert.deepEqual({...lab, created_at: undefined}, {batch_id: labBatch, kind: 'labs', created_at: undefined, created_by_email: email[editor],
      inserted: 4, updated: 0, skipped: 0, total: 4, file_sha256: fileSha, file_name: 'labs_2026.csv', chunk_index: 1, chunk_total: 2,
      undo_supported: true, undone_at: null, undo_reason: null, undo_result: null});
    const legacy = list.find(b => b.batch_id === legacyVisitBatch);
    assert.deepEqual([legacy.kind, legacy.undo_supported, legacy.file_name], ['visits', false, null]);
    assert.ok(!list.some(b => b.created_by_email === email[outsider]), 'another project’s batches never appear');
  }
  assert.equal((await listBatches(viewer, 1)).length, 1);
  assert.equal((await listBatches(viewer, 0)).length, 1, 'the limit is at least 1');
  for (const user of [outsider, null]) await assert.rejects(listBatches(user), denied);
  pass('import history: every project member sees batches newest first with the importer’s e-mail, counts, file details and undo state; others cannot');

  // ---- Undo ----------------------------------------------------------------------------------------------
  // One lab of the batch is corrected after the import; it must be kept.
  const creat = (await row("SELECT id FROM public.labs_long WHERE project_id=$1 AND lab_date=$2 AND lab_test_code='CREAT'", [project, labDate])).id;
  await as(owner, () => db.query("SELECT public.correct_registry_record($1,'labs_long',$2,$3,'按原始化验单更正')", [project, creat, JSON.stringify({value_raw: 90})]));
  const qualitative = (await row("SELECT id FROM public.labs_long WHERE project_id=$1 AND lab_date=$2 AND lab_test_code='DSDNA'", [project, labDate])).id;
  for (const [user, batch] of [[analyst, labBatch], [viewer, labBatch], [outsider, labBatch], [null, labBatch]]) {
    await assert.rejects(undo(user, batch, '文件选错'), denied);
  }
  await assert.rejects(undo(editor, labBatch, ''), is('undo_reason_required'));
  await assert.rejects(undo(editor, labBatch, ' 错 '), is('undo_reason_required'));
  await assert.rejects(undo(editor, labBatch, null), is('undo_reason_required'));
  await assert.rejects(undo(editor, labBatch, 'x'.repeat(501)), is('undo_reason_required'));
  await assert.rejects(undo(editor, labBatch, '患者姓名张三的文件'), is('pii_detected_blocked'));
  await assert.rejects(undo(editor, randomUUID(), '文件选错'), is('import_batch_not_found'));
  const baselineBatch = randomUUID();
  assert.equal((await importRows(editor, 'baseline', [{patient_code: 'P-006', baseline_date: await day(-50)}], baselineBatch)).inserted, 1);
  await assert.rejects(undo(owner, baselineBatch, '文件选错'), is('batch_kind_not_undoable'));
  await assert.rejects(undo(owner, legacyVisitBatch, '文件选错'), is('batch_undo_not_tracked'));
  // The batch that skipped the same rows inserted nothing, so its undo deletes nothing; it is
  // undone first because while it stands the records it counted as skipped are kept.
  assert.deepEqual(await undo(editor, labSkipBatch, '重复导入'), {deleted: 0, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  const auditBefore = await count("SELECT count(*) AS n FROM public.audit_log WHERE action='import_batch_undone'");
  const undone = await undo(editor, labBatch, '导入文件选错');
  assert.deepEqual(undone, {deleted: 3, kept_changed: 1, kept_referenced: 0, missing: 0, already_undone: false});
  assert.deepEqual((await rows('SELECT lab_test_code,value_raw::float8 AS v FROM public.labs_long WHERE project_id=$1 AND lab_date=$2', [project, labDate])),
    [{lab_test_code: 'CREAT', v: 90}], 'only the corrected record remains');
  assert.equal(await count('SELECT count(*) AS n FROM public.labs_long WHERE id=$1', [qualitative]), 0);
  const deletions = await rows(`SELECT record_id,change_reason,changed_by FROM public.field_audit_log
    WHERE table_name='labs_long' AND field_name='__record_deleted__' AND project_id=$1`, [project]);
  assert.equal(deletions.length, 3);
  assert.ok(deletions.every(d => d.change_reason === `撤销导入批次 ${labBatch}：导入文件选错` && d.changed_by === editor));
  const audit = await row("SELECT actor_uid,details FROM public.audit_log WHERE action='import_batch_undone' AND details->>'batch_id'=$1", [labBatch]);
  assert.equal(audit.actor_uid, editor);
  assert.deepEqual([audit.details.reason, audit.details.kind, audit.details.deleted, audit.details.kept_changed, audit.details.file_sha256],
    ['导入文件选错', 'labs', 3, 1, fileSha]);
  assert.deepEqual(await undo(owner, labBatch, '再次撤销'), {deleted: 3, kept_changed: 1, kept_referenced: 0, missing: 0, already_undone: true});
  assert.equal(await count("SELECT count(*) AS n FROM public.audit_log WHERE action='import_batch_undone'"), auditBefore + 1, 'a repeated undo is not audited again');
  assert.equal(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='labs_long' AND field_name='__record_deleted__' AND project_id=$1", [project]), 3);
  const undoneEntry = (await listBatches(viewer)).find(b => b.batch_id === labBatch);
  assert.deepEqual([undoneEntry.undo_supported, undoneEntry.undo_reason, undoneEntry.undo_result], [false, '导入文件选错', {deleted: 3, kept_changed: 1, kept_referenced: 0, missing: 0}]);
  assert.ok(undoneEntry.undone_at instanceof Date);
  assert.equal(await count('SELECT count(*) AS n FROM public.labs_long WHERE id=$1', [creat]), 1);
  // The removed rows can be imported again; the corrected one is not overwritten.
  assert.equal((await importRows(editor, 'labs', labRows.slice(1))).inserted, 3);
  await assert.rejects(importRows(editor, 'labs', [labRows[0]]), is('row_1_record_changed_since_import'));
  pass('undo: deletes the unchanged records of the batch, keeps the corrected one, field-audits each deletion with the reason, writes one project audit entry, repeats as already_undone; reason, kind, legacy batch and permission are checked');

  // Medications: a batch row that matched an existing record must not delete that record.
  const medBatch2 = randomUUID();
  assert.deepEqual(await importRows(editor, 'meds', [medRows[0], {...okMed, drug_name: '托伐普坦'}], medBatch2),
    {inserted: 1, updated: 0, skipped: 1, total: 2, replayed: false});
  assert.deepEqual(await undo(owner, medBatch2, '用药文件重复'), {deleted: 1, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await count("SELECT count(*) AS n FROM public.meds_long WHERE project_id=$1 AND drug_name='氯沙坦'", [project]), 1);
  // A record changed with a plain table update is kept; one already deleted counts as missing.
  await as(editor, () => db.query("UPDATE public.meds_long SET notes='剂量已核对' WHERE project_id=$1 AND drug_name='达格列净'", [project]));
  assert.equal(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='meds_long' AND field_name='notes'"), 1, 'medication updates are field-audited');
  await as(editor, () => db.query("DELETE FROM public.meds_long WHERE project_id=$1 AND drug_name='泼尼松'", [project]));
  assert.deepEqual(await undo(editor, medSkipBatch, '重复导入'), {deleted: 0, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.deepEqual(await undo(editor, medBatch, '用药文件选错'), {deleted: 1, kept_changed: 1, kept_referenced: 0, missing: 1, already_undone: false});
  assert.deepEqual((await rows("SELECT drug_name FROM public.meds_long WHERE project_id=$1 ORDER BY drug_name", [project])).map(r => r.drug_name),
    ['Synthetic medication', '达格列净']);
  // Events and visits.
  await as(editor, () => db.query("UPDATE public.events_long SET event_detail='腹膜透析' WHERE project_id=$1 AND event_type='dialysis_start'", [project]));
  assert.deepEqual(await undo(editor, eventSkipBatch, '重复导入'), {deleted: 0, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.deepEqual(await undo(editor, eventBatch, '事件文件选错'), {deleted: 5, kept_changed: 1, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='events_long' AND field_name='__record_deleted__'"), 5);
  const visitBatch = randomUUID();
  assert.equal((await importRows(editor, 'visits', [{patient_code: 'P-004', visit_date: await day(-7), sbp: 118, dbp: 76, scr_umol_l: 80}], visitBatch)).inserted, 1);
  assert.deepEqual(await undo(owner, visitBatch, '随访文件选错'), {deleted: 1, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await count("SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1 AND patient_code='P-004'", [project]), 0);
  // The 500-row batch is undone in one call.
  assert.deepEqual(await undo(editor, bigBatch, '整批重复'), {deleted: 500, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  pass('undo: records matched by a batch survive, records changed by a plain update are kept, already deleted ones count as missing; medication, event, visit and 500-row batches');

  // ---- Undo and records other batches also imported ----------------------------------------------------
  const links = id => count('SELECT count(*) AS n FROM public.registry_import_records WHERE project_id=$1 AND record_id=$2', [project, id]);
  const labId = async date => (await row("SELECT id FROM public.labs_long WHERE project_id=$1 AND patient_code='P-004' AND lab_date=$2 AND lab_test_code='K'", [project, date]))?.id;
  const kLab = (date, extra = {}) => ({patient_code: 'P-004', lab_date: date, lab_test_code: 'K', value_raw: 4.1, unit_symbol: 'mmol/L', ...extra});
  // A inserts a row with notes; B carries the same row without notes and skips it as present.
  const d1 = await day(-250), refA = randomUUID(), refB = randomUUID();
  assert.equal((await importRows(editor, 'labs', [kLab(d1, {notes: '复查'})], refA)).inserted, 1);
  assert.deepEqual(await importRows(editor, 'labs', [kLab(d1)], refB), {inserted: 0, updated: 0, skipped: 1, total: 1, replayed: false});
  const r1 = await labId(d1);
  assert.deepEqual(await undo(editor, refA, '文件选错'), {deleted: 0, kept_changed: 0, kept_referenced: 1, missing: 0, already_undone: false});
  assert.equal(await labId(d1), r1, 'the record batch B counted as skipped is kept');
  assert.deepEqual((await listBatches(viewer)).find(b => b.batch_id === refA).undo_result, {deleted: 0, kept_changed: 0, kept_referenced: 1, missing: 0});
  assert.equal((await row("SELECT details FROM public.audit_log WHERE action='import_batch_undone' AND details->>'batch_id'=$1", [refA])).details.kept_referenced, 1);
  assert.deepEqual([(await importRows(editor, 'labs', [kLab(d1)])).skipped, (await importRows(editor, 'labs', [kLab(d1, {notes: '复查'})])).skipped], [1, 1],
    'both contents still import as skipped');
  // Once B is undone, undoing A deletes the record and every link to it: B's content imports again.
  const d2 = await day(-251), refA2 = randomUUID(), refB2 = randomUUID();
  assert.equal((await importRows(editor, 'labs', [kLab(d2, {notes: '复查'})], refA2)).inserted, 1);
  assert.equal((await importRows(editor, 'labs', [kLab(d2)], refB2)).skipped, 1);
  const r2 = await labId(d2);
  assert.deepEqual(await undo(editor, refB2, '文件选错'), {deleted: 0, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await labId(d2), r2, 'undoing the skipping batch deletes nothing');
  assert.deepEqual(await undo(editor, refA2, '文件选错'), {deleted: 1, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await labId(d2), undefined);
  assert.equal(await links(r2), 0, 'no link to the deleted record is left');
  assert.equal((await importRows(editor, 'labs', [kLab(d2)])).inserted, 1, 'the content of the undone batches imports again');
  // A batch with exactly the same content (same hash) also keeps the record.
  const d3 = await day(-252), refA3 = randomUUID();
  assert.equal((await importRows(editor, 'labs', [kLab(d3)], refA3)).inserted, 1);
  assert.equal((await importRows(owner, 'labs', [kLab(d3)])).skipped, 1);
  assert.deepEqual(await undo(editor, refA3, '文件选错'), {deleted: 0, kept_changed: 0, kept_referenced: 1, missing: 0, already_undone: false});
  assert.ok(await labId(d3));
  // The same key twice in one file, once with notes: undo removes it and the same file uploads again.
  const d4 = await day(-253), dupFile = [kLab(d4, {notes: '复查'}), kLab(d4)], refD = randomUUID();
  assert.deepEqual(await importRows(editor, 'labs', dupFile, refD), {inserted: 1, updated: 0, skipped: 1, total: 2, replayed: false});
  const r4 = await labId(d4);
  assert.deepEqual(await undo(editor, refD, '文件选错'), {deleted: 1, kept_changed: 0, kept_referenced: 0, missing: 0, already_undone: false});
  assert.equal(await links(r4), 0);
  assert.deepEqual(await importRows(editor, 'labs', dupFile), {inserted: 1, updated: 0, skipped: 1, total: 2, replayed: false});
  // A record already deleted by hand: undo counts it missing and clears its links, so it can be re-imported.
  const d5 = await day(-254), refE = randomUUID(), refF = randomUUID();
  assert.equal((await importRows(editor, 'labs', [kLab(d5, {notes: '复查'})], refE)).inserted, 1);
  assert.equal((await importRows(editor, 'labs', [kLab(d5)], refF)).skipped, 1);
  const r5 = await labId(d5);
  await as(editor, () => db.query('DELETE FROM public.labs_long WHERE id=$1', [r5]));
  assert.deepEqual(await undo(editor, refE, '文件选错'), {deleted: 0, kept_changed: 0, kept_referenced: 0, missing: 1, already_undone: false});
  assert.equal(await links(r5), 0);
  assert.equal((await importRows(editor, 'labs', [kLab(d5)])).inserted, 1);
  // Visits follow the same rule.
  const v1 = {patient_code: 'P-004', visit_date: await day(-255), sbp: 121, dbp: 79}, refV = randomUUID();
  assert.equal((await importRows(editor, 'visits', [v1], refV)).inserted, 1);
  assert.equal((await importRows(owner, 'visits', [v1])).skipped, 1);
  assert.deepEqual(await undo(editor, refV, '文件选错'), {deleted: 0, kept_changed: 0, kept_referenced: 1, missing: 0, already_undone: false});
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1 AND patient_code=$2 AND visit_date=$3', [project, 'P-004', v1.visit_date]), 1);
  pass('undo keeps a record another batch not yet undone skipped as present (kept_referenced); a deleted or missing record loses every link, so undone content, including a file with the same key twice, imports again');

  // ---- Corrections of imported lab rows ----------------------------------------------------------------
  const dsdna = (await row("SELECT id FROM public.labs_long WHERE project_id=$1 AND lab_date=$2 AND lab_test_code='DSDNA'", [project, labDate])).id;
  const corrected = await as(editor, async () => (await row("SELECT public.correct_registry_record($1,'labs_long',$2,$3,'按原始化验单更正') AS r",
    [project, dsdna, JSON.stringify({result_text: '弱阳性', abnormal_flag: 'H'})])).r);
  assert.deepEqual([corrected.changed, corrected.record.result_text, corrected.record.abnormal_flag, corrected.record.normalization_status], [true, '弱阳性', 'H', 'qualitative']);
  const toQuantitative = await as(editor, async () => (await row("SELECT public.correct_registry_record($1,'labs_long',$2,$3,'按原始化验单更正') AS r",
    [project, dsdna, JSON.stringify({value_raw: 12, unit_symbol: 'IU/mL'})])).r);
  assert.deepEqual([toQuantitative.record.normalization_status, Number(toQuantitative.record.value_standard), toQuantitative.record.result_text], ['normalized', 12, '弱阳性']);
  for (const [changes, expected] of [[{unit_symbol: 'g/L'}, 'unit_not_allowed: unit_symbol'], [{value_raw: null, result_text: null}, 'lab_value_or_result_required'],
    [{notes: '电话13812345678'}, 'pii_detected_blocked: notes'], [{patient_code: 'P-001'}, 'patient_identity_is_immutable'], [{abnormal_flag: 'Z'}, 'invalid_abnormal_flag']]) {
    await as(editor, () => assert.rejects(db.query("SELECT public.correct_registry_record($1,'labs_long',$2,$3,'按原始化验单更正')", [project, dsdna, JSON.stringify(changes)]), is(expected), expected));
  }
  assert.ok(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='labs_long' AND record_id=$1 AND field_name='result_text' AND change_reason='按原始化验单更正'", [dsdna]) === 1);
  await as(editor, () => assert.rejects(db.query("UPDATE public.labs_long SET notes='身份证 110101199001011234' WHERE id=$1", [dsdna]), is('pii_detected_blocked')));
  await as(editor, () => assert.rejects(db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,event_detail) VALUES($1,'P-004','custom',CURRENT_DATE-1,'姓名王五')", [project]), is('pii_detected_blocked')));
  pass('audited correction covers qualitative results, flags and notes of imported labs with the same unit and identifying-information checks; direct writes are guarded too');

  assert.deepEqual(await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b WHERE patient_code <> $1 ORDER BY id', ['P-006']), patientsBefore,
    'imports and undo never changed an existing baseline row');
  console.log(`BATCH_IMPORT_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
