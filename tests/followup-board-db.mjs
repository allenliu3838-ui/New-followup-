// Native PG17 acceptance for 0041 (reminder start date for retrospective patients and bulk
// consent confirmation on the follow-up board). The database is first built to 0040 and
// filled the way production looks today (historical patients with baselines years ago, all
// consent unconfirmed, a patient with several active links); 0041 is then applied as the
// reviewed increment. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

// Further sessions on the same synthetic server, for lock-order checks.
const extraClients = [];
async function connectOther() {
  const socket = (await row('SHOW unix_socket_directories')).unix_socket_directories;
  const client = new pg.Client({host: socket, port: 55432, user: 'postgres', database: 'postgres'});
  await client.connect();
  extraClients.push(client);
  await client.query("SET timezone='Asia/Shanghai'; SET deadlock_timeout='100ms'; SET statement_timeout='10s'");
  return client;
}

// Calendar dates are compared as the database's own YYYY-MM-DD text.
pg.types.setTypeParser(1082, value => value);

assert.equal(process.argv.length, 2, 'Synthetic follow-up board acceptance accepts no external input');
const NEW_MIGRATION = '0041_followup_board.sql';
const db = await createDatabase();
await db.exec("SET timezone='Asia/Shanghai'");
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (sql, args = []) => Number((await row(sql, args)).n);
const denied = error => error.code === '42501';
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
const email = {[owner]: 'board-owner@example.invalid', [editor]: 'board-editor@example.invalid',
  [analyst]: 'board-analyst@example.invalid', [viewer]: 'board-viewer@example.invalid', [outsider]: 'board-outsider@example.invalid'};
const project = randomUUID(), otherProject = randomUUID();
const day = async offset => (await row('SELECT (registry_private.local_today() + $1::int)::text AS d', [offset])).d;
const REASON = '历史补录患者，从今天开始提醒';
const BASIS = '纸质知情同意书存档于研究办公室 A 柜';
const setStart = (user, codes, date, reason = REASON, pid = project) => as(user, async () =>
  (await row('SELECT public.set_followup_start_date($1,$2::text[],$3::date,$4) AS r', [pid, codes, date, reason])).r);
const setConsent = (user, codes, status, version, date, reason = BASIS, pid = project) => as(user, async () =>
  (await row('SELECT public.set_consent_bulk($1,$2::text[],$3,$4,$5::date,$6) AS r', [pid, codes, status, version, date, reason])).r);
const setStatus = (user, code, changes, reason) => as(user, async () =>
  (await row('SELECT public.set_patient_study_status($1,$2,$3,$4) AS r', [project, code, JSON.stringify(changes), reason])).r);
const board = async code => (await as(owner, () => row('SELECT * FROM public.v_patient_followup_status WHERE project_id=$1 AND patient_code=$2', [project, code])));
const baseline = code => row('SELECT * FROM public.patients_baseline WHERE project_id=$1 AND patient_code=$2', [project, code]);
const startAudits = code => rows(`SELECT old_value,new_value,changed_by,change_reason FROM public.field_audit_log
  WHERE table_name='patients_baseline' AND patient_code=$1 AND field_name='followup_start_date' ORDER BY changed_at,id`, [code]);
const ALL_CODES = ['H-OLD', 'H-VISIT', 'H-RECENT', 'N-NEW', 'S-1', 'S-2', 'S-3', 'B-1', 'B-2', 'B-3', 'L-1', 'L-2', 'X-1', 'X-2'];

