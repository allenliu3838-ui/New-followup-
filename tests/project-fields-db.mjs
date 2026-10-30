// Native PG17 acceptance for 0044 (custom enrollment fields defined per project). The database
// is first built to 0043 and filled the way a v7 database can look; 0044 must apply as the
// reviewed increment, be safe to re-run and leave every stored value as it was. Then: field
// definitions (owner only, key and type fixed, options never removed), values checked against
// the definition on every write path, field audit, the read-only lock, batch import kind
// 'fields' with undo, and the frozen export. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Calendar dates are compared as the database's own YYYY-MM-DD text.
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic project fields acceptance accepts no external input');
const NEW_MIGRATION = '0044_project_fields.sql';
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
const hint = (message, text) => error => is(message)(error) && (text === undefined || String(error.hint).includes(text));
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
const email = {[owner]: 'pf-owner@example.invalid', [editor]: 'pf-editor@example.invalid', [analyst]: 'pf-analyst@example.invalid',
  [viewer]: 'pf-viewer@example.invalid', [outsider]: 'pf-outsider@example.invalid'};
const proj = randomUUID(), other = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const thisYear = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const saveField = (user, field, pid = proj) => as(user, async () => (await row('SELECT public.save_project_field($1,$2) AS f', [pid, JSON.stringify(field)])).f);
const setValues = (user, code, values, pid = proj) => as(user, async () =>
  (await row('SELECT public.set_patient_field_values($1,$2,$3) AS r', [pid, code, JSON.stringify(values)])).r);
const importRows = (user, list, batch = randomUUID()) => as(user, async () =>
  (await row("SELECT public.import_registry_rows($1,'fields',$2,$3) AS r", [proj, JSON.stringify(list), batch])).r);
const undo = (user, batch, reason) => as(user, async () =>
  (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [proj, batch, reason])).r);
