// Native PG17 acceptance for 0045 (serum cystatin C and urine red-cell counts in the laboratory
// dictionary). The database is first built to 0044 and filled the way a v7 database can look
// (a project with an adult patient and labs); 0045 must apply as the reviewed increment, leave
// every stored value and dictionary row as it was, and add exactly the reviewed tests and units.
// Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic cystatin C / urine RBC acceptance accepts no external input');
const NEW_MIGRATION = '0045_cystatin_urine_rbc.sql';
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

const [owner, editor, viewer] = Array.from({length: 3}, () => randomUUID());
const email = {[owner]: 'cys-owner@example.invalid', [editor]: 'cys-editor@example.invalid', [viewer]: 'cys-viewer@example.invalid'};
const proj = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const upsertLab = (user, code, date, test, value, unit) => as(user, async () =>
  (await row('SELECT public.upsert_lab_record($1,$2,$3,$4,$5,$6,NULL,NULL) AS r', [proj, code, date, test, value, unit])).r);
const importRows = (user, list, batch = randomUUID()) => as(user, async () =>
  (await row("SELECT public.import_registry_rows($1,'labs',$2,$3) AS r", [proj, JSON.stringify(list), batch])).r);
const lab = id => row('SELECT lab_test_code,value_raw::text,unit_symbol,value_standard::text,standard_unit,normalization_status,result_text FROM public.labs_long WHERE id=$1', [id]);

const NEW_TESTS = [
  ['CYSC', 'GENERAL', 'mg/L', '33863-2'],
  ['URBC_HPF', 'GENERAL', 'cells/HPF', '13945-1'],
  ['URBC_UL', 'GENERAL', 'cells/μL', null],
];
const NEW_UNITS = [
  ['CYSC', 'mg/L', true],
  ['URBC_HPF', '/HP', false], ['URBC_HPF', '/HPF', false], ['URBC_HPF', 'cells/HPF', true], ['URBC_HPF', '个/HP', false], ['URBC_HPF', '个/HPF', false],
  ['URBC_UL', '/μL', false], ['URBC_UL', 'cells/μL', true], ['URBC_UL', '个/μL', false],
];

