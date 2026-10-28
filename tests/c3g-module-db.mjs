// Native PG17 acceptance for 0042 (C3 glomerulopathy module, visit height with paediatric
// eGFR, safety events). The database is first built to 0041 and filled the way production
// looks today (an IgAN project with an adult and a child, labs, a custom event); 0042 is then
// applied as the reviewed increment and must leave every stored value as it was. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic C3G module acceptance accepts no external input');
const NEW_MIGRATION = '0042_c3g_module.sql';
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

// Two project owners: a trial account may create one project, so the C3G project has its own.
const [owner, c3gOwner, editor, viewer, outsider] = Array.from({length: 5}, () => randomUUID());
const email = {[owner]: 'c3g-igan-owner@example.invalid', [c3gOwner]: 'c3g-owner@example.invalid', [editor]: 'c3g-editor@example.invalid',
  [viewer]: 'c3g-viewer@example.invalid', [outsider]: 'c3g-outsider@example.invalid'};
const igan = randomUUID(), c3g = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const importRows = (user, kind, list, pid, batch = randomUUID()) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const correct = (user, pid, table, id, changes, reason) => as(user, async () =>
  (await row('SELECT public.correct_registry_record($1,$2,$3,$4,$5) AS r', [pid, table, id, JSON.stringify(changes), reason])).r);
const upsertLab = (user, pid, code, date, test, value, unit) => as(user, async () =>
  (await row('SELECT public.upsert_lab_record($1,$2,$3,$4,$5,$6,NULL,NULL) AS r', [pid, code, date, test, value, unit])).r);
const visit = (pid, code) => row('SELECT * FROM public.visits_long WHERE project_id=$1 AND patient_code=$2 ORDER BY visit_date DESC LIMIT 1', [pid, code]);
const insertVisit = (user, pid, {patient_code, ...values}) => as(user, () => {
  const keys = Object.keys(values);
  return row(`INSERT INTO public.visits_long(project_id,patient_code,${keys.join(',')}) VALUES($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')}) RETURNING id,egfr,egfr_formula_version`,
    [pid, patient_code, ...keys.map(k => values[k])]);
});
const schwartz = (heightCm, scrUmol) => Math.round(0.413 * heightCm / (scrUmol / 88.4) * 10) / 10;
const withoutNewColumns = r => { const {c3g_biopsy_date, c3g_if_c3_dominant, c3g_em_pattern, c3g_crescent_pct, c3g_paraprotein, height_cm, ...rest} = r; return rest; };