try {
  // ---- Production-like database at 0040 ------------------------------------------------
  const upTo40 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 40);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 40), [NEW_MIGRATION, '0042_c3g_module.sql', '0043_biopsy_records.sql', '0044_project_fields.sql', '0045_cystatin_urine_rbc.sql'],
    '0041 directly follows 0040; 0042 and 0043 have their own acceptance (tests/c3g-module-db.mjs, tests/biopsy-records-db.mjs)');
  for (const file of upTo40) await apply(file);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 9);
  for (const id of [owner, editor, analyst, viewer, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email[id]]);
    await db.query(`INSERT INTO public.user_profiles(user_id,account_trial_started_at,account_trial_expires_at)
      VALUES($1,now(),now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET account_trial_expires_at=EXCLUDED.account_trial_expires_at`, [id]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic board project','SYN','IGAN',$2)", [project, owner]);
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic separate project','OTH','IGAN',$2)", [otherProject, outsider]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r',
      [project, email[user], role])).r.status, 'added'));
  }
  // Historical patients: baseline in 2014 (one also has a 2015 visit); recent patients.
  const baselineOf = {'H-OLD': '2014-03-01', 'H-VISIT': '2014-05-01', 'H-RECENT': await day(-200), 'N-NEW': await day(-30)};
  for (const code of ALL_CODES) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,$3::date,'F',1980,88.4,$4)",
      [project, code, baselineOf[code] || await day(-400), owner]);
  }
  await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,'P-OTHER',CURRENT_DATE-400,'M',1975,90,$2)", [otherProject, outsider]);
  await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,created_by) VALUES($1,'H-VISIT','2015-06-01',120,80,$2)", [project, owner]);
  await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,created_by) VALUES($1,'H-RECENT',$2::date,120,80,$3)", [project, await day(-100), owner]);
  // Several active links for L-1 and L-2 (the board shows the count).
  for (const code of ['L-1', 'L-1', 'L-1', 'L-2', 'L-2']) {
    await as(editor, () => row('SELECT public.create_patient_token_v2($1,$2,30,false)', [project, code]));
  }
  const snapshot = async () => ({
    baseline: (await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b ORDER BY id')).map(r => r.r),
    board: (await as(owner, () => rows('SELECT to_jsonb(s) AS r FROM public.v_patient_followup_status s ORDER BY patient_id'))).map(r => r.r),
    overview: (await as(owner, () => rows('SELECT to_jsonb(o) AS r FROM public.v_project_overview o ORDER BY project_id'))).map(r => r.r),
    audits: await count('SELECT count(*) AS n FROM public.field_audit_log'),
    security: await count('SELECT count(*) AS n FROM public.security_audit_logs'),
  });
  const before = await snapshot();
  const old = before.board.find(r => r.patient_code === 'H-OLD');
  assert.equal(old.followup_state, 'overdue');
  assert.ok(await count("SELECT (registry_private.local_today() - $1::date) AS n", [old.next_due_date]) > 4000, 'a 2014 baseline is overdue by thousands of days');
  assert.equal(before.board.find(r => r.patient_code === 'H-VISIT').followup_state, 'overdue');
  pass('0040 database: historical patients are overdue by thousands of days, every consent is unconfirmed');

  // ---- The increment refuses to run before 0040 -----------------------------------------
  await db.exec("BEGIN; DELETE FROM public.registry_schema_versions WHERE version='0040_batch_import'");
  await assert.rejects(apply(NEW_MIGRATION), /尚未执行迁移 0040.*需人工核对后再迁移/);
  await db.exec('ROLLBACK');
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 9);
  assert.equal(await count("SELECT count(*) AS n FROM information_schema.columns WHERE table_name='patients_baseline' AND column_name='followup_start_date'"), 0);
  pass('0041 stops before any change when 0040 is not registered');

  // ---- Upgrade and re-run -------------------------------------------------------------------
  await apply(NEW_MIGRATION);
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 10);
  assert.equal(await count("SELECT count(*) AS n FROM public.registry_schema_versions WHERE version='0041_followup_board'"), 1);
  const after = await snapshot();
  assert.deepEqual(after.baseline, before.baseline.map(r => ({...r, followup_start_date: null})), 'every stored value unchanged; the new column is empty');
  assert.deepEqual(after.board, before.board.map(r => ({...r, followup_start_date: null})), 'without a reminder start date the board is unchanged');
  assert.deepEqual(after.overview, before.overview);
  assert.equal(after.audits, before.audits, 'no field audit entries');
  assert.equal(after.security, before.security);
  await apply(NEW_MIGRATION);
  assert.deepEqual(await snapshot(), after, 're-running 0041 changes nothing');
  assert.equal(await count('SELECT count(*) AS n FROM public.registry_schema_versions'), 10);
  pass('0041 keeps every existing value (new column empty, board and overview unchanged) and re-runs without effect');

  // ---- Grants and private helpers ---------------------------------------------------------------
  for (const fn of ['public.set_followup_start_date(uuid,text[],date,text)', 'public.set_consent_bulk(uuid,text[],text,text,date,text)']) {
    assert.deepEqual(await row(`SELECT p.prosecdef,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('public',p.oid,'EXECUTE') AS pub FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn]),
    {prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], auth: true, anon: false, pub: false}, fn);
  }
  for (const fn of ['registry_private.followup_start_rpc_active(uuid)', 'registry_private.check_followup_start_date()']) {
    assert.deepEqual(await row(`SELECT has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn]), {auth: false, anon: false}, fn);
  }
  assert.deepEqual(await row(`SELECT c.relrowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS auth,
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon FROM pg_class c WHERE c.oid='registry_private.followup_start_rpc_rows'::regclass`),
  {relrowsecurity: true, auth: false, anon: false});
  assert.equal(await count('SELECT count(*) AS n FROM registry_private.followup_start_rpc_rows'), 0);
  await as(null, () => assert.rejects(db.query('SELECT public.set_followup_start_date($1,$2::text[],CURRENT_DATE,$3)', [project, ['H-OLD'], REASON]), denied));
  await as(null, () => assert.rejects(db.query("SELECT public.set_consent_bulk($1,$2::text[],'consented',NULL,NULL,$3)", [project, ['S-1'], BASIS]), denied));
  await as(null, () => assert.rejects(db.query('SELECT * FROM public.v_patient_followup_status'), denied));
  assert.equal((await row("SELECT 'security_invoker=true'=ANY(reloptions) AS inv FROM pg_class WHERE oid='public.v_patient_followup_status'::regclass")).inv, true);
  pass('new RPCs run with a fixed search path for signed-in users only; the marker table and helpers are private; the view keeps caller privileges');

  // ---- Reminder start date: anchor ---------------------------------------------------------------
  const today = await day(0);
  const r1 = await setStart(owner, ['H-OLD', 'H-VISIT'], today);
  assert.deepEqual(r1, {requested: 2, changed: 2, unchanged: 0, followup_start_date: today});
  let s = await board('H-OLD');
  assert.deepEqual([s.followup_start_date, s.next_due_date, s.followup_state], [today, await day(90), 'no_visit'], 'no visit: counts from the start date');
  s = await board('H-VISIT');
  assert.deepEqual([s.last_visit_date, s.next_due_date, s.followup_state], ['2015-06-01', await day(90), 'ok'], 'start date later than the last (historical) visit wins');
  // A start date earlier than the latest visit does not move the due date back.
  await setStart(editor, ['H-RECENT'], await day(-150));
  s = await board('H-RECENT');
  assert.deepEqual([s.followup_start_date, s.next_due_date, s.followup_state], [await day(-150), await day(-10), 'overdue'], 'latest visit later than the start date wins');
  // A past start date: due 90 days later.
  await setStart(owner, ['H-OLD'], await day(-80));
  s = await board('H-OLD');
  assert.deepEqual([s.next_due_date, s.followup_state], [await day(10), 'due_soon']);
  // A visit after the start date takes over as the anchor.
  await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,created_by) VALUES($1,'H-OLD',$2::date,118,76,$3)", [project, await day(-5), owner]);
  s = await board('H-OLD');
  assert.deepEqual([s.next_due_date, s.followup_state], [await day(85), 'ok']);
  await db.query("DELETE FROM public.visits_long WHERE project_id=$1 AND patient_code='H-OLD'", [project]);
  // Clearing restores the baseline anchor.
  assert.equal((await setStart(owner, ['H-OLD'], null, '起算日设置有误，恢复按基线日期')).changed, 1);
  s = await board('H-OLD');
  assert.deepEqual([s.followup_start_date, s.next_due_date, s.followup_state], [null, old.next_due_date, 'overdue']);
  await setStart(owner, ['H-OLD'], today);
  // The same date again is not a change and writes no audit entry.
  const auditsBefore = (await startAudits('H-VISIT')).length;
  assert.deepEqual(await setStart(owner, ['H-VISIT', 'H-OLD'], today), {requested: 2, changed: 0, unchanged: 2, followup_start_date: today});
  assert.equal((await startAudits('H-VISIT')).length, auditsBefore);
  const overview = await as(owner, () => row('SELECT n_overdue,n_no_visit FROM public.v_project_overview WHERE project_id=$1', [project]));
  assert.equal(overview.n_overdue, after.overview.find(o => o.project_id === project).n_overdue - 2, 'H-OLD and H-VISIT no longer count as overdue; H-RECENT still does');
  pass('next due date counts from the later of the latest visit and the reminder start date, otherwise the baseline date; clearing restores the baseline anchor; repeating a date is not a change');

  // ---- Reminder start date: audits --------------------------------------------------------------
  const audits = await startAudits('H-OLD');
  assert.deepEqual(audits.map(a => [a.old_value, a.new_value, a.changed_by, a.change_reason]), [
    [null, today, owner, REASON], [today, await day(-80), owner, REASON],
    [await day(-80), null, owner, '起算日设置有误，恢复按基线日期'], [null, today, owner, REASON]]);
  assert.deepEqual((await startAudits('H-RECENT')).map(a => [a.new_value, a.changed_by]), [[await day(-150), editor]]);
  const log = await rows("SELECT actor_uid,details FROM public.audit_log WHERE project_id=$1 AND action='followup_start_date_set' ORDER BY created_at,id", [project]);
  assert.equal(log.length, 5, 'one project audit entry per call that changed something');
  assert.deepEqual(log[0].details, {followup_start_date: today, reason: REASON, requested: 2, changed: 2});
  assert.equal(log[0].actor_uid, owner);
  assert.equal(await count('SELECT count(*) AS n FROM registry_private.followup_start_rpc_rows'), 0, 'markers live only for the UPDATE');
  pass('every change is field-audited with old and new date, user and reason; each call that changes something leaves one project audit entry');

  // ---- Reminder start date: permissions and validation -----------------------------------------------
  const unchangedStart = async fn => {
    const beforeRows = await rows('SELECT patient_code,followup_start_date FROM public.patients_baseline ORDER BY id');
    await fn();
    assert.deepEqual(await rows('SELECT patient_code,followup_start_date FROM public.patients_baseline ORDER BY id'), beforeRows, 'nothing changed');
  };
  for (const user of [viewer, analyst, outsider]) {
    await unchangedStart(async () => assert.rejects(setStart(user, ['N-NEW'], today), error => denied(error) && is('project_access_denied')(error)));
  }
  await unchangedStart(async () => assert.rejects(setStart(owner, ['P-OTHER'], today, REASON, otherProject), is('project_access_denied')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW', 'P-OTHER'], today), is('patient_not_found')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW'], await day(1)), is('invalid_or_future_date: followup_start_date')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW', 'H-OLD'], '2014-01-01'), is('followup_start_before_baseline')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW'], await day(-31)), is('followup_start_before_baseline')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW'], '1899-12-31'), is('date_before_1900: followup_start_date')));
  for (const reason of [null, '', ' 补 ', '补', '补'.repeat(501), '原因\u0007', '原因\u001b[0m']) {
    await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW'], today, reason), is('bulk_reason_required'), JSON.stringify(reason)));
  }
  // A reason may span several lines, as in the single-patient paths (tab, newline, carriage return).
  assert.equal((await setStart(owner, ['N-NEW'], today, '历史补录患者\n\t从今天开始提醒\r\n核对人：研究护士')).changed, 1);
  assert.equal((await startAudits('N-NEW')).at(-1).change_reason, '历史补录患者\n\t从今天开始提醒\r\n核对人：研究护士');
  assert.equal((await setStart(owner, ['N-NEW'], null, '恢复\n按基线日期')).changed, 1);
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW'], today, '患者电话13812345678'), is('pii_detected_blocked')));
  await unchangedStart(async () => assert.rejects(setStart(owner, [], today), is('patient_codes_required')));
  await unchangedStart(async () => assert.rejects(setStart(owner, null, today), is('patient_codes_required')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW', 'N-NEW'], today), is('invalid_patient_code_list')));
  await unchangedStart(async () => assert.rejects(setStart(owner, ['N-NEW', null], today), is('invalid_patient_code_list')));
  await unchangedStart(async () => assert.rejects(setStart(owner, Array.from({length: 501}, (_, i) => `Z-${i}`), today), is('too_many_patients')));
  // 500 patients in one call is allowed (here: 486 unknown codes are refused as a whole).
  await unchangedStart(async () => assert.rejects(setStart(owner, [...ALL_CODES, ...Array.from({length: 486}, (_, i) => `Z-${i}`)], today), is('patient_not_found')));
  assert.equal((await setStart(editor, ALL_CODES.filter(c => c !== 'N-NEW' && c !== 'H-RECENT'), today)).requested, 12);
  pass('set_followup_start_date: editors and the owner only (viewer, analyst, other project refused); 1–500 distinct codes of this project; not after today, not before baseline; reason 2–500 characters without identifying information; all or none');

  // ---- Direct writes, import and correction cannot change it ----------------------------------------------
  const target = await baseline('N-NEW');
  for (const user of [owner, editor]) {
    await as(user, () => assert.rejects(db.query('UPDATE public.patients_baseline SET followup_start_date=CURRENT_DATE WHERE id=$1', [target.id]), is('followup_start_date_requires_dedicated_action')));
    await as(user, () => assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,followup_start_date,created_by) VALUES($1,'NEW-DIRECT',CURRENT_DATE-10,CURRENT_DATE,$2)", [project, user]), is('followup_start_date_requires_dedicated_action')));
  }
  await assert.rejects(db.query('UPDATE public.patients_baseline SET followup_start_date=CURRENT_DATE WHERE id=$1', [target.id]), is('followup_start_date_requires_dedicated_action'), 'not even without a signed-in user');
  await db.exec("BEGIN; SELECT set_config('app.registry_change_reason','试图绕过',true)");
  await assert.rejects(db.query('UPDATE public.patients_baseline SET followup_start_date=CURRENT_DATE WHERE id=$1', [target.id]), is('followup_start_date_requires_dedicated_action'), 'a session setting does not stand in for the RPC');
  await db.exec('ROLLBACK');
  await as(owner, () => assert.rejects(row("SELECT public.import_registry_rows($1,'baseline',$2,$3)", [project, JSON.stringify([{patient_code: 'N-NEW', followup_start_date: today}]), randomUUID()]), is('unsupported_column: followup_start_date')));
  await as(owner, () => assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,$3,'按原始记录更正')", [project, target.id, JSON.stringify({followup_start_date: today})]), is('unsupported_column: followup_start_date')));
  // Other writes to the row still work and leave the date alone.
  await as(owner, () => db.query("UPDATE public.patients_baseline SET sex='M' WHERE id=$1", [target.id]));
  await setStatus(owner, 'H-OLD', {consent_status: 'consented', consent_date: await day(-1)}, null);
  assert.equal((await baseline('H-OLD')).followup_start_date, today);
  assert.equal((await baseline('N-NEW')).followup_start_date, null);
  pass('a reminder start date is never set by a direct insert or update (with or without a user or session setting), CSV import or audited correction; other baseline writes are unaffected');

  // ---- Bulk consent: same result as the single-patient path ---------------------------------------------
  const consentFields = r => ({consent_status: r.consent_status, consent_date: r.consent_date, consent_version: r.consent_version,
    consent_research: r.consent_research, followup_status: r.followup_status, followup_status_date: r.followup_status_date});
  const consentAudits = code => rows(`SELECT field_name,old_value,new_value,changed_by,change_reason FROM public.field_audit_log
    WHERE table_name='patients_baseline' AND patient_code=$1 AND field_name LIKE 'consent%' ORDER BY field_name,changed_at`, [code]);
  const signed = await day(-10);
  const changes = {consent_status: 'consented', consent_version: ' V2.0（2026-03-01） ', consent_date: signed};
  for (const code of ['S-1', 'S-2', 'S-3']) await setStatus(editor, code, changes, BASIS);
  const bulk = await setConsent(editor, ['B-3', 'B-1', 'B-2'], 'consented', ' V2.0（2026-03-01） ', signed);
  assert.deepEqual(bulk, {requested: 3, changed: 3, unchanged: 0, consent_status: 'consented'});
  for (const [single, many] of [['S-1', 'B-1'], ['S-2', 'B-2'], ['S-3', 'B-3']]) {
    assert.deepEqual(consentFields(await baseline(many)), consentFields(await baseline(single)), `${many} equals ${single}`);
    assert.deepEqual(await consentAudits(many), await consentAudits(single), `${many}: same field audits as ${single}`);
  }
  assert.deepEqual(consentFields(await baseline('B-1')), {consent_status: 'consented', consent_date: signed, consent_version: 'V2.0（2026-03-01）',
    consent_research: true, followup_status: 'active', followup_status_date: null});
  assert.deepEqual((await consentAudits('B-1')).map(a => [a.field_name, a.new_value, a.change_reason]),
    [['consent_date', signed, BASIS], ['consent_research', 'true', BASIS], ['consent_status', 'consented', BASIS], ['consent_version', 'V2.0（2026-03-01）', BASIS]]);
  // Repeating the same confirmation changes nothing; without a version or date the recorded ones stay.
  assert.deepEqual(await setConsent(owner, ['B-1', 'B-2'], 'consented', 'V2.0（2026-03-01）', signed), {requested: 2, changed: 0, unchanged: 2, consent_status: 'consented'});
  assert.deepEqual(await setConsent(owner, ['B-1'], 'consented', null, null), {requested: 1, changed: 0, unchanged: 1, consent_status: 'consented'});
  assert.equal((await consentAudits('B-1')).length, 4);
  // Another status without a date clears the old status's date and keeps the version, exactly as
  // the single-patient dialog submits it (it empties the date field when the status changes).
  await setStatus(owner, 'S-3', {consent_status: 'waiver', consent_date: ''}, BASIS);
  await setConsent(owner, ['B-3'], 'waiver', null, null);
  assert.deepEqual([(await baseline('B-3')).consent_date, (await baseline('B-3')).consent_version], [null, 'V2.0（2026-03-01）']);
  // An empty version text clears it.
  await setStatus(owner, 'S-2', {consent_status: 'consented', consent_version: ''}, BASIS);
  await setConsent(owner, ['B-2'], 'consented', '', null);
  assert.deepEqual(consentFields(await baseline('B-2')), consentFields(await baseline('S-2')));
  assert.deepEqual(await consentAudits('B-2'), await consentAudits('S-2'));
  assert.equal((await baseline('B-2')).consent_version, null);
  assert.deepEqual(consentFields(await baseline('B-3')), consentFields(await baseline('S-3')));
  assert.deepEqual(await consentAudits('B-3'), await consentAudits('S-3'));
  const bulkLog = await rows("SELECT actor_uid,details FROM public.audit_log WHERE project_id=$1 AND action='consent_bulk_set' ORDER BY created_at,id", [project]);
  assert.equal(bulkLog.length, 3);
  assert.deepEqual(bulkLog[0].details, {consent_status: 'consented', consent_version: 'V2.0（2026-03-01）', consent_date: signed, reason: BASIS, requested: 3, changed: 3});
  pass('bulk consent writes exactly the values and field audits of set_patient_study_status for each patient; repeating is not a change; a missing version is kept, a missing date is kept for the same status and cleared for another, an empty version clears it');

  // Declining revokes the patient's links exactly like the single-patient path.
  const activeLinks = code => count('SELECT count(*) AS n FROM public.patient_tokens WHERE project_id=$1 AND patient_code=$2 AND active AND revoked_at IS NULL', [project, code]);
  assert.deepEqual([await activeLinks('L-1'), await activeLinks('L-2')], [3, 2]);
  await setStatus(editor, 'L-1', {consent_status: 'declined', consent_date: await day(-1)}, '患者书面拒绝');
  await setConsent(editor, ['L-2'], 'declined', null, await day(-1), '患者书面拒绝');
  assert.deepEqual([await activeLinks('L-1'), await activeLinks('L-2')], [0, 0]);
  const exitAudit = async code => (await row("SELECT details FROM public.security_audit_logs WHERE patient_code=$1 AND event_type='study_exit_tokens_revoked'", [code])).details;
  assert.deepEqual([(await exitAudit('L-1')).reason, (await exitAudit('L-2')).reason, (await exitAudit('L-2')).revoked_token_count], ['consent_declined', 'consent_declined', 2]);
  assert.deepEqual(consentFields(await baseline('L-2')), consentFields(await baseline('L-1')));
  assert.deepEqual(await consentAudits('L-2'), await consentAudits('L-1'));
  pass('bulk declining revokes each patient\'s usable links and records the same exit audit as the single-patient path');

  // Validation errors are those of the single-patient path; the call is all or none and names the patient.
  const unchangedConsent = async fn => {
    const beforeRows = await rows('SELECT patient_code,consent_status,consent_date,consent_version FROM public.patients_baseline ORDER BY id');
    const beforeAudits = await count('SELECT count(*) AS n FROM public.field_audit_log');
    await fn();
    assert.deepEqual(await rows('SELECT patient_code,consent_status,consent_date,consent_version FROM public.patients_baseline ORDER BY id'), beforeRows, 'nothing changed');
    assert.equal(await count('SELECT count(*) AS n FROM public.field_audit_log'), beforeAudits);
  };
  for (const [status, version, date, expected] of [
    ['consented', null, await day(1), 'invalid_or_future_date: consent_date'],
    ['consented', 'V'.repeat(101), null, 'invalid_consent_version'],
    ['consented', 'V1\nV2', null, 'invalid_consent_version'],
  ]) {
    await unchangedConsent(async () => assert.rejects(setStatus(owner, 'X-1', {consent_status: status, consent_version: version ?? '', consent_date: date ?? ''}, BASIS), is(expected), `single ${expected}`));
    await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-2', 'X-1'], status, version, date), is(expected), `bulk ${expected}`));
  }
  for (const status of ['agreed', '', null]) await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1'], status, null, null), is('invalid_consent_status')));
  for (const user of [viewer, analyst, outsider]) await unchangedConsent(async () => assert.rejects(setConsent(user, ['X-1'], 'consented', null, null), is('project_access_denied')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, ['P-OTHER'], 'consented', null, null, BASIS, otherProject), is('project_access_denied')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1', 'P-OTHER'], 'consented', null, null), is('patient_not_found')));
  for (const reason of [null, '', '补', '补'.repeat(501), '依据\u0007', '依据\u001b']) await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1'], 'consented', null, null, reason), is('bulk_reason_required'), JSON.stringify(reason)));
  assert.equal((await setConsent(owner, ['X-2'], 'consented', 'V1.0', null, '纸质同意书\n存档于 A 柜\t第 3 盒')).changed, 1);
  assert.equal((await row("SELECT change_reason FROM public.field_audit_log WHERE patient_code='X-2' AND field_name='consent_status' ORDER BY changed_at DESC LIMIT 1")).change_reason, '纸质同意书\n存档于 A 柜\t第 3 盒');
  await setStatus(owner, 'X-2', {consent_status: 'unconfirmed', consent_version: '', consent_date: ''}, '恢复为未确认');
  await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1'], 'consented', null, null, '身份证 110101199001011234'), is('pii_detected_blocked')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, [], 'consented', null, null), is('patient_codes_required')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1', 'X-1'], 'consented', null, null), is('invalid_patient_code_list')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, Array.from({length: 501}, (_, i) => `Z-${i}`), 'consented', null, null), is('too_many_patients')));
  pass('bulk consent refuses invalid dates, versions and states exactly like the single-patient path; viewer, analyst and other projects are refused; 1–500 distinct codes; a 2–500 character basis without identifying information; all or none');

  // After the trial ends: like the single-patient path, only recording an exit is allowed, and one
  // patient whose change is not an exit undoes the whole call (the error names that patient).
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  await unchangedConsent(async () => assert.rejects(setStatus(owner, 'X-1', {consent_status: 'consented', consent_version: '', consent_date: ''}, BASIS), is('subscription_required')));
  await unchangedConsent(async () => assert.rejects(setConsent(owner, ['X-1'], 'consented', null, null), is('subscription_required')));
  await unchangedConsent(async () => assert.rejects(setStart(owner, ['X-1'], today), is('subscription_required')));
  let failure;
  await unchangedConsent(async () => { failure = await setConsent(editor, ['X-1', 'L-1'], 'withdrawn', null, await day(-1), '患者书面撤回').catch(e => e); });
  assert.equal(failure.message, 'subscription_required', 'declined -> withdrawn is not an exit-only change');
  assert.match(failure.detail, /研究编号 L-1；本次没有修改任何患者/);
  assert.equal((await setConsent(editor, ['X-1', 'X-2'], 'withdrawn', null, await day(-1), '患者书面撤回')).changed, 2, 'recording an exit is still allowed');
  await setStatus(editor, 'S-1', {consent_status: 'withdrawn', consent_date: await day(-1)}, '患者书面撤回');
  assert.deepEqual(consentFields(await baseline('X-1')), {...consentFields(await baseline('S-1')), consent_version: null});
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()+interval '30 days' WHERE user_id=$1", [owner]);
  pass('after the trial ends bulk consent follows the single-patient exit rules exactly; a refused patient undoes the whole call and is named in the error detail');

  // ---- Lock order: both bulk functions lock every requested row in id order, so two calls on the
  // same patients wait for each other instead of deadlocking --------------------------------------
  for (const fn of ['public.set_followup_start_date(uuid,text[],date,text)', 'public.set_consent_bulk(uuid,text[],text,text,date,text)']) {
    const src = (await row('SELECT pg_get_functiondef($1::regprocedure) AS s', [fn])).s;
    assert.match(src, /ORDER BY b\.id FOR UPDATE/, `${fn} locks the requested rows in id order`);
    assert.doesNotMatch(src, /patient_code COLLATE "C" FOR UPDATE/, `${fn} never locks in research-code order`);
  }
  // Two patients whose research-code order is the opposite of their id order: a function that
  // locked in code order would take K-1 first, one that locks in id order takes K-2 first.
  const lowId = '00000000-0000-4000-8000-00000000c0de', highId = 'ffffffff-ffff-4fff-8fff-ffffffffc0de';
  await db.query("INSERT INTO public.patients_baseline(id,project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,'K-1',CURRENT_DATE-100,'F',1980,88.4,$3),($4,$2,'K-2',CURRENT_DATE-100,'M',1975,90,$3)",
    [highId, project, owner, lowId]);
  const other = await connectOther();
  await db.exec("SET deadlock_timeout='100ms'; SET statement_timeout='10s'");
  // Session A holds the row that an id-ordered lock takes first (K-2, the lowest id).
  await other.query('BEGIN');
  await other.query("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='K-2' FOR UPDATE", [project]);
  // Session B: bulk consent for both patients; it must wait on K-2 before touching K-1.
  const waiting = setConsent(editor, ['K-1', 'K-2'], 'consented', 'V1.0', await day(-1));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await other.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ~ 'set_consent_bulk'")).rows[0].n, 1, 'the bulk call is waiting for the lock');
  // Session A now runs the other bulk function on the same two patients: it already holds K-2
  // and takes K-1 freely; with the old code order B would hold K-1 and both would deadlock.
  await other.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await other.query('SET LOCAL ROLE authenticated');
  const a = (await other.query('SELECT public.set_followup_start_date($1,$2::text[],$3::date,$4) AS r', [project, ['K-1', 'K-2'], today, REASON])).rows[0].r;
  assert.deepEqual([a.requested, a.changed], [2, 2]);
  await other.query('RESET ROLE');
  await other.query('COMMIT');
  const b = await waiting;
  assert.deepEqual([b.requested, b.changed], [2, 2], 'the waiting bulk call completes after A commits, without a deadlock (40P01)');
  assert.deepEqual((await rows("SELECT patient_code,consent_status,followup_start_date FROM public.patients_baseline WHERE project_id=$1 AND patient_code LIKE 'K-%' ORDER BY patient_code", [project])).map(r => [r.patient_code, r.consent_status, r.followup_start_date]),
    [['K-1', 'consented', today], ['K-2', 'consented', today]]);
  // The same crossing with the functions swapped.
  await other.query('BEGIN');
  await other.query("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='K-2' FOR UPDATE", [project]);
  const waiting2 = setStart(editor, ['K-1', 'K-2'], await day(-10));
  await new Promise(resolve => setTimeout(resolve, 300));
  await other.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await other.query('SET LOCAL ROLE authenticated');
  assert.equal((await other.query('SELECT public.set_consent_bulk($1,$2::text[],$3,$4,$5::date,$6) AS r', [project, ['K-1', 'K-2'], 'waiver', null, null, BASIS])).rows[0].r.changed, 2);
  await other.query('RESET ROLE');
  await other.query('COMMIT');
  assert.equal((await waiting2).changed, 2);
  await db.exec('RESET deadlock_timeout; RESET statement_timeout');
  pass('both bulk functions lock every requested baseline row in id order before changing anything: two sessions crossing on the same patients wait for each other and both complete');

  assert.equal(await count('SELECT count(*) AS n FROM registry_private.study_status_rpc_rows'), 0);
  console.log(`FOLLOWUP_BOARD_DB_OK ${groups} groups; synthetic database only.`);
} finally {
  for (const client of extraClients) await client.end().catch(() => {});
  await db.close();
}
