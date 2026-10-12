// Native PG17 acceptance for 0038 (follow-up workflow) and 0039 (hashed follow-up links).
// The database is first built to 0037 and filled the way production looks today:
// research consent only holds its schema default (true) and links are stored in
// plaintext. 0038/0039 are then applied as the reviewed increments. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

assert.equal(process.argv.length, 2, 'Synthetic adoption acceptance accepts no external input');
const NEW_MIGRATIONS = ['0038_followup_workflow.sql', '0039_patient_token_hashing.sql'];
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const db = await createDatabase();
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const denied = error => error.code === '42501';
const fails = code => error => String(error.message).includes(code);

async function as(user, operation) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  await db.exec(`SET ROLE ${user ? 'authenticated' : 'anon'}`);
  try { return await operation(); }
  finally { await db.exec('RESET ROLE; RESET request.jwt.claim.sub;'); }
}

async function applyReviewed(files) {
  for (const file of files) {
    const entry = migrations.find(m => m.file === file);
    assert.ok(entry, `${file} is listed in the reviewed migration manifest`);
    const bytes = fs.readFileSync(path.join(root, 'supabase/migrations', file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, file);
    try { await db.exec(bytes.toString('utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`, {cause: e}); }
  }
}

const [owner, editor, analyst, viewer, outsider] = Array.from({length: 5}, () => randomUUID());
const project = randomUUID(), otherProject = randomUUID();
const codes = ['SYN-NOVISIT', 'SYN-OK', 'SYN-DUE', 'SYN-DUE0', 'SYN-OK15', 'SYN-OVER', 'SYN-LOST', 'SYN-LINK'];
// Visit offsets from today (negative = past). true = all core fields recorded.
const visits = {
  'SYN-OK': [[-10, true]], 'SYN-DUE': [[-200, true], [-80, false]], 'SYN-DUE0': [[-90, true]],
  'SYN-OK15': [[-75, false]], 'SYN-OVER': [[-91, true]], 'SYN-LOST': [[-300, false]]
};
const plaintext = {};

try {
  const upTo37 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 37);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 37), NEW_MIGRATIONS,
    'exactly the two reviewed increments follow 0037');
  await applyReviewed(upTo37);
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n), 6);

  // ---- Production-like state at 0037 -------------------------------------------------
  for (const [id, name] of [[owner, 'owner'], [editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer'], [outsider, 'outsider']]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `adoption-${name}@example.invalid`]);
  }
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic adoption project','SYN','IGAN',$2)", [project, owner]);
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic separate project','OTH','IGAN',$2)", [otherProject, outsider]);
  for (const [user, role] of [[editor, 'editor'], [analyst, 'analyst'], [viewer, 'viewer']]) {
    await as(owner, async () => assert.equal((await row('SELECT public.add_project_member($1,$2,$3) AS r',
      [project, `adoption-${role}@example.invalid`, role])).r.status, 'added'));
  }
  for (const code of codes) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,CURRENT_DATE-400,'F',1980,88.4,$3)", [project, code, owner]);
  }
  await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,'SYN-OK',CURRENT_DATE-400,'M',1975,90,$2)", [otherProject, outsider]);
  for (const [code, list] of Object.entries(visits)) {
    for (const [offset, complete] of list) {
      await db.query(`INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,notes,created_by)
        VALUES($1,$2,CURRENT_DATE+$3::int,$4,$5,$6,$7,'Synthetic visit',$8)`,
      [project, code, offset, code === 'SYN-OK15' ? null : 128, code === 'SYN-OK15' ? null : 78,
        code === 'SYN-LOST' ? null : 90, complete ? 300 : null, owner]);
    }
  }
  const tokenSpecs = [
    ['valid', 'SYN-LINK', project], ['single', 'SYN-LINK', project], ['expired', 'SYN-LINK', project],
    ['revoked', 'SYN-LINK', project], ['consumed', 'SYN-LINK', project], ['inactive', 'SYN-LINK', project],
    ['withdraw', 'SYN-DUE', project], ['lost', 'SYN-LOST', project], ['other', 'SYN-OK', otherProject]
  ];
  for (const [state, code, pid] of tokenSpecs) {
    plaintext[state] = randomUUID().replaceAll('-', '');
    await db.query(`INSERT INTO public.patient_tokens(project_id,patient_code,token,active,expires_at,single_use,used_at,revoked_at,created_by)
      VALUES($1,$2,$3,$4,CASE WHEN $5='expired' THEN now()-interval '1 day' ELSE now()+interval '30 days' END,
        $5 IN ('single','consumed'),CASE WHEN $5='consumed' THEN now()-interval '1 hour' END,
        CASE WHEN $5='revoked' THEN now()-interval '1 hour' END,$6)`,
    [pid, code, plaintext[state], state !== 'inactive', state, pid === project ? owner : outsider]);
  }
  const submitted = await as(null, async () => row(
    'SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE-1,126,80,92,310,NULL,$2,$3)',
    [plaintext.valid, 'Synthetic patient entry', randomUUID()]));
  assert.equal(submitted.status, 'submitted');
  await db.query("INSERT INTO public.data_issues(project_id,patient_code,record_type,rule_code,severity,status,message) VALUES($1,'SYN-OK','baseline','SYNTHETIC_RESOLVED','info','RESOLVED','Synthetic resolved issue'),($1,'SYN-OK','baseline','SYNTHETIC_IN_PROGRESS','warning','IN_PROGRESS','Synthetic issue in progress')", [project]);

  const beforePatients = await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b ORDER BY id');
  const beforeTokens = await rows('SELECT to_jsonb(t) AS r FROM public.patient_tokens t ORDER BY id');
  assert.ok(beforePatients.every(({r}) => r.consent_research === true), 'production-like default consent');
  assert.ok(beforeTokens.every(({r}) => /^[0-9a-f]{32}$/.test(r.token)), 'production-like plaintext links');
  pass('0037 database holds production-like defaults, plaintext links, members, visits and a link submission');

  // ---- Upgrade --------------------------------------------------------------------------
  await applyReviewed(NEW_MIGRATIONS);
  assert.deepEqual((await rows('SELECT version FROM public.registry_schema_versions ORDER BY version')).map(r => r.version).slice(-2),
    ['0038_followup_workflow', '0039_patient_token_hashing']);
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n), 8);
  const afterPatients = new Map((await rows('SELECT to_jsonb(b) AS r FROM public.patients_baseline b')).map(({r}) => [r.id, r]));
  for (const {r: old} of beforePatients) {
    const now = afterPatients.get(old.id);
    assert.equal(now.consent_research, null, 'default consent cleared');
    assert.equal(now.consent_status, 'unconfirmed');
    assert.equal(now.followup_status, 'active');
    assert.equal(now.consent_date, null);
    assert.equal(now.followup_status_date, null);
    const {consent_research: _ignored, ...rest} = old;
    assert.deepEqual(Object.fromEntries(Object.keys(rest).map(k => [k, now[k]])), rest,
      'every other baseline value, including updated_at/updated_by, is unchanged');
  }
  const migrationAudit = await rows(`SELECT record_id,old_value,new_value,changed_by,change_reason FROM public.field_audit_log
    WHERE table_name='patients_baseline' AND field_name='consent_research'`);
  assert.equal(migrationAudit.length, beforePatients.length);
  assert.ok(migrationAudit.every(a => a.old_value === 'true' && a.new_value === null && a.changed_by === null
    && a.change_reason.startsWith('系统升级（0038）')), 'each cleared default is field-audited with the migration reason');
  assert.equal((await row("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='patients_baseline' AND column_name='consent_research'")).column_default, null);
  pass('0038 clears the never-entered consent default to unconfirmed, audits it and changes nothing else');

  const afterTokens = new Map((await rows('SELECT to_jsonb(t) AS r FROM public.patient_tokens t')).map(({r}) => [r.id, r]));
  for (const {r: old} of beforeTokens) {
    const now = afterTokens.get(old.id);
    assert.equal(now.token, null, 'plaintext erased');
    assert.equal(now.token_hash, sha256(old.token), 'digest of the former plaintext');
    const {token: _gone, ...rest} = old;
    assert.deepEqual(Object.fromEntries(Object.keys(rest).map(k => [k, now[k]])), rest, 'link state and metadata unchanged');
  }
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.patient_tokens WHERE token IS NOT NULL')).n), 0);
  const tokenIndexes = await rows("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='patient_tokens'");
  assert.ok(!tokenIndexes.some(i => /\(token\)/.test(i.indexdef)), 'no index keeps plaintext link keys');
  assert.ok(tokenIndexes.some(i => i.indexname === 'patient_tokens_token_hash_key' && /UNIQUE INDEX .*\(token_hash\)/.test(i.indexdef)));
  const tableText = (await rows('SELECT to_jsonb(t)::text AS t FROM public.patient_tokens t')).map(r => r.t).join('\n');
  for (const value of Object.values(plaintext)) assert.ok(!tableText.includes(value), 'no plaintext remains in any column');
  const submissionAudit = await row("SELECT token_hash FROM public.security_audit_logs WHERE event_type='visit_submitted'");
  assert.equal(submissionAudit.token_hash, sha256(plaintext.valid), 'link digest equals the existing audit digest');
  await assert.rejects(db.query("INSERT INTO public.patient_tokens(project_id,patient_code,token,token_hash) VALUES($1,'SYN-LINK','plaintext',$2)",
    [project, sha256('plaintext')]), error => error.code === '23514', 'a plaintext link can never be stored again');
  pass('0039 replaces every stored link by its SHA-256 digest; no plaintext remains; audit digests align');

  await as(null, async () => {
    const context = await row('SELECT * FROM public.patient_get_context($1)', [plaintext.valid]);
    assert.equal(context.patient_code, 'SYN-LINK');
    assert.equal(context.project_id, project);
    const columns = (await db.query('SELECT * FROM public.patient_get_context($1)', [plaintext.valid])).fields.map(f => f.name);
    assert.deepEqual(columns.slice(-4), ['public_title', 'institution_name', 'ethics_approval_no', 'contact_display']);
    assert.equal(columns.length, 19);
    for (const fn of ['patient_list_visits', 'patient_list_labs', 'patient_list_meds', 'patient_list_variants', 'patient_list_events']) {
      await db.query(`SELECT * FROM public.${fn}($1,30)`, [plaintext.valid]);
    }
    assert.equal((await rows('SELECT * FROM public.patient_list_visits($1,30)', [plaintext.valid])).length, 1);
    assert.equal((await row('SELECT * FROM public.patient_get_context($1)', [plaintext.single])).single_use, true);
    for (const bad of ['expired', 'revoked', 'consumed', 'inactive']) {
      await assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [plaintext[bad]]),
        error => denied(error) && /token_invalid_or_expired/.test(error.message), `${bad} link stays invalid`);
      await assert.rejects(db.query('SELECT * FROM public.patient_list_visits($1,30)', [plaintext[bad]]), denied);
    }
    for (const bad of [sha256(plaintext.valid), plaintext.valid.slice(0, -1), `${plaintext.valid} `, '', 'unknown-link']) {
      await assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [bad]), denied, 'digest or altered link is not a credential');
    }
    await assert.rejects(db.query('SELECT * FROM public.patient_get_context(NULL)'), denied);
    const replay = await row('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,124,79,91,305,NULL,$2,$3)',
      [plaintext.valid, 'Synthetic same-link entry', randomUUID()]);
    assert.equal(replay.status, 'submitted');
  });
  pass('links issued before the upgrade keep working by digest; invalid, altered and digest values are refused');

  // ---- set_patient_study_status ---------------------------------------------------------
  const setStatus = (code, changes, reason = null) =>
    row('SELECT public.set_patient_study_status($1,$2,$3,$4) AS r', [project, code, JSON.stringify(changes), reason]).then(x => x.r);
  const consentResearch = async code => (await row('SELECT consent_research FROM public.patients_baseline WHERE project_id=$1 AND patient_code=$2', [project, code])).consent_research;
  const ownerResult = await as(owner, () => setStatus('SYN-OK', {consent_status: 'consented', consent_date: '2025-01-15', consent_version: ' V2.1 '}, '核对纸质知情同意书'));
  assert.deepEqual(ownerResult, {patient_code: 'SYN-OK', consent_status: 'consented', consent_date: '2025-01-15', consent_version: 'V2.1',
    followup_status: 'active', followup_status_date: null, changed: true});
  assert.equal(await consentResearch('SYN-OK'), true);
  const editorResult = await as(editor, () => setStatus('SYN-DUE0', {consent_status: 'waiver'}));
  assert.equal(editorResult.consent_status, 'waiver');
  assert.equal(await consentResearch('SYN-DUE0'), true);
  assert.equal((await as(editor, () => setStatus('SYN-DUE0', {consent_status: 'waiver'}))).changed, false, 'no-op is reported');
  await as(editor, () => setStatus('SYN-OK15', {consent_status: 'declined', consent_date: ''}));
  assert.equal(await consentResearch('SYN-OK15'), false);
  await as(owner, () => setStatus('SYN-OK15', {consent_status: 'unconfirmed'}, '误选，恢复为未确认'));
  assert.equal(await consentResearch('SYN-OK15'), null);
  for (const user of [analyst, viewer, outsider]) {
    await as(user, async () => assert.rejects(setStatus('SYN-OK', {consent_status: 'withdrawn'}), denied));
  }
  await as(null, async () => assert.rejects(setStatus('SYN-OK', {consent_status: 'withdrawn'}), denied));
  await as(outsider, async () => assert.rejects(row("SELECT public.set_patient_study_status($1,'SYN-OK','{\"consent_status\":\"consented\"}')", [project]), denied));
  await as(editor, async () => {
    const rejected = [
      [{consent_research: true}, 'unsupported_column: consent_research'], [{patient_code: 'X'}, 'unsupported_column: patient_code'],
      [{sbp: 120}, 'unsupported_column: sbp'], [{}, 'study_status_changes_required'], [[], 'study_status_changes_required'],
      [{consent_status: 'yes'}, 'invalid_consent_status'], [{consent_status: null}, 'invalid_consent_status'],
      [{consent_status: 1}, 'invalid_consent_status'], [{followup_status: 'dead'}, 'invalid_followup_status'],
      [{followup_status: null}, 'invalid_followup_status'], [{consent_date: '2999-01-01'}, 'invalid_or_future_date'],
      [{consent_date: '15/01/2025'}, 'invalid_iso_date'], [{followup_status_date: '2025-02-30'}, 'invalid_iso_date'],
      [{consent_version: 'v'.repeat(101)}, 'invalid_consent_version'], [{consent_version: 'v1\nv2'}, 'invalid_consent_version']
    ];
    for (const [changes, code] of rejected) await assert.rejects(setStatus('SYN-OK', changes), fails(code), code);
    await assert.rejects(setStatus('SYN-UNKNOWN', {consent_status: 'consented'}), fails('patient_not_found'));
    await assert.rejects(setStatus('SYN-OK', {consent_status: 'withdrawn'}, '患者手机13812345678'), fails('pii_detected_blocked'));
    await assert.rejects(setStatus('SYN-OK', {consent_status: 'withdrawn'}, 'x'.repeat(501)), fails('reason_too_long'));
  });
  assert.equal((await row("SELECT consent_status FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-OK'", [project])).consent_status, 'consented');
  const audit = await rows(`SELECT field_name,old_value,new_value,changed_by,change_reason FROM public.field_audit_log a
    JOIN public.patients_baseline b ON b.id=a.record_id WHERE b.project_id=$1 AND b.patient_code='SYN-OK' AND a.changed_by IS NOT NULL ORDER BY field_name`, [project]);
  assert.deepEqual(audit.map(a => [a.field_name, a.old_value, a.new_value, a.changed_by, a.change_reason]), [
    ['consent_date', null, '2025-01-15', owner, '核对纸质知情同意书'],
    ['consent_research', null, 'true', owner, '核对纸质知情同意书'],
    ['consent_status', 'unconfirmed', 'consented', owner, '核对纸质知情同意书'],
    ['consent_version', null, 'V2.1', owner, '核对纸质知情同意书']]);
  assert.equal((await row(`SELECT change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id
    WHERE b.project_id=$1 AND b.patient_code='SYN-DUE0' AND a.field_name='consent_status'`, [project])).change_reason, '研究同意或随访状态更新（未填写原因）');
  pass('set_patient_study_status: owner/editor only, validated keys and values, derived consent flag, field audit with reason');

  await as(owner, async () => {
    await assert.rejects(db.query("UPDATE public.patients_baseline SET consent_research=false WHERE project_id=$1 AND patient_code='SYN-OK'", [project]),
      fails('consent_research_is_derived'));
    await assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,consent_research) VALUES($1,'SYN-NEW',CURRENT_DATE,true)", [project]),
      fails('consent_research_is_derived'));
    const imported = await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [project, 'baseline',
      JSON.stringify([{patient_code: 'SYN-CSV', baseline_date: '2025-03-01', consent_status: 'consented', consent_date: '2025-03-01', followup_status: 'active'}]), randomUUID()]);
    assert.equal(imported.r.inserted, 1);
    await assert.rejects(row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [project, 'baseline',
      JSON.stringify([{patient_code: 'SYN-CSV2', baseline_date: '2025-03-01', consent_research: 'true'}]), randomUUID()]), fails('unsupported_column: consent_research'));
    const csvId = (await row("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSV'", [project])).id;
    await assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"consent_status\":null}','核对原始记录')", [project, csvId]),
      fails('invalid_consent_status'));
    const corrected = await row("SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"consent_status\":\"withdrawn\"}','患者书面撤回同意') AS r", [project, csvId]);
    assert.equal(corrected.r.record.consent_research, false);
  });
  assert.equal(await consentResearch('SYN-CSV'), false);
  await db.query("DELETE FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSV'", [project]);
  pass('consent flag cannot be written directly; CSV import and audited correction use the explicit status fields');

  // Leaving the study revokes usable links on every write path; lost to follow-up does not.
  await as(editor, () => setStatus('SYN-DUE', {consent_status: 'withdrawn', consent_date: '2025-06-01'}, '患者撤回同意'));
  await as(owner, () => setStatus('SYN-LOST', {followup_status: 'lost', followup_status_date: '2025-08-01'}, '连续三次联系不上'));
  const exitLinks = await rows("SELECT patient_code,active,revoke_reason FROM public.patient_tokens WHERE project_id=$1 AND patient_code IN ('SYN-DUE','SYN-LOST') ORDER BY patient_code", [project]);
  assert.deepEqual(exitLinks, [{patient_code: 'SYN-DUE', active: false, revoke_reason: 'consent_withdrawn'}, {patient_code: 'SYN-LOST', active: true, revoke_reason: null}]);
  await as(null, async () => {
    await assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [plaintext.withdraw]), denied);
    assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [plaintext.lost])).patient_code, 'SYN-LOST');
  });
  assert.equal(Number((await row("SELECT count(*) AS n FROM public.security_audit_logs WHERE event_type='study_exit_tokens_revoked' AND patient_code='SYN-DUE'")).n), 1);
  pass('consent withdrawal stops link collection for that patient; loss to follow-up keeps the link');

  // ---- set_project_settings -------------------------------------------------------------
  const setSettings = settings => row('SELECT public.set_project_settings($1,$2) AS r', [project, JSON.stringify(settings)]).then(x => x.r);
  const settings = await as(owner, () => setSettings({public_title: ' 肾病长期随访研究 ', institution_name: '示例医院肾内科',
    ethics_approval_no: '伦审2026-001', contact_display: '研究护士 王老师', followup_interval_days: 90}));
  assert.deepEqual(settings, {followup_interval_days: 90, public_title: '肾病长期随访研究', institution_name: '示例医院肾内科',
    ethics_approval_no: '伦审2026-001', contact_display: '研究护士 王老师', changed: true});
  assert.equal((await as(owner, () => setSettings({followup_interval_days: '90'}))).changed, false);
  for (const user of [editor, analyst, viewer, outsider]) await as(user, async () => assert.rejects(setSettings({public_title: 'Denied'}), denied));
  await as(null, async () => assert.rejects(setSettings({public_title: 'Denied'}), denied));
  await as(owner, async () => {
    for (const [value, code] of [[{followup_interval_days: 6}, 'invalid_followup_interval'], [{followup_interval_days: 731}, 'invalid_followup_interval'],
      [{followup_interval_days: 90.5}, 'invalid_followup_interval'], [{followup_interval_days: 'abc'}, 'invalid_followup_interval'],
      [{followup_interval_days: null}, 'invalid_followup_interval'], [{name: 'x'}, 'unsupported_setting: name'],
      [{public_title: 't'.repeat(121)}, 'setting_too_long: public_title'], [{ethics_approval_no: 'e'.repeat(81)}, 'setting_too_long: ethics_approval_no'],
      [{contact_display: 5}, 'setting_text_required: contact_display'], [{contact_display: 'a\nb'}, 'invalid_setting_text: contact_display']]) {
      await assert.rejects(setSettings(value), fails(code), code);
    }
    await assert.rejects(row("SELECT public.set_project_settings($1,'[]')", [project]), fails('settings_must_be_object'));
  });
  assert.equal(Number((await row("SELECT count(*) AS n FROM public.audit_log WHERE project_id=$1 AND action='project_settings_updated'", [project])).n), 1);
  await as(null, async () => {
    const context = await row('SELECT public_title,institution_name,ethics_approval_no,contact_display FROM public.patient_get_context($1)', [plaintext.valid]);
    assert.deepEqual(context, {public_title: '肾病长期随访研究', institution_name: '示例医院肾内科', ethics_approval_no: '伦审2026-001', contact_display: '研究护士 王老师'});
  });
  pass('set_project_settings is owner-only and validated; the patient page receives the four study details');

  // ---- Workbench views ------------------------------------------------------------------
  const day = async offset => (await row('SELECT (CURRENT_DATE + $1::int)::text AS d', [offset])).d;
  const statusRows = async () => new Map((await rows(`SELECT patient_code,followup_state,next_due_date::text AS next_due,
    days_since_last_visit,visit_count,first_visit_date::text AS first_visit,last_visit_date::text AS last_visit,active_link_count,
    last_link_created_at,last_link_expires_at,last_patient_submission_at,center_code,consent_status,followup_status
    FROM public.v_patient_followup_status WHERE project_id=$1`, [project])).map(r => [r.patient_code, r]));
  const expected90 = {'SYN-NOVISIT': ['no_visit', -310], 'SYN-OK': ['ok', 80], 'SYN-DUE': ['due_soon', 10], 'SYN-DUE0': ['due_soon', 0],
    'SYN-OK15': ['ok', 15], 'SYN-OVER': ['overdue', -1], 'SYN-LOST': ['inactive', -210], 'SYN-LINK': ['ok', 90]};
  const ownerView = await as(owner, statusRows);
  assert.deepEqual([...ownerView.keys()].sort(), [...codes].sort());
  for (const [code, [state, due]] of Object.entries(expected90)) {
    assert.equal(ownerView.get(code).followup_state, state, `${code} state`);
    assert.equal(ownerView.get(code).next_due, await day(due), `${code} next due date`);
  }
  assert.equal(ownerView.get('SYN-NOVISIT').days_since_last_visit, null);
  assert.equal(ownerView.get('SYN-NOVISIT').visit_count, 0);
  assert.equal(ownerView.get('SYN-DUE').visit_count, 2);
  assert.equal(ownerView.get('SYN-DUE').first_visit, await day(-200));
  assert.equal(ownerView.get('SYN-DUE').days_since_last_visit, 80);
  assert.equal(ownerView.get('SYN-LINK').last_visit, await day(0));
  assert.equal(ownerView.get('SYN-LINK').center_code, 'SYN');
  assert.equal(ownerView.get('SYN-LINK').active_link_count, 2, 'valid multi-use and unused single-use links');
  assert.ok(ownerView.get('SYN-LINK').last_patient_submission_at instanceof Date);
  assert.ok(ownerView.get('SYN-LINK').last_link_created_at instanceof Date && ownerView.get('SYN-LINK').last_link_expires_at instanceof Date);
  assert.equal(ownerView.get('SYN-DUE').active_link_count, 0, 'revoked on consent withdrawal');
  assert.equal(ownerView.get('SYN-OK').last_patient_submission_at, null);
  assert.equal((await as(editor, statusRows)).get('SYN-LINK').active_link_count, 2);
  for (const user of [analyst, viewer]) {
    const limited = await as(user, statusRows);
    assert.equal(limited.size, codes.length, 'read members see every patient of the project');
    assert.equal(limited.get('SYN-OVER').followup_state, 'overdue');
    assert.ok([...limited.values()].every(r => r.active_link_count === 0 && r.last_link_created_at === null && r.last_link_expires_at === null),
      'members without link permission see no link details');
  }
  await as(outsider, async () => {
    assert.equal((await rows('SELECT * FROM public.v_patient_followup_status WHERE project_id=$1', [project])).length, 0);
    assert.deepEqual((await rows('SELECT patient_code,followup_state FROM public.v_patient_followup_status')), [{patient_code: 'SYN-OK', followup_state: 'no_visit'}]);
  });
  await as(owner, async () => assert.equal((await rows('SELECT * FROM public.v_patient_followup_status WHERE project_id=$1', [otherProject])).length, 0));
  await as(owner, () => setSettings({followup_interval_days: 30}));
  const shorter = await as(owner, statusRows);
  for (const [code, state] of Object.entries({'SYN-OK': 'ok', 'SYN-DUE': 'overdue', 'SYN-DUE0': 'overdue', 'SYN-OK15': 'overdue', 'SYN-LINK': 'ok', 'SYN-NOVISIT': 'no_visit', 'SYN-LOST': 'inactive'})) {
    assert.equal(shorter.get(code).followup_state, state, `${code} with a 30-day interval`);
  }
  assert.equal(shorter.get('SYN-OK').next_due, await day(20));
  await as(owner, () => setSettings({followup_interval_days: 90}));
  pass('v_patient_followup_status: all five follow-up states and boundaries, interval-driven, link columns by permission, project isolation');

  const overview = async pid => row('SELECT * FROM public.v_project_overview WHERE project_id=$1', [pid]);
  const expectedIssues = Number((await row("SELECT count(*) AS n FROM public.data_issues WHERE project_id=$1 AND status IN ('OPEN','IN_PROGRESS')", [project])).n);
  assert.ok(expectedIssues >= 2, 'at least the generated missing-core issue and the in-progress issue are open');
  const ownerOverview = await as(owner, () => overview(project));
  assert.deepEqual({...ownerOverview, last_visit_date: undefined}, {
    project_id: project, followup_interval_days: 90, n_patients: 8, n_active: 7, n_visits: 9, n_visits_30d: 3,
    n_core_complete_visits: 6, core_completeness: '0.6667', n_overdue: 1, n_due_soon: 2, n_no_visit: 1, last_visit_date: undefined,
    n_consent_confirmed: 2, n_consent_unconfirmed: 5, n_open_issues: expectedIssues});
  assert.equal((await as(owner, () => row('SELECT last_visit_date::text AS d FROM public.v_project_overview WHERE project_id=$1', [project]))).d, await day(0));
  for (const user of [editor, analyst, viewer]) assert.deepEqual(await as(user, () => overview(project)), ownerOverview);
  await as(outsider, async () => {
    assert.equal(await overview(project), undefined);
    const own = await overview(otherProject);
    assert.equal(own.n_patients, 1);
    assert.equal(own.n_visits, 0);
    assert.equal(own.core_completeness, null, 'no visits means completeness is unknown, not zero');
    assert.equal(own.n_no_visit, 1);
  });
  await as(owner, async () => assert.equal(await overview(otherProject), undefined));
  for (const view of ['v_patient_followup_status', 'v_project_overview']) {
    await as(null, async () => assert.rejects(db.query(`SELECT * FROM public.${view}`), denied, `${view}: anonymous denied`));
    const meta = await row(`SELECT c.reloptions,has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
      has_table_privilege('authenticated',c.oid,'SELECT') AS auth_select,
      has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS auth_write
      FROM pg_class c WHERE c.oid=('public.'||$1)::regclass`, [view]);
    assert.deepEqual(meta, {reloptions: ['security_invoker=true'], anon_select: false, auth_select: true, auth_write: false});
  }
  pass('v_project_overview: counts, core completeness, consent and open quality issues; same for every member; isolated; caller privileges only');

  // ---- Link issuing and revocation after 0039 -------------------------------------------
  const issued = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-OK',7,false) AS t", [project])).t);
  assert.match(issued, /^[0-9a-f]{32}$/);
  const stored = await row('SELECT id,token,token_hash,to_jsonb(t)::text AS raw FROM public.patient_tokens t WHERE token_hash=$1', [sha256(issued)]);
  assert.equal(stored.token, null);
  assert.ok(!stored.raw.includes(issued), 'only the digest is stored');
  await as(null, async () => assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [issued])).patient_code, 'SYN-OK'));
  await as(editor, async () => {
    const listed = await rows('SELECT id,token,token_hash FROM public.patient_tokens WHERE project_id=$1 AND patient_code=$2', [project, 'SYN-OK']);
    assert.deepEqual(listed, [{id: stored.id, token: null, token_hash: sha256(issued)}], 'link list carries no reusable credential');
  });
  for (const user of [analyst, viewer, outsider]) {
    await as(user, async () => assert.rejects(row("SELECT public.revoke_patient_token_by_id($1,$2,'无权撤销')", [project, stored.id]), denied));
  }
  await as(outsider, async () => assert.rejects(row("SELECT public.revoke_patient_token_by_id($1,$2,'跨项目')", [otherProject, stored.id]), fails('token_not_found')));
  await as(null, async () => assert.rejects(row("SELECT public.revoke_patient_token_by_id($1,$2,'匿名')", [project, stored.id]), denied));
  await as(owner, async () => {
    for (const reason of [null, '', '   ']) {
      await assert.rejects(row('SELECT public.revoke_patient_token_by_id($1,$2,$3)', [project, stored.id, reason]), fails('revoke_reason_required'));
    }
    await assert.rejects(row("SELECT public.revoke_patient_token_by_id($1,$2,'患者手机13812345678')", [project, stored.id]), fails('pii_detected_blocked'));
    await assert.rejects(row("SELECT public.revoke_patient_token_by_id($1,$2,'未知链接')", [project, randomUUID()]), fails('token_not_found'));
  });
  await as(null, async () => assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [issued])).patient_code, 'SYN-OK', 'refused revocations changed nothing'));
  await as(owner, () => row("SELECT public.revoke_patient_token_by_id($1,$2,'发错对象，重新生成')", [project, stored.id]));
  await as(owner, () => row("SELECT public.revoke_patient_token_by_id($1,$2,'重复撤销')", [project, stored.id]));
  const revoked = await row('SELECT active,revoked_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [stored.id]);
  assert.equal(revoked.active, false);
  assert.ok(revoked.revoked_at instanceof Date);
  assert.equal(revoked.revoke_reason, '发错对象，重新生成', 'a repeated revocation keeps the original reason');
  const revokeAudit = await rows("SELECT token_hash,actor_uid,details FROM public.security_audit_logs WHERE event_type='token_revoked' AND details->>'token_id'=$1", [stored.id]);
  assert.equal(revokeAudit.length, 1);
  assert.deepEqual([revokeAudit[0].token_hash, revokeAudit[0].actor_uid, revokeAudit[0].details.reason], [sha256(issued), owner, '发错对象，重新生成']);
  await as(null, async () => {
    for (const fn of ['patient_get_context($1)', 'patient_list_visits($1,30)', 'patient_list_labs($1,30)']) {
      await assert.rejects(db.query(`SELECT * FROM public.${fn}`, [issued]), error => denied(error) && /token_invalid_or_expired/.test(error.message));
    }
    await assert.rejects(db.query('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)', [issued, randomUUID()]), denied);
  });
  const legacy = await as(owner, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-OK15',7,true) AS t", [project])).t);
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'仍持有明文的旧撤销入口')", [legacy]));
  await as(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [legacy]), denied));
  await as(viewer, async () => assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-OK',7,false)", [project]), denied));
  pass('new links: plaintext returned once, digest stored; revoke by id is permission-checked, audited and immediately effective');

  // ---- Frozen export carries the explicit status fields and their meaning ----------------
  const exported = await as(analyst, async () => (await row('SELECT public.create_registry_export($1,$2) AS e', [project, randomUUID()])).e);
  assert.equal(sha256(exported.content_text), exported.content_sha256);
  const content = JSON.parse(exported.content_text);
  assert.equal(Object.keys(content.tables).length, 9);
  const exportedOk = content.tables.patients_baseline.find(p => p.patient_code === 'SYN-OK');
  assert.deepEqual([exportedOk.consent_status, exportedOk.consent_research, exportedOk.consent_version, exportedOk.followup_status], ['consented', true, 'V2.1', 'active']);
  assert.equal(content.tables.patients_baseline.find(p => p.patient_code === 'SYN-NOVISIT').consent_research, null);
  assert.equal(content.project.ethics_approval_no, '伦审2026-001');
  assert.equal(content.project.followup_interval_days, 90);
  assert.ok(!('contact_display' in content.project));
  assert.match(content.field_notes.consent_research, /空值表示尚未确认/);
  for (const secret of [...Object.values(plaintext), issued, legacy]) {
    assert.ok(!exported.content_text.includes(secret) && !exported.content_text.includes(sha256(secret)), 'no link or link digest in exports');
  }
  pass('frozen export includes consent/follow-up columns, project study details and the three-state consent meaning; no link material');

  // ---- Re-running the increments is harmless ----------------------------------------------
  const snapshot = await rows('SELECT id,consent_status,consent_research,updated_at FROM public.patients_baseline ORDER BY id');
  const tokenSnapshot = await rows('SELECT id,token,token_hash,active,updated_at FROM public.patient_tokens ORDER BY id');
  for (const file of NEW_MIGRATIONS) await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  assert.deepEqual(await rows('SELECT id,consent_status,consent_research,updated_at FROM public.patients_baseline ORDER BY id'), snapshot);
  assert.deepEqual(await rows('SELECT id,token,token_hash,active,updated_at FROM public.patient_tokens ORDER BY id'), tokenSnapshot);
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n), 8);
  await as(null, async () => assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [plaintext.valid])).patient_code, 'SYN-LINK'));
  pass('re-applying 0038/0039 keeps entered consent, derived values, digests and working links');

  // ---- After the account trial ends: no new status writes, settings and revocation remain --
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  await as(editor, async () => assert.rejects(setStatus('SYN-OK', {followup_status: 'transferred'}), fails('subscription_required')));
  await as(owner, async () => {
    assert.equal((await setSettings({contact_display: '研究办公室'})).contact_display, '研究办公室');
    const lastLink = (await row("SELECT id FROM public.patient_tokens WHERE project_id=$1 AND token_hash=$2", [project, sha256(plaintext.lost)])).id;
    await row("SELECT public.revoke_patient_token_by_id($1,$2,'试用结束后撤销')", [project, lastLink]);
  });
  await as(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [plaintext.lost]), denied));
  pass('after the trial ends status writes are refused while settings and link revocation still work');

  console.log(`ADOPTION_DB_OK ${groups} groups; synthetic local PostgreSQL 17 database only.`);
} finally {
  await db.close();
}
