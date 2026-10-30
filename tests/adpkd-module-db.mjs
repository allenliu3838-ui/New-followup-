// Native PG17 acceptance for 0046 (ADPKD module and the vasopressin V2 receptor antagonist
// medication class). The database is first built to 0045 and filled the way a v7 database can look
// (a C3G project with a patient, a medication recorded under 其他 and a custom field); 0046 must
// apply as the reviewed increment, leave every stored value as it was, re-create its two functions
// with only the reviewed additions, and let a project owner create an ADPKD project and load the
// workbench's ADPKD field draft through save_project_field. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic ADPKD module acceptance accepts no external input');
const NEW_MIGRATION = '0046_adpkd_module.sql';
const NEW_CLASS = '血管加压素V2受体拮抗剂';
// The draft is the workbench's own definition (site/lib/project-fields.js, a dependency-free module).
const loadModule = file => import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'site', file)).toString('base64')}`);
const {ADPKD_DRAFT, ADPKD_SOURCE} = await loadModule('lib/project-fields.js');
const db = await createDatabase();
await db.exec("SET timezone='Asia/Shanghai'");
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => Number((await row(sql, args)).n);
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

const [owner, editor, viewer, legacy] = Array.from({length: 4}, () => randomUUID());
const email = {[owner]: 'pkd-owner@example.invalid', [editor]: 'pkd-editor@example.invalid', [viewer]: 'pkd-viewer@example.invalid',
  [legacy]: 'pkd-legacy@example.invalid'};
const legacyProj = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const createProject = (user, name, center, module) => as(user, async () =>
  (await row('SELECT public.create_project($1,$2,$3,NULL) AS id', [name, center, module])).id);
const importRows = (user, pid, kind, list, batch = randomUUID()) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const undo = (user, pid, batch) => as(user, async () => (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [pid, batch, '合成测试撤销'])).r);
const saveField = (user, pid, field) => as(user, async () => (await row('SELECT public.save_project_field($1,$2) AS f', [pid, JSON.stringify(field)])).f);
const setValues = (user, pid, code, values) => as(user, async () =>
  (await row('SELECT public.set_patient_field_values($1,$2,$3) AS r', [pid, code, JSON.stringify(values)])).r);
const fn = signature => row(`SELECT p.prosrc, p.prosecdef, p.provolatile, p.proconfig::text AS config,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon_exec, has_function_privilege('authenticated',p.oid,'EXECUTE') AS user_exec
  FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [signature]);
const GUARD = 'public._create_project_account_guard()';
const VALIDATE = 'registry_private.validate_clinical_input(text,jsonb)';

