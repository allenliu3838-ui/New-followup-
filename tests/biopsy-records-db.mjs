// Native PG17 acceptance for 0043 (kidney biopsy records, six medication classes, vaccinations
// recorded as medications, biopsy batch import and undo, frozen export). The database is first
// built to 0042 and filled the way a v7 database can look (an IgAN project with patients,
// visits, labs, medications and events, including a vaccination event); 0043 must stop while
// that event is stored, and once it has been re-recorded as a medication, apply as the reviewed
// increment and leave every stored value as it was. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic biopsy records acceptance accepts no external input');
const NEW_MIGRATION = '0043_biopsy_records.sql';
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
const email = {[owner]: 'bx-owner@example.invalid', [editor]: 'bx-editor@example.invalid', [analyst]: 'bx-analyst@example.invalid',
  [viewer]: 'bx-viewer@example.invalid', [outsider]: 'bx-outsider@example.invalid'};
const igan = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const importRows = (user, kind, list, pid = igan, batch = randomUUID()) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const undo = (user, batch, reason) => as(user, async () =>
  (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [igan, batch, reason])).r);
const insertBiopsy = (user, values) => as(user, () => {
  const keys = Object.keys(values);
  return row(`INSERT INTO public.biopsies_long(project_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [igan, ...keys.map(k => values[k])]);
});
const biopsies = code => rows('SELECT * FROM public.biopsies_long WHERE project_id=$1 AND patient_code=$2 ORDER BY biopsy_date,biopsy_kind', [igan, code]);
const NEW_CLASSES = ['内皮素受体拮抗剂', '补体抑制剂', '盐皮质激素受体拮抗剂', '预防性抗生素', '试验药物', '疫苗'];

try {
  // ---- A v7 database at 0042 -------------------------------------------------------------
  const upTo42 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 42);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 42), [NEW_MIGRATION, '0044_project_fields.sql', '0045_cystatin_urine_rbc.sql', '0046_adpkd_module.sql'],
    'the reviewed increment directly follows 0042 (0044 has its own acceptance, tests/project-fields-db.mjs)');
  for (const file of upTo42) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 11);
  for (const id of [owner, editor, analyst, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic IgAN project','SYN','IGAN','igan',$2)", [igan, owner]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [igan, email[user], role])).r.status, 'added'));
  }
  const year = await thisYear();
  const today = await day(0), longAgo = await day(-400), d30 = await day(-30), d60 = await day(-60);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,biopsy_date,oxford_m,oxford_c,consent_status,consent_date,consent_version)
    VALUES ($1,'P-1','M',${year - 45},$2,95,$2,1,1,'consented',$2,'V1'), ($1,'P-2','F',${year - 30},$2,70,NULL,NULL,NULL,'consented',$2,'V1')`, [igan, longAgo]));
  await as(editor, async () => {
    await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,scr_umol_l,sbp,dbp) VALUES($1,'P-1',$2,100,120,80)", [igan, d30]);
    await db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,start_date) VALUES($1,'P-1','缬沙坦','RAS阻断剂',$2)", [igan, longAgo]);
    await db.query(`INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail)
      VALUES($1,'P-1','serious_infection',$2,'medical_record','肺炎'),($1,'P-2','vaccination',$2,'medical_record','四价脑膜炎球菌结合疫苗')`, [igan, d60]);
  });
  assert.equal((await importRows(editor, 'labs', [{patient_code: 'P-1', lab_date: await day(-30), lab_test_code: 'CREAT', value_raw: '100', unit_symbol: 'μmol/L'}])).inserted, 1);

  // ---- A stored vaccination event stops the increment; nothing is applied ------------------
  await assert.rejects(apply(NEW_MIGRATION), is(/迁移 0043 已中止：已有事件类型为 vaccination/));
  await db.exec('ROLLBACK'); // as psql -v ON_ERROR_STOP=1 does when it exits: the whole increment is undone
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 11);
  assert.equal((await row("SELECT to_regclass('public.biopsies_long') AS t")).t, null, 'the refused increment left no table behind');
  // A person re-records it as a medication (allowed classes at 0042) and removes the event.
  await as(editor, async () => {
    await db.query("INSERT INTO public.meds_long(project_id,patient_code,drug_name,drug_class,route,start_date,notes) VALUES($1,'P-2','四价脑膜炎球菌结合疫苗','其他','IM',$2,'由疫苗接种事件改登')", [igan, d60]);
    await db.query("DELETE FROM public.events_long WHERE project_id=$1 AND event_type='vaccination'", [igan]);
  });

  const snapshot = async () => ({
    baseline: await rows('SELECT * FROM public.patients_baseline WHERE project_id=$1 ORDER BY patient_code', [igan]),
    visits: await rows('SELECT * FROM public.visits_long WHERE project_id=$1 ORDER BY id', [igan]),
    labs: await rows('SELECT * FROM public.labs_long WHERE project_id=$1 ORDER BY id', [igan]),
    meds: await rows('SELECT * FROM public.meds_long WHERE project_id=$1 ORDER BY id', [igan]),
    events: await rows('SELECT * FROM public.events_long WHERE project_id=$1 ORDER BY id', [igan]),
    imports: await rows('SELECT * FROM public.registry_import_records WHERE project_id=$1 ORDER BY record_id', [igan]),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
    catalog: await count('SELECT count(*) AS n FROM public.lab_test_catalog'),
  });
  const before = await snapshot();
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 12);
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 12);
  assert.deepEqual(await snapshot(), before, 'existing clinical rows, import links, audit rows and the lab dictionary are unchanged');
  assert.equal(await count('SELECT count(*) AS n FROM public.biopsies_long'), 0, 'no biopsy rows are derived from baselines');
  pass('0043 stops while a vaccination event is stored, then applies on a 0042 database, is safe to re-run and changes no stored value');

  // ---- Biopsy records: entry, rules, audit -------------------------------------------------
  const first = await insertBiopsy(editor, {patient_code: 'P-1', biopsy_date: longAgo, biopsy_kind: 'native', is_index: true,
    glomeruli_total: 24, crescent_pct: 12.5, oxford_m: 1, oxford_e: 0, oxford_s: 1, oxford_t: 1, oxford_c: 1, notes: '确诊活检'});
  assert.deepEqual([first.is_index, first.glomeruli_total, Number(first.crescent_pct), first.oxford_c, first.created_by], [true, 24, 12.5, 1, editor]);
  const repeat = await insertBiopsy(editor, {patient_code: 'P-1', biopsy_date: await day(-100), biopsy_kind: 'transplant', crescent_pct: 0, oxford_c: 0});
  assert.equal(repeat.is_index, false, 'a biopsy is not the index biopsy unless marked');
  const refuse = async (values, expected) => assert.rejects(insertBiopsy(editor, {patient_code: 'P-1', biopsy_date: await day(-50), biopsy_kind: 'native', ...values}), expected);
  await refuse({biopsy_kind: 'other'}, is(/biopsies_long_kind_check/));
  await refuse({crescent_pct: 120}, is(/biopsies_long_crescent_range/));
  await refuse({glomeruli_total: 1000}, is(/biopsies_long_glomeruli_range/));
  await refuse({oxford_t: 3}, is(/biopsies_long_oxford_t_check/));
  await refuse({oxford_e: 2}, is(/biopsies_long_oxford_e_check/));
  for (const [c, pct] of [[0, 5], [1, 0], [1, 25], [2, 24.9]]) await refuse({oxford_c: c, crescent_pct: pct}, is(/biopsies_long_oxford_c_crescents/));
  await refuse({is_index: true}, e => e.code === '23505' && /biopsies_long_one_index_per_patient/.test(e.message));
  await assert.rejects(insertBiopsy(editor, {patient_code: 'P-1', biopsy_date: longAgo, biopsy_kind: 'native'}), e => e.code === '23505' && /biopsies_long_business_key/.test(e.message));
  await refuse({biopsy_date: await day(1)}, is('future_biopsy_date'));
  await refuse({biopsy_date: '1899-12-31'}, is(/biopsies_long_date_floor/));
  await refuse({notes: ''}, is(/biopsies_long_notes_length/));
  await refuse({notes: '联系电话 13812345678'}, is('pii_detected_blocked'));
  await assert.rejects(insertBiopsy(editor, {patient_code: 'NOPE', biopsy_date: await day(-5), biopsy_kind: 'native'}), e => e.code === '23503');
  // Boundaries that are allowed: C1 just under 25 %, C2 at 25 %, today's date.
  const boundary = await insertBiopsy(editor, {patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native', oxford_c: 2, crescent_pct: 25});
  await as(editor, () => db.query('DELETE FROM public.biopsies_long WHERE id=$1', [boundary.id]));
  const c1 = await insertBiopsy(editor, {patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native', oxford_c: 1, crescent_pct: 24.9});
  await as(editor, () => db.query('DELETE FROM public.biopsies_long WHERE id=$1', [c1.id]));
  pass('biopsy records: native and transplant, one index biopsy per patient, one row per date and kind, ranges, Oxford C agrees with crescents, no future date, PII guard, patient must exist');

  await as(editor, async () => {
    await db.query('UPDATE public.biopsies_long SET crescent_pct=20 WHERE id=$1', [first.id]);
    await assert.rejects(db.query("UPDATE public.biopsies_long SET patient_code='P-2' WHERE id=$1", [first.id]), is('clinical_identity_is_immutable'));
    await db.query('DELETE FROM public.biopsies_long WHERE id=$1', [repeat.id]);
  });
  const audit = await rows("SELECT field_name,old_value,new_value,changed_by,table_name FROM public.field_audit_log WHERE record_id IN ($1,$2) ORDER BY changed_at,field_name", [first.id, repeat.id]);
  assert.deepEqual(audit.map(a => [a.table_name, a.field_name, a.old_value, a.new_value, a.changed_by]),
    [['biopsies_long', 'crescent_pct', '12.5', '20', editor], ['biopsies_long', '__record_deleted__', audit[1].old_value, null, editor]]);
  assert.match(audit[1].old_value, /^[0-9a-f]{64}$/, 'a deletion keeps only the record fingerprint');
  const updated = await row('SELECT updated_by,created_by FROM public.biopsies_long WHERE id=$1', [first.id]);
  assert.deepEqual([updated.updated_by, updated.created_by], [editor, editor]);
  pass('changes and deletions are field-audited; identity is immutable; created/updated metadata kept');

  await as(viewer, async () => {
    assert.equal(await count('SELECT count(*) AS n FROM public.biopsies_long'), 1);
    await assert.rejects(db.query("INSERT INTO public.biopsies_long(project_id,patient_code,biopsy_date,biopsy_kind) VALUES($1,'P-2',$2,'native')", [igan, today]), e => e.code === '42501');
    assert.equal((await db.query('DELETE FROM public.biopsies_long')).rowCount, 0);
  });
  await as(outsider, async () => assert.equal(await count('SELECT count(*) AS n FROM public.biopsies_long'), 0));
  await as(null, async () => assert.equal(await count('SELECT count(*) AS n FROM public.biopsies_long'), 0));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  await assert.rejects(insertBiopsy(editor, {patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native'}), is('subscription_required'));
  await as(editor, async () => assert.rejects(db.query('DELETE FROM public.biopsies_long WHERE id=$1', [first.id]), is('subscription_required')));
  await assert.rejects(importRows(editor, 'biopsies', [{patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native'}]), is('subscription_required'));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()+interval '30 days' WHERE user_id=$1", [owner]);
  pass('members read, viewers cannot write, outsiders see nothing; the read-only lock after the trial covers biopsy records');

  // ---- Medication classes; vaccinations are medications ---------------------------------
  const meds = NEW_CLASSES.map((drug_class, i) => ({patient_code: 'P-2', drug_name: `合成药物${i + 1}`, drug_class, start_date: today}));
  meds[5] = {...meds[5], drug_name: '四价脑膜炎球菌结合疫苗', route: 'IM', dose_value: '0.5', dose_unit: 'mL'};
  assert.equal((await importRows(editor, 'meds', meds)).inserted, 6);
  assert.deepEqual((await rows("SELECT drug_class FROM public.meds_long WHERE project_id=$1 AND start_date=$2 ORDER BY drug_class", [igan, today])).map(r => r.drug_class), [...NEW_CLASSES].sort());
  await assert.rejects(importRows(editor, 'meds', [{patient_code: 'P-2', drug_name: 'x', drug_class: '抗生素', start_date: today}]), is('row_1_invalid_drug_class'));
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-2', event_type: 'vaccination', event_date: today, evidence_source: 'medical_record', event_detail: '疫苗'}]), is('row_1_invalid_event_type'));
  await as(editor, () => assert.rejects(db.query("INSERT INTO public.events_long(project_id,patient_code,event_type,event_date,evidence_source,event_detail) VALUES($1,'P-2','vaccination',$2,'medical_record','x')", [igan, today]), is(/events_long_event_type_check/)));
  await assert.rejects(importRows(editor, 'events', [{patient_code: 'P-2', event_type: 'hospitalization', event_date: today, evidence_source: 'medical_record'}]), is('row_1_event_detail_required'));
  assert.equal((await importRows(editor, 'events', [{patient_code: 'P-2', event_type: 'hospitalization', event_date: today, evidence_source: 'medical_record', event_detail: '肺炎住院 6 天'}])).inserted, 1);
  pass('six medication classes import; vaccinations are recorded as medications and refused as events; infection and hospitalization events unchanged');

  // ---- Biopsy import and undo -------------------------------------------------------------
  const batch = randomUUID();
  const p2 = [{patient_code: 'P-2', biopsy_date: await day(-300), biopsy_kind: 'native', is_index: 'true', glomeruli_total: '18', crescent_pct: '30', oxford_m: '1', oxford_e: '1', oxford_s: '0', oxford_t: '0', oxford_c: '2'},
    {patient_code: 'P-2', biopsy_date: await day(-30), biopsy_kind: 'native', glomeruli_total: 12, crescent_pct: '0', oxford_c: '0', notes: '重复活检'}];
  assert.deepEqual(await importRows(editor, 'biopsies', p2, igan, batch), {inserted: 2, updated: 0, skipped: 0, total: 2, replayed: false});
  const imported = await biopsies('P-2');
  assert.deepEqual(imported.map(b => [b.biopsy_date, b.is_index, b.glomeruli_total, Number(b.crescent_pct), b.oxford_c]),
    [[await day(-300), true, 18, 30, 2], [await day(-30), false, 12, 0, 0]]);
  const again = randomUUID();
  assert.deepEqual(await importRows(editor, 'biopsies', p2, igan, again), {inserted: 0, updated: 0, skipped: 2, total: 2, replayed: false}, 'identical rows are skipped');
  const bad = async (values, expected) => assert.rejects(importRows(editor, 'biopsies', [{patient_code: 'P-2', biopsy_date: await day(-200), biopsy_kind: 'native', ...values}]), is(expected));
  await assert.rejects(importRows(editor, 'biopsies', [{...p2[1], glomeruli_total: '13'}]), is('row_1_same_key_record_conflict'));
  await bad({is_index: 'true'}, 'row_1_index_biopsy_exists');
  await bad({oxford_c: '1', crescent_pct: '40'}, 'row_1_oxford_c_crescent_mismatch');
  await bad({glomeruli_total: '12.0'}, 'row_1_integer_required: glomeruli_total');
  await bad({oxford_t: '3'}, 'row_1_invalid_oxford_score: oxford_t');
  await bad({crescent_pct: '101'}, 'row_1_number_out_of_range: crescent_pct');
  await bad({biopsy_kind: 'other'}, 'row_1_invalid_biopsy_kind');
  await bad({biopsy_kind: null}, 'row_1_biopsy_kind_required');
  await bad({is_index: '是'}, 'row_1_invalid_boolean: is_index');
  await bad({biopsy_date: await day(1)}, 'row_1_invalid_or_future_date: biopsy_date');
  await bad({report_file: 'x.pdf'}, 'row_1_unsupported_column: report_file');
  await bad({notes: '联系电话13812345678'}, 'row_1_pii_detected_blocked: notes');
  await assert.rejects(importRows(editor, 'biopsies', [{patient_code: 'NOPE', biopsy_date: today, biopsy_kind: 'native'}]), is('row_1_patient_not_registered'));
  await assert.rejects(importRows(viewer, 'biopsies', [{patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native'}]));
  await assert.rejects(importRows(outsider, 'biopsies', [{patient_code: 'P-2', biopsy_date: today, biopsy_kind: 'native'}]));
  assert.equal((await biopsies('P-2')).length, 2, 'refused batches write nothing');
  // The re-import linked the same records, so they stay until that batch is undone too.
  const kept = await undo(editor, batch, '核对后撤销活检导入');
  assert.deepEqual([kept.deleted, kept.kept_referenced], [0, 2]);
  assert.equal((await biopsies('P-2')).length, 2);
  assert.equal((await undo(editor, again, '撤销重复导入批次')).deleted, 2, 'undoing the later batch releases the records of the earlier undone batch');
  assert.equal((await biopsies('P-2')).length, 0);
  assert.ok(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='biopsies_long' AND field_name='__record_deleted__' AND change_reason LIKE '撤销导入批次%'") >= 2);
  assert.equal((await importRows(editor, 'biopsies', p2)).inserted, 2, 'after an undo the same rows import again');
  pass('biopsy import: business key, identical rows skipped, conflicts and rule violations name the row, one index biopsy, undo deletes only that batch');

  // ---- Frozen export --------------------------------------------------------------------
  const exported = await as(analyst, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [igan, randomUUID()])).e);
  assert.equal(createHash('sha256').update(exported.content_text, 'utf8').digest('hex'), exported.content_sha256);
  const content = JSON.parse(exported.content_text);
  assert.deepEqual(Object.keys(content.tables).sort(), ['biopsies_long', 'data_issues', 'events_long', 'ktx_baseline_ext', 'ktx_visits_ext', 'labs_long', 'meds_long', 'patients_baseline', 'variants_long', 'visits_long']);
  assert.deepEqual(content.tables.biopsies_long.map(b => [b.patient_code, b.biopsy_kind, b.is_index]).sort(),
    [['P-1', 'native', true], ['P-2', 'native', false], ['P-2', 'native', true]]);
  for (const k of ['biopsy_kind', 'is_index', 'crescent_pct']) assert.ok(content.field_notes[k], `field note ${k}`);
  assert.equal(content.tables.meds_long.filter(m => m.drug_class === '疫苗').length, 1);
  pass('frozen export carries biopsy records and their field notes');

  console.log(`BIOPSY_RECORDS_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
