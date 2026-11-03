// Native PG17 acceptance for 0049 (entry and data-quality review). The database is first built to
// 0048 and filled the way a v10 database can look, including a project whose owner's trial has
// lapsed. 0049 must apply without touching any stored row, keep import undo working, and add the
// new rules for new and edited visits only; existing visits are rechecked only on request.
// Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';
import pg from 'pg';
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic 0049 acceptance accepts no external input');
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
async function apply(file) {
  const entry = migrations.find(m => m.file === file);
  assert.ok(entry, `${file} is listed in the reviewed migration manifest`);
  const bytes = fs.readFileSync(path.join(root, 'supabase/migrations', file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, file);
  try { await db.exec(bytes.toString('utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`, {cause: e}); }
}

const [owner, editor, viewer, lapsed] = Array.from({length: 4}, () => randomUUID());
const email = {[owner]: 'qc-owner@example.invalid', [editor]: 'qc-editor@example.invalid', [viewer]: 'qc-viewer@example.invalid',
  [lapsed]: 'qc-lapsed@example.invalid'};
const pid = randomUUID(), lapsedPid = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const year = async () => Number((await row('SELECT extract(year FROM registry_private.local_today())::int AS y')).y);
const importRows = (user, kind, list, batch = randomUUID()) => as(user, async () =>
  (await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [pid, kind, JSON.stringify(list), batch])).r);
const undo = (user, batch) => as(user, async () =>
  (await row('SELECT public.undo_import_batch($1,$2,$3) AS r', [pid, batch, '核对后撤销导入'])).r);
const addVisit = (user, project, values) => as(user, async () => {
  const keys = Object.keys(values);
  return row(`INSERT INTO public.visits_long(project_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [project, ...keys.map(k => values[k])]);
});
const issues = async visitId => Object.fromEntries((await rows(
  "SELECT rule_code,message FROM public.data_issues WHERE record_id=$1 AND status NOT IN ('RESOLVED','WONT_FIX') ORDER BY rule_code", [visitId]))
  .map(r => [r.rule_code, r.message]));

try {
  // ---- A v10 database at 0048 -----------------------------------------------------------
  for (const file of migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 48)) await apply(file);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 48), ['0049_qc_entry_review.sql']);
  for (const id of [owner, editor, viewer, lapsed]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query(`INSERT INTO public.projects(id,name,center_code,module,registry_type,created_by)
    VALUES($1,'Synthetic QC project','SYN','IGAN','general',$2),($3,'Synthetic lapsed project','SYL','IGAN','general',$4)`, [pid, owner, lapsedPid, lapsed]);
  for (const [user, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r', [pid, email[user], role])).r.status, 'added'));
  }
  const y = await year();
  const base = await day(-400), d10 = await day(-10), d20 = await day(-20), d30 = await day(-30), d60 = await day(-60);
  const longCode = 'L'.repeat(70);
  await as(owner, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'P-1','M',${y - 45},$2,95,'consented',$2,'V1'), ($1,'P-NOSEX',NULL,${y - 50},$2,90,'consented',$2,'V1'),
      ($1,'P-CHILD','F',${y - 10},$2,40,'consented',$2,'V1'), ($1,$3,'F',${y - 30},$2,70,'consented',$2,'V1')`, [pid, base, longCode]));
  await as(lapsed, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,baseline_scr,consent_status,consent_date,consent_version)
    VALUES ($1,'Q-1','F',${y - 40},$2,80,'consented',$2,'V1')`, [lapsedPid, base]));
  const oldMissing = await addVisit(editor, pid, {patient_code: 'P-1', visit_date: d60, sbp: 300, dbp: 80, scr_umol_l: 100});
  const oldWontFix = await addVisit(editor, pid, {patient_code: 'P-1', visit_date: await day(-90), sbp: 120, dbp: 80, scr_umol_l: 100});
  const wontFixId = (await row("SELECT id FROM public.data_issues WHERE record_id=$1 AND rule_code='MISSING_CORE_FIELD'", [oldWontFix.id]))?.id;
  assert.equal(wontFixId, undefined, 'before 0049 a visit with creatinine but no UPCR raises no core-field issue');
  await db.query(`INSERT INTO public.data_issues(project_id,center_code,patient_code,record_type,record_id,rule_code,severity,status,message,resolution_note)
    VALUES($1,'SYN','P-1','visit',$2,'MISSING_CORE_FIELD','warning','WONT_FIX','synthetic accepted gap','本中心不测 UPCR')`, [pid, oldWontFix.id]);
  await addVisit(lapsed, lapsedPid, {patient_code: 'Q-1', visit_date: d60, sbp: 250, dbp: 80, scr_umol_l: 90});
  const v10Batch = randomUUID();
  assert.equal((await importRows(editor, 'visits', [{patient_code: 'P-1', visit_date: d30, scr_umol_l: '98', sbp: '125', dbp: '82'}], v10Batch)).inserted, 1);
  const link = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'P-1',30,true) AS t", [pid])).t);
  const patientVisit = await as(null, async () => row('SELECT * FROM public.patient_submit_visit_v2($1,$2::date,122,78,96,250,NULL,NULL,$3)', [link, d20, randomUUID()]));
  assert.equal(patientVisit.status, 'submitted');
  // The owner of the second project lets the trial lapse: that project is read-only.
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [lapsed]);
  await db.query("SELECT public._sync_account_projects($1)", [lapsed]);

  const snapshot = async () => ({
    baseline: await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b ORDER BY id'),
    visits: (await rows('SELECT to_jsonb(v) AS r FROM public.visits_long v ORDER BY id')).map(({r}) => { const {staff_reviewed_at, ...rest} = r; return rest; }),
    issues: await rows('SELECT to_jsonb(d) AS r FROM public.data_issues d ORDER BY id'),
    imports: await rows('SELECT to_jsonb(i) AS r FROM public.registry_import_records i ORDER BY record_id'),
    fieldAudit: await count('SELECT count(*) AS n FROM public.field_audit_log'),
    audit: await count('SELECT count(*) AS n FROM public.audit_log'),
  });
  const before = await snapshot();
  await apply('0049_qc_entry_review.sql');
  await apply('0049_qc_entry_review.sql');
  assert.equal(await count("SELECT count(*) AS n FROM public.registry_schema_versions WHERE version='0049_qc_entry_review'"), 1);
  assert.deepEqual(await snapshot(), before, 'no stored row, timestamp, issue, import link or audit row changes');
  assert.equal(await count('SELECT count(*) AS n FROM public.visits_long WHERE staff_reviewed_at IS NOT NULL'), 0);
  assert.equal(await count("SELECT count(*) AS n FROM public.patients_baseline WHERE char_length(patient_code) > 64"), 1, 'the existing long ID is kept');
  pass('0049 applies on a 0048 database with a read-only (lapsed trial) project, is safe to re-run and changes no stored row');

  // ---- Undo of a batch imported before 0049 ----------------------------------------------
  assert.deepEqual([(await undo(editor, v10Batch)).deleted], [1], 'staff_reviewed_at added later and still empty is not an edit');
  pass('a visit batch imported before 0049 is still undone');

  // ---- New and edited visits follow the new rules ----------------------------------------
  const high = await addVisit(editor, pid, {patient_code: 'P-1', visit_date: d10, sbp: 230, dbp: 135, scr_umol_l: 100});
  let found = await issues(high.id);
  assert.match(found.OUT_OF_RANGE, /收缩压 230 mmHg 超出常见范围 70–220 mmHg；舒张压 135 mmHg 超出常见范围 40–130 mmHg/);
  assert.match(found.MISSING_CORE_FIELD, /缺少尿蛋白肌酐比（UPCR）。/);
  assert.equal(found.MISSING_EGFR_INPUTS, undefined, 'eGFR computed: no eGFR note');
  await as(editor, async () => {
    await db.query("SELECT set_config('app.registry_change_reason','核对原始记录后更正',false)");
    await db.query('UPDATE public.visits_long SET sbp=132,dbp=84,upcr=300 WHERE id=$1', [high.id]);
  });
  found = await issues(high.id);
  assert.deepEqual(Object.keys(found), [], 'correcting the values closes both issues');
  await assert.rejects(addVisit(editor, pid, {patient_code: 'P-1', visit_date: await day(-11), sbp: 310, dbp: 80}), is(/check/i), 'the hard range still refuses');
  const blank = await addVisit(editor, pid, {patient_code: 'P-1', visit_date: await day(-12), notes: '仅登记'});
  assert.match((await issues(blank.id)).MISSING_CORE_FIELD, /缺少收缩压、舒张压、血肌酐、尿蛋白肌酐比（UPCR）/);
  const noSex = await addVisit(editor, pid, {patient_code: 'P-NOSEX', visit_date: d10, sbp: 120, dbp: 80, scr_umol_l: 100, upcr: 200});
  assert.equal((await issues(noSex.id)).MISSING_EGFR_INPUTS, '有血肌酐数据，但缺少患者性别，无法自动计算 eGFR。请在基线中补充性别。');
  const child = await addVisit(editor, pid, {patient_code: 'P-CHILD', visit_date: d10, sbp: 100, dbp: 60, scr_umol_l: 40, upcr: 100});
  assert.match((await issues(child.id)).MISSING_EGFR_INPUTS, /随访时 10 岁.*需要本次随访的身高/);
  await as(editor, () => db.query('UPDATE public.visits_long SET height_cm=140 WHERE id=$1', [child.id]));
  assert.equal((await issues(child.id)).MISSING_EGFR_INPUTS, undefined, 'height entered: Schwartz eGFR computed, note closed');
  pass('new and edited visits: missing core items named, common-range warning, eGFR note names sex, birth year or a child\'s height; corrections close the issues');

  // ---- Existing visits only on request ---------------------------------------------------
  assert.equal(await count("SELECT count(*) AS n FROM public.data_issues WHERE record_id=$1 AND rule_code='OUT_OF_RANGE'", [oldMissing.id]), 0,
    'the migration did not recheck existing visits');
  await as(viewer, () => assert.rejects(row('SELECT public.recheck_visit_quality($1)', [pid])));
  await as(lapsed, () => assert.rejects(row('SELECT public.recheck_visit_quality($1)', [lapsedPid]), is('subscription_required')));
  const visitsBefore = await rows('SELECT to_jsonb(v) AS r FROM public.visits_long v ORDER BY id');
  const result = await as(editor, async () => (await row('SELECT public.recheck_visit_quality($1) AS r', [pid])).r);
  assert.equal(result.visits, await count('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1', [pid]));
  assert.ok(result.open_after > result.open_before);
  assert.deepEqual(await rows('SELECT to_jsonb(v) AS r FROM public.visits_long v ORDER BY id'), visitsBefore, 'the recheck never writes a visit');
  found = await issues(oldMissing.id);
  assert.match(found.OUT_OF_RANGE, /收缩压 300 mmHg/);
  assert.match(found.MISSING_CORE_FIELD, /缺少尿蛋白肌酐比/);
  assert.equal((await issues(oldWontFix.id)).MISSING_CORE_FIELD, undefined, 'an issue accepted as "will not fix" stays closed');
  const logged = await row("SELECT actor_uid,details FROM public.audit_log WHERE project_id=$1 AND action='visit_quality_rechecked'", [pid]);
  assert.equal(logged.actor_uid, editor);
  assert.equal(logged.details.visits, result.visits);
  assert.deepEqual(await as(editor, async () => (await row('SELECT public.recheck_visit_quality($1) AS r', [pid])).r.open_after), result.open_after, 'a second recheck is stable');
  pass('existing visits are rechecked only on request by a writer of a writable project; issues only, never the visits; accepted gaps stay closed; audited');

  // ---- Research IDs -----------------------------------------------------------------------
  await as(editor, () => assert.rejects(db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,consent_status)
    VALUES($1,$2,'M',1980,$3,'unconfirmed')`, [pid, 'X'.repeat(65), base]), is(/patients_baseline_patient_code_len/)));
  await as(editor, () => assert.rejects(db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,consent_status)
    VALUES($1,' P-SPACE','M',1980,$2,'unconfirmed')`, [pid, base]), is(/patients_baseline_patient_code_len/)));
  await as(editor, () => db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,sex,birth_year,baseline_date,consent_status)
    VALUES($1,$2,'M',1980,$3,'unconfirmed')`, [pid, 'Y'.repeat(64), base]));
  await as(editor, () => assert.rejects(db.query('UPDATE public.patients_baseline SET baseline_scr=71 WHERE project_id=$1 AND patient_code=$2', [pid, longCode]),
    is(/patients_baseline_patient_code_len/)));
  pass('research IDs: 64 characters accepted, 65 or untrimmed refused; an existing longer ID is kept and must be shortened before its baseline is edited');

  // ---- Patient submissions: review mark -------------------------------------------------
  const pv = patientVisit.visit_id ?? (await row("SELECT id FROM public.visits_long WHERE submitted_via_token_id IS NOT NULL")).id;
  await as(viewer, () => assert.rejects(row('SELECT public.mark_patient_visit_reviewed($1,$2)', [pid, pv])));
  await as(editor, () => assert.rejects(row('SELECT public.mark_patient_visit_reviewed($1,$2)', [pid, blank.id]), is('visit_not_patient_submission')));
  const valuesBefore = await row('SELECT sbp,dbp,scr_umol_l,upcr,egfr FROM public.visits_long WHERE id=$1', [pv]);
  const at = await as(editor, async () => (await row('SELECT public.mark_patient_visit_reviewed($1,$2) AS t', [pid, pv])).t);
  assert.ok(at);
  assert.deepEqual(await row('SELECT sbp,dbp,scr_umol_l,upcr,egfr FROM public.visits_long WHERE id=$1', [pv]), valuesBefore, 'no clinical value changes');
  assert.equal(String(await as(editor, async () => (await row('SELECT public.mark_patient_visit_reviewed($1,$2) AS t', [pid, pv])).t)), String(at), 'a second mark keeps the first time');
  pass('a writer marks a patient-submitted follow-up as reviewed; staff entries and viewers are refused; clinical values untouched');

  // ---- Patient links say why they stopped working ----------------------------------------
  const read = token => as(null, () => db.query('SELECT * FROM public.patient_get_context($1)', [token]));
  await assert.rejects(read(link), is('single_use_token_already_used'));
  const revoked = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'P-1',30,false) AS t", [pid])).t);
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'患者更换联系方式')", [revoked]));
  await assert.rejects(read(revoked), is('token_revoked'));
  const expired = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'P-1',30,false) AS t", [pid])).t);
  await db.query("UPDATE public.patient_tokens SET expires_at=now()-interval '1 minute' WHERE project_id=$1 AND revoked_at IS NULL AND used_at IS NULL", [pid]);
  await assert.rejects(read(expired), is('token_expired'));
  await assert.rejects(read('synthetic-unknown-link'), is('token_invalid_or_expired'));
  pass('a link holder learns whether the link was used, revoked or expired; an unknown link only gets the generic token_invalid_or_expired');

  // ---- Project creation with an interval; account rules unchanged -----------------------
  const created = await as(editor, async () => (await row("SELECT public.create_project('Synthetic interval','SYI','IGAN',NULL,180) AS id")).id);
  assert.equal((await row('SELECT followup_interval_days AS d FROM public.projects WHERE id=$1', [created])).d, 180);
  await as(viewer, async () => assert.ok((await row("SELECT public.create_project('Synthetic default','SYD') AS id")).id, 'the short call still works'));
  assert.equal((await row("SELECT followup_interval_days AS d FROM public.projects WHERE name='Synthetic default'")).d, 90);
  await as(owner, () => assert.rejects(row("SELECT public.create_project('Synthetic bad','SYB','IGAN',NULL,5)"), is('invalid_followup_interval')));
  await as(owner, () => assert.rejects(row("SELECT public.create_project('Synthetic over quota','SYQ')"), is('project_quota_exceeded')),
    'the account guard (quota) still applies');
  assert.equal((await row('SELECT public._account_access($1) AS a', [lapsed])).a.can_write, false, 'account access is unchanged');
  pass('projects can be created with a follow-up interval (7–730 days, default 90); account access rules unchanged');

  console.log(`QC_ENTRY_REVIEW_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  await db.close();
}
