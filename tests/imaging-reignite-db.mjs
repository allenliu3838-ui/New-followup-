// Native PG17 acceptance for 0047 (kidney imaging records, total bilirubin) and 0048 (IgA
// nephropathy second batch for REIGNITE: event types, length of stay, visit weight, laboratory
// tests). The database is first built to 0046 and filled the way a v8 database can look; both
// increments must apply, be safe to re-run and leave every stored value as it was. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic imaging and REIGNITE acceptance accepts no external input');
const NEW_MIGRATIONS = ['0047_imaging_records.sql', '0048_reignite_batch2.sql'];
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

const [owner, editor, analyst, viewer, outsider] = Array.from({length: 5}, () => randomUUID());
const email = {[owner]: 'im-owner@example.invalid', [editor]: 'im-editor@example.invalid', [analyst]: 'im-analyst@example.invalid',
  [viewer]: 'im-viewer@example.invalid', [outsider]: 'im-outsider@example.invalid'};
const pid = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const importRows = (user, kind, list, batch = randomUUID()) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const undo = (user, batch, reason) => as(user, async () =>
  (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [pid, batch, reason])).r);
const insertImaging = (user, values) => as(user, () => {
  const keys = Object.keys(values);
  return row(`INSERT INTO public.imaging_long(project_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [pid, ...keys.map(k => values[k])]);
});
const imaging = code => rows('SELECT * FROM public.imaging_long WHERE project_id=$1 AND patient_code=$2 ORDER BY exam_date,modality', [pid, code]);
// Ellipsoid volume of both kidneys, as the database computes it.
const tkv = (l1, w1, d1, l2, w2, d2) => Math.round(Math.PI / 6 * (l1 * w1 * d1 + l2 * w2 * d2) * 10) / 10;
const NEW_EVENTS = ['er_visit', 'icu_admission', 'infection', 'venous_thromboembolism', 'cardiovascular_event', 'malignancy',
  'osteoporosis', 'fracture', 'avascular_necrosis', 'new_diabetes', 'hypertension_new_or_worse', 'pregnancy'];
const DETAIL_REQUIRED = ['er_visit', 'icu_admission', 'infection', 'cardiovascular_event', 'malignancy', 'fracture', 'pregnancy'];
const NEW_LABS = ['IGG', 'IGM', 'GDIGA1', 'NEUT', 'LYMPH', 'MONO', 'EOS', 'BASO', 'UTP24', 'UALB24', 'UCREA24', 'ANA', 'MPO_ANCA',
  'PR3_ANCA', 'ANTI_GBM', 'HBSAG', 'HCV_AB', 'HIV_AB', 'RPR', 'TP_AB'];

try {
  // ---- A v8 database at 0046 -------------------------------------------------------------
  const upTo46 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 46);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 46), NEW_MIGRATIONS,
    'the two reviewed increments directly follow 0046');
  for (const file of upTo46) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 15);
  for (const id of [owner, editor, analyst, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic ADPKD project','SYN','ADPKD','general',$2)", [pid, owner]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [pid, email[user], role])).r.status, 'added'));
  }
  const year = await thisYear();
  const today = await day(0), longAgo = await day(-400), d30 = await day(-30), d60 = await day(-60);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'P-1','M',${year - 45},$2,95,'consented',$2,'V1'), ($1,'P-2','F',${year - 30},$2,70,'consented',$2,'V1')`, [pid, longAgo]));
  await as(editor, async () => {
    await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,scr_umol_l,sbp,dbp,height_cm) VALUES($1,'P-1',$2,100,120,80,172)", [pid, d30]);
    await db.query(`INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail)
      VALUES($1,'P-1','hospitalization',$2,'medical_record','肺炎住院')`, [pid, d60]);
  });
  assert.equal((await importRows(editor, 'labs', [{patient_code: 'P-1', lab_date: d30, lab_test_code: 'CREAT', value_raw: '100', unit_symbol: 'μmol/L'}])).inserted, 1);

  const snapshot = async () => ({
    baseline: await rows('SELECT * FROM public.patients_baseline WHERE project_id=$1 ORDER BY patient_code', [pid]),
    visits: (await rows('SELECT * FROM public.visits_long WHERE project_id=$1 ORDER BY id', [pid])).map(({weight_kg, ...v}) => v),
    labs: await rows('SELECT * FROM public.labs_long WHERE project_id=$1 ORDER BY id', [pid]),
    events: (await rows('SELECT * FROM public.events_long WHERE project_id=$1 ORDER BY id', [pid])).map(({los_days, ...e}) => e),
    imports: await rows('SELECT * FROM public.registry_import_records WHERE project_id=$1 ORDER BY record_id', [pid]),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
  });
  const before = await snapshot();
  for (const file of NEW_MIGRATIONS) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 17);
  for (const file of NEW_MIGRATIONS) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 17);
  assert.deepEqual(await snapshot(), before, 'existing clinical rows, import links and audit rows are unchanged');
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE weight_kg IS NOT NULL'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.events_long WHERE los_days IS NOT NULL'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM public.imaging_long'), 0);
  pass('0047 and 0048 apply on a 0046 database, are safe to re-run and change no stored value');

  // ---- Imaging records: entry, total kidney volume, rules, audit ---------------------------
  const ct = await insertImaging(editor, {patient_code: 'P-1', exam_date: longAgo, modality: 'ct', left_length_cm: 18.2, left_width_cm: 9.1,
    left_depth_cm: 8.4, right_length_cm: 17.5, right_width_cm: 8.8, right_depth_cm: 8.0, liver_cysts: 'present', mayo_image_class: 'typical', notes: '平扫 CT'});
  assert.equal(Number(ct.tkv_ml), tkv(18.2, 9.1, 8.4, 17.5, 8.8, 8.0));
  assert.deepEqual([ct.liver_cysts, ct.mayo_image_class, ct.created_by], ['present', 'typical', editor]);
  const us = await insertImaging(editor, {patient_code: 'P-1', exam_date: d30, modality: 'ultrasound', left_length_cm: 18.9, right_length_cm: 18.0});
  assert.equal(us.tkv_ml, null, 'no volume without all six diameters');
  await as(editor, () => assert.rejects(db.query('UPDATE public.imaging_long SET tkv_ml=1 WHERE id=$1', [ct.id]), e => e.code === '428C9'));
  const refuse = async (values, expected) => assert.rejects(insertImaging(editor, {patient_code: 'P-2', exam_date: await day(-50), modality: 'mri', left_length_cm: 12, ...values}), expected);
  await refuse({modality: 'pet'}, is(/imaging_long_modality_check/));
  await refuse({left_length_cm: 0}, is(/imaging_long_left_length_range/));
  await refuse({right_depth_cm: 40.5}, is(/imaging_long_right_depth_range/));
  await refuse({liver_cysts: 'yes'}, is(/imaging_long_liver_cysts_check/));
  await refuse({mayo_image_class: '1A'}, is(/imaging_long_mayo_class_check/));
  await refuse({modality: 'ultrasound', mayo_image_class: 'typical'}, is(/imaging_long_mayo_class_modality/));
  await refuse({left_length_cm: null}, is(/imaging_long_has_measurement/));
  await refuse({exam_date: await day(1)}, is('future_exam_date'));
  await refuse({exam_date: '1899-12-31'}, is(/imaging_long_date_floor/));
  await refuse({notes: ''}, is(/imaging_long_notes_length/));
  await refuse({notes: '联系电话 13812345678'}, is('pii_detected_blocked'));
  await assert.rejects(insertImaging(editor, {patient_code: 'NOPE', exam_date: today, modality: 'mri', left_length_cm: 12}), e => e.code === '23503');
  await assert.rejects(insertImaging(editor, {patient_code: 'P-1', exam_date: longAgo, modality: 'ct', left_length_cm: 12}), e => e.code === '23505' && /imaging_long_business_key/.test(e.message));
  const liverOnly = await insertImaging(editor, {patient_code: 'P-2', exam_date: today, modality: 'mri', liver_cysts: 'absent'});
  pass('imaging records: one row per date and modality, TKV computed by the ellipsoid formula and never typed, ranges, Mayo class only on CT or MRI, no future date, PII guard, patient must exist');

  await as(editor, async () => {
    await db.query('UPDATE public.imaging_long SET left_length_cm=18.4 WHERE id=$1', [ct.id]);
    await assert.rejects(db.query("UPDATE public.imaging_long SET patient_code='P-2' WHERE id=$1", [ct.id]), is('clinical_identity_is_immutable'));
    await db.query('DELETE FROM public.imaging_long WHERE id=$1', [liverOnly.id]);
  });
  const recomputed = await row('SELECT tkv_ml,updated_by FROM public.imaging_long WHERE id=$1', [ct.id]);
  assert.deepEqual([Number(recomputed.tkv_ml), recomputed.updated_by], [tkv(18.4, 9.1, 8.4, 17.5, 8.8, 8.0), editor]);
  const audit = await rows("SELECT field_name,old_value,new_value,changed_by,table_name FROM public.field_audit_log WHERE record_id IN ($1,$2) ORDER BY changed_at,field_name", [ct.id, liverOnly.id]);
  assert.deepEqual(audit.filter(a => a.field_name === 'left_length_cm').map(a => [a.table_name, a.old_value, a.new_value, a.changed_by]),
    [['imaging_long', '18.2', '18.4', editor]]);
  const deleted = audit.find(a => a.field_name === '__record_deleted__');
  assert.ok(deleted && /^[0-9a-f]{64}$/.test(deleted.old_value) && deleted.changed_by === editor, 'a deletion is audited and keeps only the record fingerprint');
  pass('corrections recompute TKV and are field-audited; a wrong record may be deleted and the deletion is audited; identity is immutable');

  await as(viewer, async () => {
    assert.equal(await count('SELECT count(*) AS n FROM public.imaging_long'), 2);
    await assert.rejects(db.query("INSERT INTO public.imaging_long(project_id,patient_code,exam_date,modality,left_length_cm) VALUES($1,'P-2',$2,'mri',12)", [pid, today]), e => e.code === '42501');
    assert.equal((await db.query('DELETE FROM public.imaging_long')).rowCount, 0);
  });
  await as(outsider, async () => assert.equal(await count('SELECT count(*) AS n FROM public.imaging_long'), 0));
  await as(null, async () => assert.equal(await count('SELECT count(*) AS n FROM public.imaging_long'), 0));
  await as(editor, async () => assert.rejects(db.query('TRUNCATE public.imaging_long'), e => e.code === '42501'));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  await assert.rejects(insertImaging(editor, {patient_code: 'P-2', exam_date: today, modality: 'mri', left_length_cm: 12}), is('subscription_required'));
  await as(editor, async () => assert.rejects(db.query('DELETE FROM public.imaging_long WHERE id=$1', [ct.id]), is('subscription_required')));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()+interval '30 days' WHERE user_id=$1", [owner]);
  pass('members read, viewers cannot write, outsiders see nothing, nobody truncates; the read-only lock covers imaging records');

  // ---- Imaging import and undo -------------------------------------------------------------
  const batch = randomUUID();
  const p2 = [{patient_code: 'P-2', exam_date: await day(-300), modality: 'mri', left_length_cm: '16', left_width_cm: '8', left_depth_cm: '7.5',
      right_length_cm: '15.5', right_width_cm: 8, right_depth_cm: '7', liver_cysts: 'present', mayo_image_class: 'atypical'},
    {patient_code: 'P-2', exam_date: await day(-20), modality: 'ultrasound', left_length_cm: '16.8', right_length_cm: '16.1', notes: '复查超声'}];
  assert.deepEqual(await importRows(editor, 'imaging', p2, batch), {inserted: 2, updated: 0, skipped: 0, total: 2, replayed: false});
  const imported = await imaging('P-2');
  assert.deepEqual(imported.map(i => [i.exam_date, i.modality, i.tkv_ml === null ? null : Number(i.tkv_ml), i.mayo_image_class]),
    [[await day(-300), 'mri', tkv(16, 8, 7.5, 15.5, 8, 7), 'atypical'], [await day(-20), 'ultrasound', null, null]]);
  const again = randomUUID();
  assert.deepEqual(await importRows(editor, 'imaging', p2, again), {inserted: 0, updated: 0, skipped: 2, total: 2, replayed: false}, 'identical rows are skipped');
  const bad = async (values, expected) => assert.rejects(importRows(editor, 'imaging', [{patient_code: 'P-2', exam_date: await day(-200), modality: 'ct', left_length_cm: '12', ...values}]), is(expected));
  await assert.rejects(importRows(editor, 'imaging', [{...p2[1], left_length_cm: '17'}]), is('row_1_same_key_record_conflict'));
  await bad({modality: 'ultrasound', mayo_image_class: 'typical'}, 'row_1_mayo_class_requires_ct_or_mri');
  await bad({left_length_cm: null}, 'row_1_imaging_measurement_required');
  await bad({left_length_cm: '41'}, 'row_1_number_out_of_range: left_length_cm');
  await bad({left_length_cm: '12 cm'}, 'row_1_invalid_number: left_length_cm');
  await bad({modality: 'pet'}, 'row_1_invalid_imaging_modality');
  await bad({modality: null}, 'row_1_imaging_modality_required');
  await bad({liver_cysts: '有'}, 'row_1_invalid_liver_cysts');
  await bad({mayo_image_class: '1C'}, 'row_1_invalid_mayo_image_class');
  await bad({exam_date: await day(1)}, 'row_1_invalid_or_future_date: exam_date');
  await bad({tkv_ml: '900'}, 'row_1_unsupported_column: tkv_ml');
  await bad({notes: '联系电话13812345678'}, 'row_1_pii_detected_blocked: notes');
  await assert.rejects(importRows(editor, 'imaging', [{patient_code: 'NOPE', exam_date: today, modality: 'ct', left_length_cm: '12'}]), is('row_1_patient_not_registered'));
  await assert.rejects(importRows(viewer, 'imaging', [{patient_code: 'P-2', exam_date: today, modality: 'ct', left_length_cm: '12'}]));
  assert.equal((await imaging('P-2')).length, 2, 'refused batches write nothing');
  const kept = await undo(editor, batch, '核对后撤销影像导入');
  assert.deepEqual([kept.deleted, kept.kept_referenced], [0, 2]);
  assert.equal((await undo(editor, again, '撤销重复导入批次')).deleted, 2, 'undoing the later batch releases the records of the earlier undone batch');
  assert.equal((await imaging('P-2')).length, 0);
  assert.equal((await importRows(editor, 'imaging', p2)).inserted, 2, 'after an undo the same rows import again');
  pass('imaging import: business key, identical rows skipped, rule violations name the row, TKV cannot be imported, undo deletes only that batch');

  // ---- Total bilirubin (0047) and the REIGNITE laboratory tests (0048) --------------------
  const labs = [
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'TBIL', value_raw: '1', unit_symbol: 'mg/dL'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'IGG', value_raw: '1200', unit_symbol: 'mg/dL'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'UTP24', value_raw: '850', unit_symbol: 'mg/24h'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'UCREA24', value_raw: '1000', unit_symbol: 'mg/24h'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'NEUT', value_raw: '4.2', unit_symbol: '10^9/L'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'GDIGA1', value_raw: '5.1', unit_symbol: 'μg/mL', notes: 'KM55 法'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'HBSAG', result_text: '阴性'},
    {patient_code: 'P-1', lab_date: d30, lab_test_code: 'ANA', result_text: '阳性 1:320 颗粒型'},
  ];
  assert.equal((await importRows(editor, 'labs', labs)).inserted, labs.length);
  const stored = Object.fromEntries((await rows("SELECT lab_test_code,value_standard,standard_unit,normalization_status FROM public.labs_long WHERE project_id=$1 AND lab_date=$2", [pid, d30]))
    .map(r => [r.lab_test_code, [r.value_standard === null ? null : Number(r.value_standard), r.standard_unit, r.normalization_status]]));
  assert.deepEqual(stored.TBIL.slice(0, 2), [17.104, 'μmol/L']);
  assert.deepEqual(stored.IGG.slice(0, 2), [12, 'g/L']);
  assert.deepEqual(stored.UTP24.slice(0, 2), [0.85, 'g/24h']);
  assert.ok(Math.abs(stored.UCREA24[0] - 8.842) < 1e-9 && stored.UCREA24[1] === 'mmol/24h');
  assert.deepEqual([stored.HBSAG[0], stored.HBSAG[2]], [null, 'qualitative']);
  assert.deepEqual([stored.ANA[0], stored.ANA[2]], [null, 'qualitative']);
  await assert.rejects(importRows(editor, 'labs', [{patient_code: 'P-2', lab_date: d30, lab_test_code: 'HIV_AB', value_raw: '0.2', unit_symbol: 'g/L'}]), is('row_1_unit_not_allowed: unit_symbol'));
  await assert.rejects(importRows(editor, 'labs', [{patient_code: 'P-2', lab_date: d30, lab_test_code: 'GDIGA1', value_raw: '5', unit_symbol: 'U/mL'}]), is(/row_1_/));
  assert.equal(await count('SELECT count(*) AS n FROM public.lab_test_catalog WHERE code = ANY($1)', [NEW_LABS]), NEW_LABS.length);
  pass('total bilirubin converts mg/dL to μmol/L; IgG, 24-hour urine and differential counts convert to their standard units; serologies are qualitative only');

  // ---- Event types and length of stay (0048) ----------------------------------------------
  const events = NEW_EVENTS.map((event_type, i) => ({patient_code: 'P-2', event_type, event_date: d60, evidence_source: 'medical_record',
    ...(DETAIL_REQUIRED.includes(event_type) ? {event_detail: `合成说明 ${i + 1}`} : {})}));
  events[1].los_days = '5';
  assert.equal((await importRows(editor, 'events', events)).inserted, NEW_EVENTS.length);
  assert.equal(Number((await row("SELECT los_days FROM public.events_long WHERE project_id=$1 AND event_type='icu_admission'", [pid])).los_days), 5);
  for (const t of DETAIL_REQUIRED) {
    await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-1', event_type: t, event_date: today, evidence_source: 'medical_record'}]), is('row_1_event_detail_required'));
  }
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-1', event_type: 'fracture', event_date: today, evidence_source: 'medical_record', event_detail: '桡骨', los_days: '3'}]), is('row_1_los_days_not_applicable'));
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-1', event_type: 'hospitalization', event_date: today, evidence_source: 'medical_record', event_detail: '感染', los_days: '2.5'}]), is('row_1_integer_required: los_days'));
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-1', event_type: 'hospitalization', event_date: today, evidence_source: 'medical_record', event_detail: '感染', los_days: '4000'}]), is('row_1_number_out_of_range: los_days'));
  assert.equal((await importRows(editor, 'events', [{patient_code: 'P-1', event_type: 'hospitalization', event_date: today, evidence_source: 'medical_record', event_detail: '肺炎', los_days: '7'}])).inserted, 1);
  await as(editor, async () => {
    await assert.rejects(db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,los_days) VALUES($1,'P-1','new_diabetes',$2,'medical_record',3)", [pid, today]), is(/events_long_los_days_check/));
    await assert.rejects(db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source) VALUES($1,'P-1','bleeding',$2,'medical_record')", [pid, today]), is(/events_long_event_type_check/));
    await db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail,los_days) VALUES($1,'P-2','hospitalization',$2,'medical_record','肾活检',2)", [pid, today]);
  });
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-1', event_type: 'egfr_decline_40pct', event_date: today, evidence_source: 'lab_review'}]), is('row_1_derived_endpoint_not_importable'));
  pass('twelve REIGNITE event types import and insert; seven require a description; length of stay only for hospitalization and ICU, whole days 0–3650; derived endpoints still refused');

  // ---- Visit weight (0048) ---------------------------------------------------------------
  assert.equal((await importRows(editor, 'visits', [{patient_code: 'P-2', visit_date: d30, scr_umol_l: '80', weight_kg: '58.5', height_cm: '160'}])).inserted, 1);
  assert.equal(Number((await row("SELECT weight_kg FROM public.visits_long WHERE project_id=$1 AND patient_code='P-2'", [pid])).weight_kg), 58.5);
  await assert.rejects(importRows(editor, 'visits', [{patient_code: 'P-2', visit_date: d60, scr_umol_l: '80', weight_kg: '0.5'}]), is('invalid_weight_kg'));
  await as(editor, () => assert.rejects(db.query("UPDATE public.visits_long SET weight_kg=400 WHERE project_id=$1", [pid]), is(/visits_long_weight_kg_check/)));
  pass('visits record weight (1–300 kg) by entry and import');

  // ---- Frozen export -----------------------------------------------------------------------
  const exported = await as(analyst, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [pid, randomUUID()])).e);
  assert.equal(createHash('sha256').update(exported.content_text, 'utf8').digest('hex'), exported.content_sha256);
  const content = JSON.parse(exported.content_text);
  assert.ok(Object.keys(content.tables).includes('imaging_long'));
  assert.deepEqual(content.tables.imaging_long.map(i => [i.patient_code, i.modality]).sort(), [['P-1', 'ct'], ['P-1', 'ultrasound'], ['P-2', 'mri'], ['P-2', 'ultrasound']]);
  assert.equal(Number(content.tables.imaging_long.find(i => i.modality === 'ct').tkv_ml), tkv(18.4, 9.1, 8.4, 17.5, 8.8, 8.0));
  for (const k of ['modality', 'tkv_ml', 'mayo_image_class', 'liver_cysts']) assert.ok(content.field_notes[k], `field note ${k}`);
  assert.equal(content.tables.visits_long.find(v => v.patient_code === 'P-2').weight_kg, 58.5);
  assert.equal(content.tables.events_long.find(e => e.event_type === 'icu_admission').los_days, 5);
  pass('frozen export carries imaging records with TKV and field notes, visit weight and length of stay');

  console.log(`IMAGING_REIGNITE_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