const stored = code => rows('SELECT field_key,value_text,value_codes,value_num::text AS value_num,value_date FROM public.patient_field_values WHERE project_id=$1 AND patient_code=$2 ORDER BY field_key', [proj, code]);
const insertValue = (user, values) => as(user, () => {
  const keys = Object.keys(values);
  return row(`INSERT INTO public.patient_field_values(project_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [proj, ...keys.map(k => values[k])]);
});

// A draft like the REIGNITE enrollment fields, plus a number field; codes and labels are synthetic.
const SOURCE = 'REIGNITE 入组字段草案';
const FIELDS = [
  {field_key: 'inclusion_basis', label_cn: '入选依据', value_type: 'choice', source: SOURCE,
    choices: [{code: 'biopsy_proven', label: '肾活检确诊'}, {code: 'clinical', label: '临床诊断'}]},
  {field_key: 'ethnicity', label_cn: '民族', value_type: 'choice', source: SOURCE,
    choices: [{code: 'han', label: '汉族'}, {code: 'zhuang', label: '壮族'}, {code: 'hui', label: '回族'}, {code: 'other', label: '其他'}]},
  {field_key: 'autoimmune_disease', label_cn: '是否伴自身免疫病', value_type: 'yes_no', source: SOURCE},
  {field_key: 'comorbidities', label_cn: '合并症', value_type: 'multi_choice', source: SOURCE, help_cn: '可多选；没有合并症选“无”。',
    choices: [{code: 'hypertension', label: '高血压'}, {code: 'diabetes', label: '糖尿病'}, {code: 'cad', label: '冠心病'}, {code: 'none', label: '无'}]},
  {field_key: 'fundus_exam_date', label_cn: '眼底检查日期', value_type: 'date', source: SOURCE},
  {field_key: 'onset_age', label_cn: '起病年龄', value_type: 'number', unit: '岁', min_value: 0, max_value: 120},
  {field_key: 'fundus_note', label_cn: '眼底检查所见', value_type: 'text'},
];

try {
  // ---- A v7 database at 0043 -------------------------------------------------------------
  const upTo43 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 43);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 43), [NEW_MIGRATION, '0045_cystatin_urine_rbc.sql', '0046_adpkd_module.sql'],
    '0044 directly follows 0043; 0045 and 0046 have their own acceptance (tests/cystatin-urine-rbc-db.mjs, tests/adpkd-module-db.mjs)');
  for (const file of upTo43) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 12);
  for (const id of [owner, editor, analyst, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Synthetic C3G project','SYN','C3G','general',$2)", [proj, owner]);
  await db.query("INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by) VALUES($1,'Other synthetic project','OTH','IGAN','igan',$2)", [other, outsider]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [proj, email[user], role])).r.status, 'added'));
  }
  const year = await thisYear();
  const today = await day(0), longAgo = await day(-400), d30 = await day(-30);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'P-1','M',${year - 45},$2,95,'consented',$2,'V1'), ($1,'P-2','F',${year - 30},$2,70,'consented',$2,'V1'), ($1,'P-3','F',${year - 12},$2,40,'consented',$2,'V1')`, [proj, longAgo]));
  await as(outsider, () => db.query("INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date) VALUES($1,'P-1','M',1980,$2)", [other, longAgo]));
  await as(editor, async () => {
    await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,scr_umol_l,sbp,dbp) VALUES($1,'P-1',$2,100,120,80)", [proj, d30]);
    await db.query("INSERT INTO public.biopsies_long(project_id,patient_code,biopsy_date,biopsy_kind,is_index) VALUES($1,'P-1',$2,'native',true)", [proj, longAgo]);
  });

  const snapshot = async () => ({
    baseline: await rows('SELECT * FROM public.patients_baseline ORDER BY project_id,patient_code'),
    visits: await rows('SELECT * FROM public.visits_long ORDER BY id'),
    biopsies: await rows('SELECT * FROM public.biopsies_long ORDER BY id'),
    imports: await rows('SELECT * FROM public.registry_import_records ORDER BY record_id'),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
  });
  const before = await snapshot();
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 13);
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 13);
  assert.deepEqual(await snapshot(), before, 'existing clinical rows, import links and audit rows are unchanged');
  assert.equal(await count('SELECT count(*) AS n FROM public.project_fields') + await count('SELECT count(*) AS n FROM public.patient_field_values'), 0, 'no fields are created by the migration');
  for (const table of ['project_fields', 'patient_field_values']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await row('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `public.${table}`, 'TRUNCATE'])).ok, false, `${role} cannot truncate ${table}`);
    }
  }
  pass('0044 applies on a 0043 database, is safe to re-run, changes no stored value and creates no field');

  // ---- Field definitions: owner only --------------------------------------------------------
  const saved = [];
  for (const field of FIELDS) saved.push(await saveField(owner, field));
  assert.deepEqual(saved.map(f => [f.field_key, f.value_type, f.active, f.sort_order]),
    FIELDS.map((f, i) => [f.field_key, f.value_type, true, (i + 1) * 10]), 'fields are saved in order, active');
  assert.ok(saved.every(f => !('created_by' in f) && !('updated_by' in f)), 'the answer does not carry user ids');
  assert.deepEqual([Number(saved[5].min_value), Number(saved[5].max_value), saved[5].unit], [0, 120, '岁']);
  for (const user of [editor, analyst, viewer, outsider]) {
    await assert.rejects(saveField(user, {field_key: 'x_test', label_cn: '测试', value_type: 'text'}), e => e.code === '42501' && e.message === 'project_access_denied');
  }
  await assert.rejects(as(owner, () => db.query("INSERT INTO public.project_fields(project_id,field_key,label_cn,value_type) VALUES($1,'direct','直接写入','text')", [proj])), e => e.code === '42501');
  await assert.rejects(as(owner, () => db.query("UPDATE public.project_fields SET label_cn='改名' WHERE project_id=$1", [proj])), e => e.code === '42501');
  await assert.rejects(as(owner, () => db.query('DELETE FROM public.project_fields WHERE project_id=$1', [proj])), e => e.code === '42501');
  const bad = async (field, expected) => assert.rejects(saveField(owner, field), is(expected));
  await bad({field_key: 'Ethnicity2', label_cn: '民族二', value_type: 'text'}, 'invalid_field_key');
  await bad({field_key: 'a', label_cn: '单字母', value_type: 'text'}, 'invalid_field_key');
  await bad({field_key: 'patient_code', label_cn: '研究编号二', value_type: 'text'}, 'reserved_field_key: patient_code');
  await bad({field_key: 'module', label_cn: '病种二', value_type: 'text'}, 'reserved_field_key: module');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'select'}, 'invalid_field_type');
  await bad({field_key: 'blood_type', label_cn: '民族', value_type: 'text'}, 'duplicate_field_label');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'choice', choices: [{code: 'a', label: 'A 型'}]}, 'invalid_field_choices');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'choice', choices: [{code: 'a', label: 'A 型'}, {code: 'a', label: 'B 型'}]}, 'invalid_field_choices');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'choice', choices: [{code: 'A', label: 'A 型'}, {code: 'b', label: 'B 型'}]}, 'invalid_field_choices');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'choice', choices: [{code: 'a', label: 'A 型'}, {code: 'b', label: 'A 型'}]}, 'invalid_field_choices');
  await bad({field_key: 'blood_type', label_cn: '血型', value_type: 'choice'}, 'invalid_field_choices');
  await bad({field_key: 'blood_note', label_cn: '血型备注', value_type: 'text', choices: [{code: 'a', label: 'A'}, {code: 'b', label: 'B'}]}, 'choices_not_allowed');
  await bad({field_key: 'blood_note', label_cn: '血型备注', value_type: 'text', unit: 'mg'}, 'number_properties_not_allowed');
  await bad({field_key: 'weight', label_cn: '体重', value_type: 'number', min_value: 200, max_value: 10}, 'invalid_field_range');
  await bad({field_key: 'weight', label_cn: '体重', value_type: 'number', min_value: 'NaN'}, 'invalid_field_range');
  await bad({field_key: 'weight', label_cn: '体重', value_type: 'number', max_value: 'Infinity'}, 'invalid_field_range');
  await bad({field_key: 'weight', label_cn: '体重', value_type: 'number', owner_note: 'x'}, 'unsupported_field_property: owner_note');
  await bad({field_key: 'weight', label_cn: '体重', value_type: 'number', sort_order: 1.5}, 'invalid_field_sort_order');
  await bad({field_key: 'ethnicity', value_type: 'text'}, 'field_type_is_fixed');
  await bad({field_key: 'ethnicity', choices: [{code: 'han', label: '汉族'}, {code: 'other', label: '其他'}]}, 'field_choice_removed: zhuang、hui');
  // Labels are edited and options added; the key, type and existing codes stay.
  const ethnicity = await saveField(owner, {field_key: 'ethnicity', label_cn: '民族（自报）', help_cn: '按身份证登记的民族。',
    choices: [{code: 'han', label: '汉族'}, {code: 'zhuang', label: '壮族'}, {code: 'hui', label: '回族'}, {code: 'other', label: '其他民族'}, {code: 'unknown', label: '不详'}]});
  assert.deepEqual([ethnicity.label_cn, ethnicity.value_type, ethnicity.choices.map(c => c.code), ethnicity.sort_order], ['民族（自报）', 'choice', ['han', 'zhuang', 'hui', 'other', 'unknown'], 20]);
  const audit = await rows("SELECT action,details FROM public.audit_log WHERE project_id=$1 AND action LIKE 'project_field_%' ORDER BY created_at,id", [proj]);
  assert.deepEqual(audit.map(a => a.action), [...FIELDS.map(() => 'project_field_created'), 'project_field_updated']);
  assert.equal(audit.at(-1).details.before.label_cn, '民族');
  assert.equal(audit.at(-1).details.after.label_cn, '民族（自报）');
  assert.ok(!('created_by' in audit.at(-1).details.after), 'audit details carry no user ids');
  const unchanged = await saveField(owner, {field_key: 'ethnicity', label_cn: '民族（自报）'});
  assert.equal(unchanged.label_cn, '民族（自报）');
  assert.equal(await count("SELECT count(*) AS n FROM public.audit_log WHERE project_id=$1 AND action LIKE 'project_field_%'", [proj]), FIELDS.length + 1, 'saving without a change writes no audit row');
  await as(viewer, async () => assert.equal(await count('SELECT count(*) AS n FROM public.project_fields'), FIELDS.length));
  await as(outsider, async () => assert.equal(await count('SELECT count(*) AS n FROM public.project_fields'), 0));
  await as(null, async () => assert.equal(await count('SELECT count(*) AS n FROM public.project_fields'), 0));
  pass('field definitions: owner only through save_project_field; key, type and option codes fixed; labels unique; audited; members read, others see nothing');

  // ---- Values: one call per patient ------------------------------------------------------------
  const first = await setValues(editor, 'P-1', {inclusion_basis: 'biopsy_proven', ethnicity: 'han', autoimmune_disease: false,
    comorbidities: ['diabetes', 'hypertension'], fundus_exam_date: d30, onset_age: '38.5', fundus_note: '  动脉变细  '});
  assert.equal(first.changed, 7);
  assert.deepEqual(first.values, {autoimmune_disease: 'no', comorbidities: ['hypertension', 'diabetes'], ethnicity: 'han',
    fundus_exam_date: d30, fundus_note: '动脉变细', inclusion_basis: 'biopsy_proven', onset_age: 38.5});
  assert.deepEqual((await stored('P-1')).find(v => v.field_key === 'comorbidities').value_codes, ['hypertension', 'diabetes'], 'multi-choice codes in the order of the definition');
  assert.equal((await setValues(editor, 'P-1', {comorbidities: 'hypertension; diabetes', onset_age: 38.50, ethnicity: 'han'})).changed, 0, 'equal values change nothing');
  const second = await setValues(editor, 'P-1', {ethnicity: 'hui', fundus_note: '', autoimmune_disease: 'yes'});
  assert.equal(second.changed, 3);
  assert.deepEqual([second.values.ethnicity, second.values.fundus_note, second.values.autoimmune_disease], ['hui', undefined, 'yes'], 'a blank value clears the field');
  const fieldAudit = await rows("SELECT field_name,old_value,new_value,changed_by FROM public.field_audit_log WHERE table_name='patient_field_values' ORDER BY changed_at,field_name");
  assert.deepEqual(fieldAudit.map(a => [a.field_name, a.old_value, a.new_value, a.changed_by]).sort(),
    [['x_autoimmune_disease', 'no', 'yes', editor], ['x_ethnicity', 'han', 'hui', editor], ['x_fundus_note', '动脉变细', null, editor]].sort());
  const refuse = async (values, expected, code = 'P-2') => assert.rejects(setValues(editor, code, values), expected);
  await refuse({ethnicity: 'manchu'}, hint('invalid_field_value: ethnicity', '汉族（han）、壮族（zhuang）'));
  await refuse({comorbidities: ['cad', 'cad']}, hint('invalid_field_value: comorbidities', '不能重复'));
  await refuse({comorbidities: 'cad;;none'}, is('invalid_field_value: comorbidities'));
  await refuse({autoimmune_disease: '是'}, is('invalid_field_value: autoimmune_disease'));
  await refuse({onset_age: 130}, hint('invalid_field_value: onset_age', '范围 0–120（岁）'));
  await refuse({onset_age: '三十'}, is('invalid_field_value: onset_age'));
  await refuse({fundus_exam_date: await day(1)}, hint('invalid_field_value: fundus_exam_date', '不晚于今天'));
  await refuse({fundus_exam_date: '2025-02-30'}, is('invalid_iso_date: fundus_exam_date'));
  await refuse({fundus_note: '联系电话 13812345678'}, hint('pii_detected_blocked: fundus_note', '眼底检查所见'));
  await refuse({fundus_note: '第一行\n第二行'}, is('invalid_field_value: fundus_note'));
  await refuse({fundus_note: 'x'.repeat(201)}, is('invalid_field_value: fundus_note'));
  await refuse({blood_type: 'a'}, is('unknown_field: blood_type'));
  await refuse({ethnicity: 'han'}, is('patient_not_found'), 'NOPE');
  await refuse({}, is('field_values_required'));
  for (const user of [viewer, analyst, outsider]) await assert.rejects(setValues(user, 'P-2', {ethnicity: 'han'}), e => e.code === '42501');
  await assert.rejects(setValues(editor, 'P-1', {ethnicity: 'han'}, other), e => e.code === '42501', 'another project cannot be written');
  assert.deepEqual(await stored('P-2'), [], 'refused calls write nothing');
  pass('values: every type, codes kept in definition order, equal values unchanged, blanks clear, changes field-audited, every rule names the field');

  // ---- Direct table writes are checked by the same trigger -----------------------------------
  const direct = await insertValue(editor, {patient_code: 'P-2', field_key: 'ethnicity', value_text: 'zhuang'});
  assert.equal(direct.created_by, editor);
  await assert.rejects(insertValue(editor, {patient_code: 'P-2', field_key: 'inclusion_basis', value_text: 'guess'}), is('invalid_field_value: inclusion_basis'));
  await assert.rejects(insertValue(editor, {patient_code: 'P-2', field_key: 'onset_age', value_num: 'NaN'}), is('invalid_field_value: onset_age'));
  await assert.rejects(insertValue(editor, {patient_code: 'P-2', field_key: 'onset_age', value_text: '30'}), is('invalid_field_value: onset_age'));
  await assert.rejects(insertValue(editor, {patient_code: 'P-2', field_key: 'onset_age', value_num: 30, value_text: '30'}), is(/patient_field_values_one_value/));
  await assert.rejects(insertValue(editor, {patient_code: 'P-2', field_key: 'missing', value_text: 'x'}), is('unknown_field: missing'));
  await assert.rejects(insertValue(viewer, {patient_code: 'P-2', field_key: 'ethnicity', value_text: 'han'}), e => e.code === '42501');
  await assert.rejects(insertValue(outsider, {patient_code: 'P-2', field_key: 'ethnicity', value_text: 'han'}), e => e.code === '42501');
  await as(editor, async () => {
    await assert.rejects(db.query("UPDATE public.patient_field_values SET patient_code='P-3' WHERE id=$1", [direct.id]), is('clinical_identity_is_immutable'));
    await assert.rejects(db.query("UPDATE public.patient_field_values SET field_key='inclusion_basis' WHERE id=$1", [direct.id]), is('field_key_is_immutable'));
    await db.query("UPDATE public.patient_field_values SET value_text='hui' WHERE id=$1", [direct.id]);
  });
  assert.equal((await row('SELECT updated_by FROM public.patient_field_values WHERE id=$1', [direct.id])).updated_by, editor);
  await as(viewer, async () => {
    assert.equal(await count('SELECT count(*) AS n FROM public.patient_field_values'), 7);
    assert.equal((await db.query('DELETE FROM public.patient_field_values')).rowCount, 0);
  });
  await as(outsider, async () => assert.equal(await count('SELECT count(*) AS n FROM public.patient_field_values'), 0));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  await assert.rejects(setValues(editor, 'P-2', {ethnicity: 'han'}), is('subscription_required'));
  await assert.rejects(as(editor, () => db.query('DELETE FROM public.patient_field_values WHERE id=$1', [direct.id])), is('subscription_required'));
  await assert.rejects(importRows(editor, [{patient_code: 'P-2', ethnicity: 'han'}]), is('subscription_required'));
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()+interval '30 days' WHERE user_id=$1", [owner]);
  pass('direct writes meet the same rules; identity is immutable; members read, viewers and outsiders cannot write; the read-only lock covers field values');

  // ---- Changing a definition never invalidates stored values ---------------------------------
  await assert.rejects(saveField(owner, {field_key: 'onset_age', max_value: 30}), is('field_range_excludes_values'));
  assert.equal(Number((await saveField(owner, {field_key: 'onset_age', max_value: 100})).max_value), 100);
  const off = await saveField(owner, {field_key: 'fundus_exam_date', active: false});
  assert.equal(off.active, false);
  await assert.rejects(setValues(editor, 'P-2', {fundus_exam_date: d30}), hint('field_inactive: fundus_exam_date', '已停用'));
  assert.equal((await setValues(editor, 'P-1', {fundus_exam_date: d30})).changed, 0, 'an existing value of a deactivated field stays as it is');
  await assert.rejects(setValues(editor, 'P-1', {fundus_exam_date: await day(-31)}), is('field_inactive: fundus_exam_date'));
  assert.equal((await setValues(editor, 'P-1', {fundus_exam_date: null})).changed, 1, 'a value of a deactivated field can still be cleared');
  await saveField(owner, {field_key: 'fundus_exam_date', active: true});
  assert.equal((await setValues(editor, 'P-1', {fundus_exam_date: d30})).changed, 1);
  pass('a range change that would exclude stored values is refused; a deactivated field keeps its values and takes no new ones');

  // ---- Batch import kind 'fields' and undo ----------------------------------------------------
  const batch = randomUUID();
  const file = [{patient_code: 'P-2', ethnicity: 'hui', comorbidities: 'none', onset_age: '29', fundus_note: ''},
    {patient_code: 'P-3', inclusion_basis: 'clinical', autoimmune_disease: 'no', fundus_exam_date: d30, comorbidities: 'diabetes;hypertension'}];
  assert.deepEqual(await importRows(editor, file, batch), {inserted: 2, updated: 0, skipped: 0, total: 2, replayed: false});
  assert.deepEqual((await stored('P-3')).map(v => [v.field_key, v.value_text ?? v.value_codes ?? v.value_date]),
    [['autoimmune_disease', 'no'], ['comorbidities', ['hypertension', 'diabetes']], ['fundus_exam_date', d30], ['inclusion_basis', 'clinical']]);
  assert.deepEqual(await importRows(editor, file, batch), {inserted: 2, updated: 0, skipped: 0, total: 2, replayed: true}, 'the same batch replays');
  const again = randomUUID();
  assert.deepEqual(await importRows(editor, file, again), {inserted: 0, updated: 0, skipped: 2, total: 2, replayed: false}, 'equal values are matched, not written');
  const rejects = async (list, expected) => assert.rejects(importRows(editor, list), expected);
  await rejects([{patient_code: 'P-3', inclusion_basis: 'biopsy_proven'}], hint('row_1_field_value_conflict: inclusion_basis', '导入不会覆盖'));
  await rejects([{patient_code: 'P-2', blood_type: 'a'}], hint('row_1_unknown_field: blood_type', '不是本项目的自定义入组字段'));
  await rejects([{patient_code: 'P-3', ethnicity: 'manchu'}], hint('row_1_invalid_field_value: ethnicity', '汉族（han）'));
  await rejects([{patient_code: 'P-2', inclusion_basis: 'clinical'}, {patient_code: 'P-3', onset_age: '200'}], is('row_2_invalid_field_value: onset_age'));
  await rejects([{patient_code: 'P-2', fundus_exam_date: '2025/01/01'}], is('row_1_invalid_iso_date: fundus_exam_date'));
  await rejects([{patient_code: 'P-2', onset_age: 29}], is('row_1_text_value_required: onset_age'));
  await rejects([{patient_code: 'NOPE', ethnicity: 'han'}], is('row_1_patient_not_registered'));
  await rejects([{patient_code: 'P-2', fundus_note: '患者手机 13812345678'}], is('row_1_pii_detected_blocked: fundus_note'));
  await saveField(owner, {field_key: 'fundus_note', active: false});
  await rejects([{patient_code: 'P-2', fundus_note: '正常'}], is('row_1_field_inactive: fundus_note'));
  await saveField(owner, {field_key: 'fundus_note', active: true});
  await assert.rejects(importRows(viewer, [{patient_code: 'P-2', ethnicity: 'han'}]), e => e.code === '42501');
  assert.equal((await stored('P-2')).length, 3, 'refused batches write nothing');
  // The second batch linked the same values, so they stay until it is undone too.
  const kept = await undo(editor, batch, '核对后撤销入组字段导入');
  assert.deepEqual([kept.deleted, kept.kept_referenced], [0, 6]);
  const released = await undo(editor, again, '撤销重复导入批次');
  assert.equal(released.deleted, 6, 'undoing the later batch releases the values of the earlier undone batch');
  assert.deepEqual((await stored('P-2')).map(v => v.field_key), ['ethnicity'], 'only the imported values are removed; the value entered before the import stays');
  assert.equal((await stored('P-3')).length, 0);
  assert.ok(await count("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='patient_field_values' AND change_reason LIKE '撤销导入批次%'") >= 6);
  // A value corrected after its import is kept by the undo.
  const third = randomUUID();
  assert.equal((await importRows(editor, [{patient_code: 'P-3', inclusion_basis: 'clinical', onset_age: '11'}], third)).inserted, 1);
  await setValues(editor, 'P-3', {onset_age: 10});
  const partial = await undo(editor, third, '撤销第三批');
  assert.deepEqual([partial.deleted, partial.kept_changed], [1, 1]);
  assert.deepEqual((await stored('P-3')).map(v => [v.field_key, v.value_num]), [['onset_age', '10']]);
  pass('field import: blank cells ignored, equal values matched, conflicts and rule violations name the row and field, undo removes only that batch and keeps corrected values');

  // ---- Frozen export --------------------------------------------------------------------
  const exported = await as(analyst, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [proj, randomUUID()])).e);
  assert.equal(createHash('sha256').update(exported.content_text, 'utf8').digest('hex'), exported.content_sha256);
  const content = JSON.parse(exported.content_text);
  assert.deepEqual(Object.keys(content.tables).sort(), ['biopsies_long', 'data_issues', 'events_long', 'ktx_baseline_ext', 'ktx_visits_ext', 'labs_long',
    'meds_long', 'patient_field_values', 'patients_baseline', 'project_fields', 'variants_long', 'visits_long']);
  assert.deepEqual(content.tables.project_fields.map(f => f.field_key).sort(), FIELDS.map(f => f.field_key).sort());
  assert.ok(content.tables.patient_field_values.every(v => v.project_id === proj));
  assert.deepEqual(content.tables.patient_field_values.filter(v => v.patient_code === 'P-1' && v.field_key === 'comorbidities').map(v => v.value_codes), [['hypertension', 'diabetes']]);
  for (const k of ['field_key', 'value_codes']) assert.ok(content.field_notes[k], `field note ${k}`);
  pass('frozen export carries the field definitions and values with their field notes');

  console.log(`PROJECT_FIELDS_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