try {
  // ---- A v7 database at 0045 -------------------------------------------------------------
  const upTo45 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 45);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 45), [NEW_MIGRATION],
    'exactly one reviewed increment follows 0045');
  for (const file of upTo45) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 14);
  for (const id of [owner, editor, viewer, legacy]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic C3G project','SYN','C3G','c3g',$2)", [legacyProj, legacy]);
  const year = await thisYear();
  const longAgo = await day(-400), d30 = await day(-30), today = await day(0);
  await as(legacy, async () => {
    await db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
      VALUES ($1,'L-1','F',${year - 41},$2,80,'consented',$2,'V1')`, [legacyProj, longAgo]);
    // Before this release a V2 antagonist could only be recorded under 其他; the migration must not reclassify it.
    await db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,start_date) VALUES($1,'L-1','合成药物甲','其他',$2)", [legacyProj, d30]);
  });
  await saveField(legacy, legacyProj, {field_key: 'liver_cysts', label_cn: '肝囊肿', value_type: 'yes_no'});
  await setValues(legacy, legacyProj, 'L-1', {liver_cysts: 'yes'});
  await assert.rejects(createProject(owner, '合成多囊肾项目', 'PKD01', 'ADPKD'), is('invalid_module'), 'before 0046 the module is refused');
  await assert.rejects(importRows(legacy, legacyProj, 'meds', [{patient_code: 'L-1', drug_name: '合成药物乙', drug_class: NEW_CLASS, start_date: today}]),
    is('row_1_invalid_drug_class'), 'before 0046 the class is refused');
  const snapshot = async () => ({
    projects: await rows('SELECT * FROM public.projects ORDER BY id'),
    baseline: await rows('SELECT * FROM public.patients_baseline ORDER BY project_id,patient_code'),
    meds: await rows('SELECT * FROM public.meds_long ORDER BY id'),
    fields: await rows('SELECT * FROM public.project_fields ORDER BY project_id,field_key'),
    values: await rows('SELECT * FROM public.patient_field_values ORDER BY project_id,patient_code,field_key'),
    imports: await rows('SELECT * FROM public.registry_import_records ORDER BY record_id'),
    abbreviations: await rows('SELECT * FROM public.abbreviation_dictionary ORDER BY abbr'),
    concepts: await rows('SELECT * FROM public.concept_dictionary ORDER BY code'),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
    projectAudits: await count('SELECT count(*) AS n FROM public.audit_log'),
  });
  const before = await snapshot();
  const guardBefore = await fn(GUARD), validateBefore = await fn(VALIDATE);

  // ---- The reviewed increment ---------------------------------------------------------
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 15);
  const once = await snapshot();
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 15);
  assert.deepEqual(await snapshot(), once, 'running 0046 again changes nothing');
  pass('0046 applies on a 0045 database and is safe to re-run');

  const {abbreviations: abbrAfter, ...restAfter} = once;
  const {abbreviations: abbrBefore, ...restBefore} = before;
  assert.deepEqual(restAfter, restBefore, 'projects, patients, medications, fields, values, import links and audit rows are unchanged');
  assert.equal(once.meds.find(m => m.drug_name === '合成药物甲').drug_class, '其他', 'existing medication classes are not rewritten');
  assert.deepEqual(abbrAfter.filter(a => abbrBefore.some(b => b.abbr === a.abbr)), abbrBefore, 'existing abbreviations untouched');
  assert.deepEqual(abbrAfter.filter(a => !abbrBefore.some(b => b.abbr === a.abbr)).map(a => [a.abbr, a.full_name_cn, a.category_cn]),
    [['ADPKD', '常染色体显性多囊肾病', '病种相关']]);
  pass('every stored row is unchanged (an earlier V2 antagonist stays under 其他); only the ADPKD abbreviation is added');

  const guardAfter = await fn(GUARD), validateAfter = await fn(VALIDATE);
  const expectedGuard = guardBefore.prosrc.replace("('IGAN','LN','MN','DKD','CKD','KTX','GENERAL','C3G')", "('IGAN','LN','MN','DKD','CKD','KTX','GENERAL','C3G','ADPKD')");
  const expectedValidate = validateBefore.prosrc.replace("'试验药物','疫苗') THEN RAISE EXCEPTION 'invalid_drug_class';",
    `'试验药物','疫苗',\n      '${NEW_CLASS}') THEN RAISE EXCEPTION 'invalid_drug_class';`);
  assert.notEqual(expectedGuard, guardBefore.prosrc); assert.notEqual(expectedValidate, validateBefore.prosrc);
  assert.equal(guardAfter.prosrc, expectedGuard, 'the guard differs from 0042 only by the ADPKD module');
  assert.equal(validateAfter.prosrc, expectedValidate, 'the validation differs from 0043 only by the new class');
  for (const [b, a] of [[guardBefore, guardAfter], [validateBefore, validateAfter]]) {
    assert.deepEqual([a.prosecdef, a.provolatile, a.config], [b.prosecdef, b.provolatile, b.config], 'security, volatility and search_path unchanged');
    assert.deepEqual([a.anon_exec, a.user_exec], [false, false], 'clients cannot call the re-created function directly');
  }
  const comment = (await row("SELECT col_description('public.meds_long'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='public.meds_long'::regclass AND attname='drug_class')) AS c")).c;
  assert.ok(comment.includes(`疫苗、${NEW_CLASS}、其他`) && comment.includes('托伐普坦'));
  pass('the two functions are 0042/0043 plus exactly the reviewed additions; privileges and settings unchanged');

  // ---- ADPKD projects ------------------------------------------------------------------
  const pkd = await createProject(owner, '合成多囊肾项目', 'PKD01', 'ADPKD');
  assert.deepEqual(Object.values(await row('SELECT module,registry_type,created_by FROM public.projects WHERE id=$1', [pkd])), ['ADPKD', 'adpkd', owner]);
  const second = await createProject(editor, '合成多囊肾项目二', 'PKD02', 'adpkd');
  assert.equal((await row('SELECT module FROM public.projects WHERE id=$1', [second])).module, 'ADPKD', 'create_project upper-cases the module');
  await assert.rejects(createProject(viewer, '合成项目', 'X01', 'PKD'), is('invalid_module'), 'unknown modules are still refused');
  await assert.rejects(createProject(owner, '合成项目', 'X02', 'ADPKD'), is('project_quota_exceeded'), 'the account quota still applies');
  const c3g = await createProject(viewer, '合成 C3G 项目', 'C3G01', 'C3G');
  assert.equal((await row('SELECT module FROM public.projects WHERE id=$1', [c3g])).module, 'C3G', 'earlier modules are still accepted');
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [pkd, email[user], role])).r.status, 'added'));
  }
  pass('a project owner can create ADPKD projects; unknown modules and the quota are enforced as before');

  // ---- The workbench ADPKD draft through save_project_field ------------------------------
  assert.equal(ADPKD_DRAFT.length, 12);
  assert.ok(ADPKD_DRAFT.every(f => f.source === ADPKD_SOURCE));
  await assert.rejects(saveField(editor, pkd, ADPKD_DRAFT[0]), e => e.code === '42501' && e.message === 'project_access_denied', 'only the owner defines fields');
  const saved = [];
  for (const field of ADPKD_DRAFT) saved.push(await saveField(owner, pkd, field));
  assert.deepEqual(saved.map(f => [f.field_key, f.value_type, f.active, f.source]), ADPKD_DRAFT.map(f => [f.field_key, f.value_type, true, ADPKD_SOURCE]));
  const stored = await rows('SELECT field_key,label_cn,help_cn,choices,unit,min_value::text,max_value::text FROM public.project_fields WHERE project_id=$1', [pkd]);
  for (const f of ADPKD_DRAFT) {
    const s = stored.find(x => x.field_key === f.field_key);
    assert.deepEqual([s.label_cn, s.help_cn ?? undefined, s.choices ?? undefined, s.unit ?? undefined],
      [f.label_cn, f.help_cn, f.choices, f.unit], `${f.field_key} is stored exactly as drafted`);
    if (f.value_type === 'number') assert.deepEqual([Number(s.min_value), Number(s.max_value)], [f.min_value, f.max_value]);
  }
  assert.ok(!ADPKD_DRAFT.some(f => /variant|genotype|pkd1|pkd2|mutation/i.test(f.field_key + JSON.stringify(f.choices || []))),
    'the draft records whether a genetic test was done, never its result');
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'K-1','M',${year - 38},$2,110,'consented',$2,'V1')`, [pkd, longAgo]));
  const result = await setValues(editor, pkd, 'K-1', {adpkd_dx_basis: ['genetic', 'imaging_family'], family_history: 'yes', age_at_diagnosis: '29',
    hypertension: 'yes', hypertension_onset_age: '31', kidney_history: ['flank_pain', 'gross_hematuria'], liver_cysts: 'yes', ia_screening: 'negative', genetic_testing: 'done'});
  assert.equal(Number(result.changed), 9);
  const values = await rows('SELECT field_key,value_text,value_codes,value_num::text AS value_num FROM public.patient_field_values WHERE project_id=$1 ORDER BY field_key', [pkd]);
  assert.deepEqual(values.find(v => v.field_key === 'adpkd_dx_basis').value_codes, ['imaging_family', 'genetic'], 'multi-choice codes keep the draft order');
  assert.deepEqual(values.find(v => v.field_key === 'kidney_history').value_codes, ['gross_hematuria', 'flank_pain']);
  assert.equal(Number(values.find(v => v.field_key === 'hypertension_onset_age').value_num), 31);
  await assert.rejects(setValues(editor, pkd, 'K-1', {age_at_diagnosis: '120'}), is('invalid_field_value: age_at_diagnosis'), 'the drafted range is enforced');
  await assert.rejects(setValues(editor, pkd, 'K-1', {ia_screening: 'unknown_code'}), is('invalid_field_value: ia_screening'), 'only drafted options are accepted');
  await assert.rejects(setValues(viewer, pkd, 'K-1', {liver_cysts: 'no'}), e => e.code === '42501' || /permission|denied/i.test(e.message));
  pass('all 12 drafted fields pass the database rules; values are checked against the draft; only the owner defines fields');

  // ---- The medication class --------------------------------------------------------------
  const batch = randomUUID();
  const meds = [
    {patient_code: 'K-1', drug_name: '合成药物乙', drug_class: NEW_CLASS, dose_value: '45', dose_unit: 'mg', route: 'PO', frequency: 'qd', start_date: d30},
    {patient_code: 'K-1', drug_name: '合成药物丙', drug_class: 'RAS阻断剂', start_date: d30},
  ];
  assert.deepEqual(await importRows(editor, pkd, 'meds', meds, batch), {inserted: 2, updated: 0, skipped: 0, total: 2, replayed: false});
  assert.deepEqual((await rows('SELECT drug_class,dose FROM public.meds_long WHERE project_id=$1 ORDER BY drug_name', [pkd])).map(r => [r.drug_class, r.dose]),
    [['RAS阻断剂', null], [NEW_CLASS, '45 mg']]);
  await assert.rejects(importRows(editor, pkd, 'meds', [{patient_code: 'K-1', drug_name: '合成药物丁', drug_class: 'V2受体拮抗剂', start_date: today}]),
    is('row_1_invalid_drug_class'), 'the database accepts only the exact class name (the workbench maps short forms before sending)');
  await as(editor, () => db.query('INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,start_date) VALUES($1,$2,$3,$4,$5)', [pkd, 'K-1', '合成药物戊', NEW_CLASS, today]));
  assert.equal((await undo(editor, pkd, batch)).deleted, 2);
  assert.equal(await count('SELECT count(*) AS n FROM public.meds_long WHERE project_id=$1', [pkd]), 1, 'undo removes the imported rows only');
  assert.equal((await row("SELECT drug_class FROM public.meds_long WHERE project_id=$1 AND drug_name='合成药物甲'", [legacyProj])).drug_class, '其他');
  pass('batch import accepts the V2 antagonist class with dose and route; other classes and undo behave as before');

  // ---- Frozen export ----------------------------------------------------------------------
  const exported = await as(owner, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [pkd, randomUUID()])).e);
  const content = JSON.parse(exported.content_text);
  assert.equal(content.project.module, 'ADPKD');
  assert.deepEqual(content.tables.meds_long.map(m => m.drug_class), [NEW_CLASS]);
  assert.equal(content.tables.project_fields.length, 12);
  assert.deepEqual(content.tables.patient_field_values.map(v => v.field_key).sort(),
    ['adpkd_dx_basis', 'age_at_diagnosis', 'family_history', 'genetic_testing', 'hypertension', 'hypertension_onset_age', 'ia_screening', 'kidney_history', 'liver_cysts']);
  pass('the frozen export carries the ADPKD module, the medication class, the drafted fields and their values');

  console.log(`ADPKD_MODULE_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