try {
  // ---- A v7 database at 0044 -------------------------------------------------------------
  const upTo44 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 44);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 44), [NEW_MIGRATION],
    'exactly one reviewed increment follows 0044');
  for (const file of upTo44) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 13);
  for (const id of [owner, editor, viewer]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic C3G project','SYN','C3G','c3g',$2)", [proj, owner]);
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [proj, email[user], role])).r.status, 'added'));
  }
  const year = await thisYear();
  const longAgo = await day(-400), d30 = await day(-30), d20 = await day(-20), d10 = await day(-10);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'A-1','F',${year - 45},$2,80,'consented',$2,'V1')`, [proj, longAgo]));
  const legacyCreat = await upsertLab(editor, 'A-1', d30, 'CREAT', 1.1, 'mg/dL');
  const legacyC3 = await upsertLab(editor, 'A-1', d30, 'C3', 0.62, 'g/L');
  assert.ok(legacyCreat && legacyC3);
  const snapshot = async () => ({
    labs: await rows('SELECT * FROM public.labs_long WHERE project_id=$1 ORDER BY id', [proj]),
    catalog: await rows('SELECT * FROM public.lab_test_catalog ORDER BY code'),
    unitMap: await rows('SELECT * FROM public.lab_test_unit_map ORDER BY lab_test_code,unit_symbol'),
    units: await rows('SELECT * FROM public.unit_catalog ORDER BY symbol'),
    abbreviations: await rows('SELECT * FROM public.abbreviation_dictionary ORDER BY abbr'),
    concepts: await count('SELECT count(*) AS n FROM public.concept_dictionary'),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
  });
  const before = await snapshot();

  // ---- The reviewed increment ---------------------------------------------------------
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 14);
  const once = await snapshot();
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 14);
  assert.deepEqual(await snapshot(), once, 'running 0045 again changes nothing');
  pass('0045 applies on a 0044 database and is safe to re-run');

  const after = once;
  assert.deepEqual(after.labs, before.labs, 'stored lab rows are byte-identical');
  assert.equal(after.audits, before.audits, 'the migration writes no audit rows');
  assert.equal(after.concepts, before.concepts, 'the concept dictionary is unchanged');
  const added = (list, old, key) => list.filter(r => !old.some(o => key(o) === key(r)));
  const kept = (list, old, key) => list.filter(r => old.some(o => key(o) === key(r)));
  assert.deepEqual(kept(after.catalog, before.catalog, r => r.code), before.catalog, 'existing tests untouched');
  assert.deepEqual(added(after.catalog, before.catalog, r => r.code).map(r => [r.code, r.module, r.standard_unit, r.loinc_code]), NEW_TESTS);
  assert.ok(added(after.catalog, before.catalog, r => r.code).every(r => r.is_core === false && r.display_note.length > 20));
  const unitKey = r => `${r.lab_test_code}|${r.unit_symbol}`;
  assert.deepEqual(kept(after.unitMap, before.unitMap, unitKey), before.unitMap, 'existing unit conversions untouched');
  const newUnits = added(after.unitMap, before.unitMap, unitKey);
  assert.deepEqual(newUnits.map(r => [r.lab_test_code, r.unit_symbol, r.is_standard]), NEW_UNITS);
  assert.ok(newUnits.every(r => Number(r.multiplier) === 1 && Number(r.offset_val) === 0), 'every new unit is a spelling of the standard unit');
  const ul = new Set(newUnits.filter(r => r.lab_test_code === 'URBC_UL').map(r => r.unit_symbol));
  assert.ok(newUnits.filter(r => r.lab_test_code === 'URBC_HPF').every(r => !ul.has(r.unit_symbol)), 'no unit is shared by /μL and /HPF counts');
  assert.deepEqual(kept(after.units, before.units, r => r.symbol), before.units, 'existing unit symbols untouched');
  assert.deepEqual(added(after.units, before.units, r => r.symbol).map(r => r.symbol).sort(), ['/HP', '/HPF', '/μL', 'cells/HPF', '个/HP', '个/HPF', '个/μL'].sort());
  assert.deepEqual(kept(after.abbreviations, before.abbreviations, r => r.abbr), before.abbreviations);
  assert.deepEqual(added(after.abbreviations, before.abbreviations, r => r.abbr).map(r => r.abbr), ['CysC', 'HPF']);
  pass('stored labs and every existing dictionary row are unchanged; exactly the reviewed tests, units and abbreviations are added');

  await as(viewer, async () => {
    assert.equal(await count("SELECT count(*) AS n FROM public.lab_test_catalog WHERE code IN ('CYSC','URBC_UL','URBC_HPF')"), 3);
    assert.equal(await count("SELECT count(*) AS n FROM public.lab_test_unit_map WHERE lab_test_code IN ('CYSC','URBC_UL','URBC_HPF')"), 9);
    await assert.rejects(db.query("INSERT INTO public.lab_test_unit_map(lab_test_code,unit_symbol,multiplier,offset_val,is_standard) VALUES('URBC_UL','cells/HPF',5,0,false)"), e => e.code === '42501');
    await assert.rejects(db.query("UPDATE public.lab_test_catalog SET standard_unit='cells/HPF' WHERE code='URBC_UL'"), e => e.code === '42501');
  });
  await as(null, async () => assert.equal(await count("SELECT count(*) AS n FROM public.lab_test_catalog WHERE code='CYSC'"), 1));
  pass('the new dictionary rows are readable by everyone and writable by no account');

  // ---- Recording values ----------------------------------------------------------------
  const cys = await lab(await upsertLab(editor, 'A-1', d20, 'CYSC', 1.05, 'mg/L'));
  assert.deepEqual(cys, {lab_test_code: 'CYSC', value_raw: '1.05', unit_symbol: 'mg/L', value_standard: '1.05', standard_unit: 'mg/L', normalization_status: 'normalized', result_text: null});
  const perUl = await lab(await upsertLab(editor, 'A-1', d20, 'URBC_UL', 25, '个/μL'));
  assert.deepEqual([perUl.value_standard, perUl.standard_unit, perUl.unit_symbol, perUl.normalization_status], ['25', 'cells/μL', '个/μL', 'normalized']);
  const perHpf = await lab(await upsertLab(editor, 'A-1', d20, 'URBC_HPF', 3, '/HP'));
  assert.deepEqual([perHpf.value_standard, perHpf.standard_unit, perHpf.unit_symbol], ['3', 'cells/HPF', '/HP']);
  for (const [test, unit] of [['URBC_UL', '/HPF'], ['URBC_UL', 'cells/HPF'], ['URBC_HPF', 'cells/μL'], ['URBC_HPF', '/μL'], ['CYSC', 'mg/dL']]) {
    await assert.rejects(upsertLab(editor, 'A-1', d10, test, 4, unit), is(/unit_not_allowed/), `${test} refuses ${unit}`);
  }
  await assert.rejects(upsertLab(viewer, 'A-1', d10, 'CYSC', 1, 'mg/L'), e => e.code === '42501' || /permission|not_allowed|denied/i.test(e.message));
  const creat = await lab(await upsertLab(editor, 'A-1', d10, 'CREAT', 97, 'μmol/L'));
  assert.deepEqual([creat.standard_unit, creat.normalization_status], ['mg/dL', 'normalized'], 'existing tests normalize as before');
  pass('values convert only within their own method: cystatin C in mg/L; /μL and /HPF counts never into each other');

  const batch = randomUUID();
  const imported = await importRows(editor, [
    {patient_code: 'A-1', lab_date: d10, lab_test_code: 'CYSC', value_raw: '0.98', unit_symbol: 'mg/L'},
    {patient_code: 'A-1', lab_date: d10, lab_test_code: 'URBC_HPF', result_text: '满视野'},
    {patient_code: 'A-1', lab_date: d10, lab_test_code: 'URBC_UL', value_raw: '310', unit_symbol: '/μL', notes: 'UF-5000'},
  ], batch);
  assert.deepEqual(imported, {inserted: 3, updated: 0, skipped: 0, total: 3, replayed: false});
  const importedRows = await rows(`SELECT lab_test_code,value_standard::text,standard_unit,normalization_status,result_text FROM public.labs_long
    WHERE project_id=$1 AND lab_date=$2 AND lab_test_code IN ('CYSC','URBC_UL','URBC_HPF') ORDER BY lab_test_code`, [proj, d10]);
  assert.deepEqual(importedRows.map(r => [r.lab_test_code, r.value_standard, r.standard_unit, r.normalization_status, r.result_text]), [
    ['CYSC', '0.98', 'mg/L', 'normalized', null],
    ['URBC_HPF', null, null, 'qualitative', '满视野'],
    ['URBC_UL', '310', 'cells/μL', 'normalized', null],
  ]);
  await assert.rejects(importRows(editor, [{patient_code: 'A-1', lab_date: d20, lab_test_code: 'URBC_UL', value_raw: '8', unit_symbol: '/HPF'}]),
    error => is('row_1_unit_not_allowed: unit_symbol')(error) && error.hint.includes('cells/μL') && !error.hint.includes('cells/HPF'), 'the hint lists only the /μL spellings');
  assert.equal((await as(editor, async () => (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [proj, batch, '合成测试撤销'])).r)).deleted, 3);
  pass('batch import accepts the new tests (numeric and text-only results), refuses a unit of the other method and can be undone');

  const exported = await as(owner, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [proj, randomUUID()])).e);
  const content = JSON.parse(exported.content_text);
  assert.deepEqual(content.tables.labs_long.filter(l => ['CYSC', 'URBC_UL', 'URBC_HPF'].includes(l.lab_test_code))
    .map(l => [l.lab_test_code, String(l.value_standard), l.standard_unit]).sort(), [['CYSC', '1.05', 'mg/L'], ['URBC_HPF', '3', 'cells/HPF'], ['URBC_UL', '25', 'cells/μL']]);
  pass('the frozen export carries the new results with their standard units');

  console.log(`CYSTATIN_URINE_RBC_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