try {
  // ---- Production-like database at 0041 ------------------------------------------------
  const upTo41 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 41);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 41), [NEW_MIGRATION, '0043_biopsy_records.sql'],
    '0042 directly follows 0041; 0043 has its own acceptance (tests/biopsy-records-db.mjs)');
  for (const file of upTo41) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 10);
  for (const id of [owner, c3gOwner, editor, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic IgAN project','SYN','IGAN','igan',$2)", [igan, owner]);
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [igan, email[user], role])).r.status, 'added'));
  }
  const year = await thisYear();
  const today = await day(0), longAgo = await day(-400), recently = await day(-20);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'A-1','M',${year - 45},$2,95,'consented',$2,'V1'), ($1,'K-1','F',${year - 10},$2,50,'consented',$2,'V1')`, [igan, longAgo]));
  const adultBefore = await insertVisit(editor, igan, {patient_code: 'A-1', visit_date: await day(-30), scr_umol_l: 100, sbp: 120, dbp: 80});
  const childBefore = await insertVisit(editor, igan, {patient_code: 'K-1', visit_date: await day(-30), scr_umol_l: 50});
  assert.equal(adultBefore.egfr_formula_version, 'CKD-EPI-2021-Cr');
  assert.deepEqual([childBefore.egfr, childBefore.egfr_formula_version], [null, 'missing_inputs'], 'before 0042 a child has no eGFR');
  const legacyLab = await upsertLab(editor, igan, 'A-1', await day(-30), 'C3', 0.85, 'g/L');
  await as(editor, () => db.query(`INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail)
    VALUES($1,'A-1','custom',$2,'medical_record','synthetic legacy event')`, [igan, recently]));
  const snapshot = async () => ({
    baseline: (await rows('SELECT * FROM public.patients_baseline WHERE project_id=$1 ORDER BY patient_code', [igan])).map(withoutNewColumns),
    visits: (await rows('SELECT * FROM public.visits_long WHERE project_id=$1 ORDER BY patient_code', [igan])).map(withoutNewColumns),
    labs: await rows('SELECT * FROM public.labs_long WHERE project_id=$1', [igan]),
    events: await rows('SELECT * FROM public.events_long WHERE project_id=$1', [igan]),
    catalog: await rows('SELECT code,module,standard_unit FROM public.lab_test_catalog ORDER BY code'),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
  });
  const before = await snapshot();
  assert.ok(legacyLab);

  // ---- The reviewed increment ---------------------------------------------------------
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 11);
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 11);
  pass('0042 applies on a 0041 database and is safe to re-run');

  const after = await snapshot();
  assert.deepEqual({...after, catalog: null, audits: before.audits}, {...before, catalog: null});
  assert.deepEqual(after.catalog.filter(c => !before.catalog.some(b => b.code === c.code)).map(c => [c.code, c.module, c.standard_unit]),
    [['AH50', 'C3G', '%'], ['C3NEF', 'C3G', '%'], ['CFB', 'C3G', 'mg/L'], ['CFH', 'C3G', 'mg/L'], ['CFHAB', 'C3G', 'AU/mL'],
     ['CFI', 'C3G', 'mg/L'], ['CH50', 'C3G', 'U/mL'], ['SC5B9', 'C3G', 'ng/mL']]);
  assert.deepEqual(before.catalog, after.catalog.filter(c => before.catalog.some(b => b.code === c.code)), 'existing dictionary rows untouched (C3 and C4 stay in LN)');
  assert.deepEqual((await rows("SELECT patient_code,c3g_em_pattern,c3g_if_c3_dominant FROM public.patients_baseline WHERE project_id=$1 ORDER BY patient_code", [igan])).map(r => [r.c3g_em_pattern, r.c3g_if_c3_dominant]), [[null, null], [null, null]]);
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE height_cm IS NOT NULL'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.field_audit_log'), before.audits, 'the migration writes no audit rows');
  pass('existing patients, visits, labs, events and dictionary rows are byte-identical; new columns are empty');

  // ---- Dictionary is readable, still not writable, and the new units convert -------------
  await as(viewer, async () => {
    assert.equal(await count("SELECT count(*) AS n FROM public.lab_test_catalog WHERE module='C3G'"), 8);
    assert.equal(await count("SELECT count(*) AS n FROM public.lab_test_unit_map WHERE lab_test_code IN ('CFB','CFH')"), 5);
    await assert.rejects(db.query("INSERT INTO public.lab_test_catalog(code,name_cn,standard_unit) VALUES('X','x','g/L')"), e => e.code === '42501');
  });
  assert.deepEqual((await rows("SELECT abbr FROM public.abbreviation_dictionary WHERE abbr IN ('C3GN','DDD','CH50') ORDER BY abbr")).map(r => r.abbr), ['C3GN', 'CH50', 'DDD']);
  assert.equal((await row("SELECT domain FROM public.concept_dictionary WHERE code='c3g_em_pattern'")).domain, 'C3G');
  pass('lab dictionary gains module C3G (read-only for accounts); display dictionaries gain entries');

  // ---- A C3 glomerulopathy project ----------------------------------------------------
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic C3G project','SYN','C3G','c3g',$2)", [c3g, c3gOwner]);
  await as(c3gOwner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [c3g, email[editor], 'editor'])).r.status, 'added'));
  const base = {sex: 'F', birth_year: year - 12, baseline_date: await day(-200), baseline_scr: 60, consent_status: 'consented', consent_date: await day(-200), consent_version: 'V1'};
  const imported = await importRows(editor, 'baseline', [{patient_code: 'C-1', ...base, c3g_biopsy_date: await day(-210), c3g_if_c3_dominant: true, c3g_em_pattern: 'DDD', c3g_crescent_pct: 12.5, c3g_paraprotein: 'not_tested'}], c3g);
  assert.equal(imported.inserted, 1);
  const c1 = await row('SELECT * FROM public.patients_baseline WHERE project_id=$1 AND patient_code=$2', [c3g, 'C-1']);
  assert.deepEqual([c1.c3g_if_c3_dominant, c1.c3g_em_pattern, Number(c1.c3g_crescent_pct), c1.c3g_paraprotein, c1.c3g_biopsy_date], [true, 'DDD', 12.5, 'not_tested', await day(-210)]);
  // Baseline and visit imports report the 0038 validator's message as is (no row prefix).
  for (const [bad, message] of [[{c3g_em_pattern: 'MPGN'}, 'invalid_c3g_em_pattern'], [{c3g_crescent_pct: 120}, 'invalid_c3g_crescent_pct'],
      [{c3g_paraprotein: 'maybe'}, 'invalid_c3g_paraprotein'], [{c3g_if_c3_dominant: 'maybe'}, 'invalid_boolean: c3g_if_c3_dominant'],
      [{c3g_biopsy_date: '2026-13-01'}, 'invalid_iso_date: c3g_biopsy_date']]) {
    await assert.rejects(importRows(editor, 'baseline', [{patient_code: 'C-2', ...base, ...bad}], c3g), is(message));
  }
  assert.equal(await count('SELECT count(*) AS n FROM public.patients_baseline WHERE project_id=$1', [c3g]), 1);
  await as(editor, () => assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,c3g_em_pattern) VALUES($1,'C-3','M',2000,$2,'MPGN')", [c3g, today]), is(/c3g_em_pattern_check/)));
  const corrected = await correct(editor, c3g, 'patients_baseline', c1.id, {c3g_em_pattern: 'C3GN', c3g_crescent_pct: 20}, '病理科复核电镜报告');
  assert.deepEqual([corrected.changed, corrected.record.c3g_em_pattern, Number(corrected.record.c3g_crescent_pct)], [true, 'C3GN', 20]);
  await assert.rejects(correct(editor, c3g, 'patients_baseline', c1.id, {c3g_em_pattern: 'MPGN'}, '测试：无效值应被拒绝'), is('invalid_c3g_em_pattern'));
  assert.deepEqual((await rows("SELECT field_name,old_value,new_value FROM public.field_audit_log WHERE record_id=$1 AND field_name LIKE 'c3g_%' ORDER BY field_name", [c1.id])).map(r => [r.field_name, r.old_value, r.new_value]),
    [['c3g_crescent_pct', '12.5', '20'], ['c3g_em_pattern', 'DDD', 'C3GN']]);
  pass('C3G pathology fields: import with validation, table constraints, audited correction');

  // ---- Complement tests through the dictionary ------------------------------------------
  const cfb = await upsertLab(editor, c3g, 'C-1', await day(-100), 'CFB', 0.25, 'g/L');
  const cfbRow = await row('SELECT value_raw,unit_symbol,value_standard,standard_unit FROM public.labs_long WHERE id=$1', [cfb]);
  assert.deepEqual([Number(cfbRow.value_raw), cfbRow.unit_symbol, Number(cfbRow.value_standard), cfbRow.standard_unit], [0.25, 'g/L', 250, 'mg/L']);
  await assert.rejects(upsertLab(editor, c3g, 'C-1', await day(-100), 'SC5B9', 300, 'g/L'), is(/unit_not_allowed/));
  assert.equal((await importRows(editor, 'labs', [{patient_code: 'C-1', lab_date: await day(-100), lab_test_code: 'C3NEF', result_text: '阳性'},
    {patient_code: 'C-1', lab_date: await day(-100), lab_test_code: 'CH50', value_raw: '18', unit_symbol: 'U/mL'}], c3g)).inserted, 2);
  assert.deepEqual((await rows("SELECT lab_test_code,result_text,value_standard FROM public.labs_long WHERE project_id=$1 AND lab_test_code IN ('C3NEF','CH50') ORDER BY lab_test_code", [c3g])).map(r => [r.lab_test_code, r.result_text, r.value_standard === null ? null : Number(r.value_standard)]),
    [['C3NEF', '阳性', null], ['CH50', null, 18]]);
  pass('complement tests: unit conversion, refused units, qualitative results, import');

  // ---- Height and paediatric eGFR ------------------------------------------------------
  const child = await insertVisit(editor, c3g, {patient_code: 'C-1', visit_date: await day(-60), scr_umol_l: 60, height_cm: 145});
  assert.deepEqual([Number(child.egfr), child.egfr_formula_version, Number((await row('SELECT height_cm FROM public.visits_long WHERE id=$1', [child.id])).height_cm)], [schwartz(145, 60), 'Schwartz-2009-bedside', 145]);
  const childNoHeight = await insertVisit(editor, c3g, {patient_code: 'C-1', visit_date: await day(-30), scr_umol_l: 60});
  assert.deepEqual([childNoHeight.egfr, childNoHeight.egfr_formula_version], [null, 'missing_inputs']);
  const fixed = await correct(editor, c3g, 'visits_long', childNoHeight.id, {height_cm: 146}, '补录当日身高');
  assert.deepEqual([fixed.changed, Number(fixed.record.egfr), fixed.record.egfr_formula_version], [true, schwartz(146, 60), 'Schwartz-2009-bedside']);
  await assert.rejects(correct(editor, c3g, 'visits_long', childNoHeight.id, {height_cm: 20}, '测试：无效值应被拒绝'), is('invalid_height_cm'));
  await as(editor, () => assert.rejects(db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,scr_umol_l,height_cm) VALUES($1,'C-1',$2,60,20)", [c3g, today]), is(/visits_height_range/)));
  const adult = await insertVisit(editor, igan, {patient_code: 'A-1', visit_date: await day(-10), scr_umol_l: 100, height_cm: 175});
  assert.deepEqual([adult.egfr, adult.egfr_formula_version], [adultBefore.egfr, 'CKD-EPI-2021-Cr'], 'adults are computed exactly as before, height or not');
  const legacyChild = await visit(igan, 'K-1');
  assert.deepEqual([legacyChild.egfr, legacyChild.egfr_formula_version], [null, 'missing_inputs'], 'a historical child visit stays as it was until a height is recorded');
  const viaImport = await importRows(editor, 'visits', [{patient_code: 'K-1', visit_date: await day(-5), scr_umol_l: '50', height_cm: '140'}], igan);
  assert.equal(viaImport.inserted, 1);
  const importedVisit = await visit(igan, 'K-1');
  assert.deepEqual([Number(importedVisit.egfr), importedVisit.egfr_formula_version], [schwartz(140, 50), 'Schwartz-2009-bedside']);
  await assert.rejects(importRows(editor, 'visits', [{patient_code: 'K-1', visit_date: await day(-4), scr_umol_l: '50', height_cm: '300'}], igan), is('invalid_height_cm'));
  const manual = await insertVisit(editor, igan, {patient_code: 'K-1', visit_date: await day(-3), scr_umol_l: 50, height_cm: 140, egfr: 88, egfr_formula_version: 'manual'});
  assert.deepEqual([Number(manual.egfr), manual.egfr_formula_version], [88, 'manual'], 'an explicitly manual eGFR is kept');
  pass('height: children get bedside Schwartz 2009 when a height is recorded (entry, import, correction); adults unchanged');

  // ---- Safety events --------------------------------------------------------------------
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'C-1', event_type: 'vaccination', event_date: await day(-90), evidence_source: 'medical_record'}], c3g), is('row_1_event_detail_required'));
  assert.equal((await importRows(editor, 'events', [
    {patient_code: 'C-1', event_type: 'vaccination', event_date: await day(-90), evidence_source: 'medical_record', event_detail: '四价脑膜炎球菌结合疫苗'},
    {patient_code: 'C-1', event_type: 'serious_infection', event_date: await day(-40), evidence_source: 'medical_record', event_detail: '肺炎，静脉抗生素治疗'},
    {patient_code: 'C-1', event_type: 'hospitalization', event_date: await day(-40), evidence_source: 'medical_record', event_detail: '肺炎住院 6 天'}], c3g)).inserted, 3);
  await as(editor, async () => {
    await db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail) VALUES($1,'C-1','serious_infection',$2,'medical_record','synthetic')", [c3g, today]);
    await assert.rejects(db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail) VALUES($1,'C-1','adverse_reaction',$2,'medical_record','x')", [c3g, today]), is(/events_long_event_type_check/));
  });
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'C-1', event_type: 'egfr_decline_40pct', event_date: await day(-1), evidence_source: 'lab_review', event_detail: 'x'}], c3g), is('row_1_derived_endpoint_not_importable'));
  assert.deepEqual((await rows('SELECT event_type,count(*)::int AS n FROM public.events_long WHERE project_id=$1 GROUP BY event_type ORDER BY event_type', [c3g])).map(r => [r.event_type, r.n]),
    [['hospitalization', 1], ['serious_infection', 2], ['vaccination', 1]]);
  pass('events: serious infection, hospitalization and vaccination are recorded with details; derived endpoints still refused');

  // ---- Membership boundaries unchanged ----------------------------------------------------
  // A read-only member's direct write is refused before anything is stored (the research-date
  // trigger cannot even see the patient under RLS, or RLS denies the row); nothing changes.
  const iganVisits = await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1', [igan]);
  await as(viewer, () => assert.rejects(db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,scr_umol_l,height_cm) VALUES($1,'A-1',$2,100,170)", [igan, today]), e => e.code === '42501' || e.message === 'patient_not_found'));
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1', [igan]), iganVisits);
  const visitsBefore = await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1', [c3g]);
  await assert.rejects(importRows(outsider, 'visits', [{patient_code: 'C-1', visit_date: today, scr_umol_l: '60', height_cm: '146'}], c3g));
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1', [c3g]), visitsBefore);
  pass('read-only members and outsiders cannot write through the new columns');

  console.log(`C3G_MODULE_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
