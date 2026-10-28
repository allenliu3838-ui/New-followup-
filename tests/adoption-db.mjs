// Native PG17 acceptance for 0038 (follow-up workflow) and 0039 (hashed follow-up links).
// The database is first built to 0037 and filled the way production looks today:
// research consent only holds its schema default (true) and links are stored in
// plaintext. 0038/0039 are then applied as the reviewed increments. Synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {root, migrations, createDatabase} from './helpers/pg17-fixture.mjs';

assert.equal(process.argv.length, 2, 'Synthetic adoption acceptance accepts no external input');
const NEW_MIGRATIONS = ['0038_followup_workflow.sql', '0039_patient_token_hashing.sql'];
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const db = await createDatabase();
// Fixture dates are written relative to CURRENT_DATE. The registry's "today" is the Beijing
// date (registry_private.local_today), so this session uses that zone for its own arithmetic;
// the "registry today" group proves the database does not depend on the session time zone.
await db.exec("SET timezone='Asia/Shanghai'");
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const denied = error => error.code === '42501';
const fails = code => error => String(error.message).includes(code);
const invalidLink = error => denied(error) && /token_invalid_or_expired/.test(error.message);
const extraClients = [];

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

// A refused migration leaves this session inside its aborted transaction block.
async function refused(file, pattern, label) {
  await assert.rejects(applyReviewed([file]), error => pattern.test(error.message), label);
  await db.exec('ROLLBACK');
}

// Further sessions on the same synthetic server, for lock-order checks.
async function connectOther() {
  const socket = (await row('SHOW unix_socket_directories')).unix_socket_directories;
  const client = new pg.Client({host: socket, port: 55432, user: 'postgres', database: 'postgres'});
  await client.connect();
  extraClients.push(client);
  await client.query("SET timezone='Asia/Shanghai'; SET deadlock_timeout='100ms'");
  return client;
}
async function setRole(client, user) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user || '']);
  await client.query(`SET ROLE ${user ? 'authenticated' : 'anon'}`);
}

const [owner, editor, analyst, viewer, outsider] = Array.from({length: 5}, () => randomUUID());
const project = randomUUID(), otherProject = randomUUID();
const codes = ['SYN-NOVISIT', 'SYN-OK', 'SYN-DUE', 'SYN-DUE0', 'SYN-OK15', 'SYN-OVER', 'SYN-LOST', 'SYN-LINK',
  'SYN-DUE10', 'SYN-NEW', 'SYN-NEWDUE', 'SYN-NOBASE'];
// Baseline date offsets from today (default -400); SYN-NOBASE has no baseline date.
const baselineOffset = {'SYN-NEW': -30, 'SYN-NEWDUE': -80, 'SYN-NOBASE': null};
// Visit offsets from today (negative = past). true = all core fields recorded.
const visits = {
  'SYN-OK': [[-10, true]], 'SYN-DUE': [[-200, true], [-80, false]], 'SYN-DUE0': [[-90, true]],
  'SYN-OK15': [[-75, false]], 'SYN-OVER': [[-91, true]], 'SYN-LOST': [[-300, false]], 'SYN-DUE10': [[-80, true]]
};
const plaintext = {};
// Values a legacy client may have stored that are not 32 lowercase hex characters.
const legacyLinks = {empty: '', short: 'short-legacy-link', upper: 'ABCDEF0123456789ABCDEF0123456789'};
const day = async offset => (await row('SELECT (CURRENT_DATE + $1::int)::text AS d', [offset])).d;

try {
  const upTo37 = migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) <= 37);
  assert.deepEqual(migrations.map(m => m.file).filter(f => Number(f.slice(0, 4)) > 37),
    [...NEW_MIGRATIONS, '0040_batch_import.sql', '0041_followup_board.sql', '0042_c3g_module.sql', '0043_biopsy_records.sql', '0044_project_fields.sql'],
    'the two reviewed increments directly follow 0037 (0040–0044 have their own acceptance, tests/batch-import-db.mjs, tests/followup-board-db.mjs, tests/c3g-module-db.mjs, tests/biopsy-records-db.mjs and tests/project-fields-db.mjs)');
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
    const offset = code in baselineOffset ? baselineOffset[code] : -400;
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,baseline_scr,created_by) VALUES($1,$2,CURRENT_DATE+$3::int,'F',1980,88.4,$4)", [project, code, offset, owner]);
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

  // Legacy anomalies production does not have (0 rows there) but the upgrade must handle:
  // two usable links and one already revoked link whose stored value is not a 32-hex link.
  const legacyIds = {};
  for (const [key, value] of Object.entries(legacyLinks)) {
    legacyIds[key] = (await row(`INSERT INTO public.patient_tokens(project_id,patient_code,token,active,expires_at,single_use,revoked_at,revoke_reason,created_by)
      VALUES($1,'SYN-OK15',$2,true,now()+interval '30 days',false,CASE WHEN $3 THEN now()-interval '2 days' END,CASE WHEN $3 THEN '旧版已撤销' END,$4) RETURNING id`,
    [project, value, key === 'upper', owner])).id;
  }
  const legacyBefore = new Map((await rows('SELECT id,revoked_at,updated_at FROM public.patient_tokens WHERE id = ANY($1::uuid[])', [Object.values(legacyIds)])).map(r => [r.id, r]));

  // ---- The increments refuse to run where a person must review first -------------------
  const versionCount = async () => Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n);
  const hasColumn = async (table, column) => Number((await row(`SELECT count(*) AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column])).n) === 1;
  const consentAudit = async () => Number((await row("SELECT count(*) AS n FROM public.field_audit_log WHERE table_name='patients_baseline' AND field_name='consent_research'")).n);
  // (a) An explicit "no" written through the 0037 CSV whitelist may be a real decision.
  await as(owner, async () => assert.equal((await row("SELECT public.import_registry_rows($1,'baseline',$2,$3) AS r", [project,
    JSON.stringify([{patient_code: 'SYN-ANOMALY', baseline_date: await day(-100), consent_research: false}]), randomUUID()])).r.inserted, 1));
  const anomaly = async () => (await row("SELECT to_jsonb(b) AS r FROM public.patients_baseline b WHERE project_id=$1 AND patient_code='SYN-ANOMALY'", [project])).r;
  const anomalyBefore = await anomaly();
  assert.equal(anomalyBefore.consent_research, false);
  await refused('0038_followup_workflow.sql', /有 1 位患者的“研究同意”不是系统默认值.*需人工核对后再迁移/, 'explicit consent value stops 0038');
  assert.deepEqual(await anomaly(), anomalyBefore, 'the refused migration changed nothing');
  assert.equal(await versionCount(), 6);
  assert.equal(await hasColumn('patients_baseline', 'consent_status'), false);
  // (b) Every value is back at the default, but the audit log shows a person changed it.
  await db.query("UPDATE public.patients_baseline SET consent_research=true WHERE project_id=$1 AND patient_code='SYN-ANOMALY'", [project]);
  assert.equal(await consentAudit(), 1);
  await refused('0038_followup_workflow.sql', /审计记录中有 1 条该字段的修改记录.*需人工核对后再迁移/, 'audited consent change stops 0038');
  assert.equal((await anomaly()).consent_research, true);
  assert.equal(await consentAudit(), 1);
  assert.equal(await hasColumn('patients_baseline', 'consent_status'), false);
  // Back to the production state (no such row, no such audit entry) for the real upgrade.
  await db.query("DELETE FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-ANOMALY'", [project]);
  await db.query("DELETE FROM public.field_audit_log WHERE table_name='patients_baseline' AND field_name='consent_research'");
  // (c) A trigger the clearing step relies on is missing.
  await db.exec('ALTER TRIGGER tr_patients_updated_meta ON public.patients_baseline RENAME TO synthetic_renamed_meta');
  await refused('0038_followup_workflow.sql', /缺少本迁移依赖的触发器（tr_patients_updated_meta）.*需人工核对后再迁移/, 'missing trigger stops 0038');
  await db.exec('ALTER TRIGGER synthetic_renamed_meta ON public.patients_baseline RENAME TO tr_patients_updated_meta');
  // (d) 0039 never runs before 0038.
  await refused('0039_patient_token_hashing.sql', /尚未执行迁移 0038.*需人工核对后再迁移/, '0039 requires 0038');
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.patient_tokens WHERE token IS NULL')).n), 0, 'refused 0039 erased nothing');
  assert.equal(await versionCount(), 6);
  pass('0038/0039 refuse to run, change nothing and explain in Chinese when consent data or dependencies need a manual review');

  // (f) Between the precondition check and the clearing step no consent value can be written:
  // 0038 locks the baseline table before checking. Run its opening (up to and including the
  // check) in another session and hold it there: writers cannot get in, plain reads can.
  const text38 = fs.readFileSync(path.join(root, 'supabase/migrations', NEW_MIGRATIONS[0]), 'utf8');
  const lockAt = text38.indexOf('\nLOCK TABLE public.patients_baseline IN EXCLUSIVE MODE;\n');
  const checkAt = text38.indexOf('\n-- Preconditions.');
  const afterCheck = text38.indexOf('\nALTER TABLE public.patients_baseline\n  ADD COLUMN IF NOT EXISTS consent_status');
  assert.ok(lockAt > text38.indexOf('\nBEGIN;\n') && lockAt < checkAt && checkAt < afterCheck, 'the lock is taken inside the migration transaction, before the check');
  const migrating = await connectOther();
  await migrating.query(text38.slice(0, afterCheck));
  const migratingPid = Number((await migrating.query('SELECT pg_backend_pid() AS p')).rows[0].p);
  assert.equal((await row("SELECT bool_or(mode='ExclusiveLock' AND granted) AS held FROM pg_locks WHERE pid=$1 AND locktype='relation' AND relation='public.patients_baseline'::regclass", [migratingPid])).held,
    true, 'the migration holds the baseline table after its check');
  await db.exec("SET lock_timeout='200ms'");
  try {
    await as(owner, async () => assert.rejects(row("SELECT public.import_registry_rows($1,'baseline',$2,$3)", [project,
      JSON.stringify([{patient_code: 'SYN-OK', consent_research: false}]), randomUUID()]), error => error.code === '55P03', 'a concurrent import of an explicit "no" cannot get in'));
    await assert.rejects(db.query("UPDATE public.patients_baseline SET consent_research=false WHERE project_id=$1 AND patient_code='SYN-OK'", [project]),
      error => error.code === '55P03', 'nor can a direct write');
    assert.equal(Number((await row('SELECT count(*) AS n FROM public.patients_baseline WHERE project_id=$1', [project])).n), codes.length, 'plain reads continue');
  } finally { await db.exec('RESET lock_timeout'); }
  await migrating.query('ROLLBACK');
  assert.ok((await rows('SELECT consent_research FROM public.patients_baseline')).every(r => r.consent_research === true));
  assert.equal(await consentAudit(), 0);
  assert.equal(await versionCount(), 6);
  pass('0038 locks the baseline table before its precondition check: no consent value can be written between the check and the clearing step');

  // ---- Upgrade --------------------------------------------------------------------------
  await applyReviewed([NEW_MIGRATIONS[0]]);
  // (e) 0039 checks its own trigger and refuses duplicate plaintext (unique digests).
  await db.exec('ALTER TRIGGER tr_tokens_updated_meta ON public.patient_tokens RENAME TO synthetic_renamed_meta');
  await refused('0039_patient_token_hashing.sql', /缺少本迁移依赖的触发器（tr_tokens_updated_meta）/, 'missing trigger stops 0039');
  await db.exec('ALTER TRIGGER synthetic_renamed_meta ON public.patient_tokens RENAME TO tr_tokens_updated_meta');
  await db.exec('ALTER TABLE public.patient_tokens DROP CONSTRAINT patient_tokens_token_key');
  const duplicate = (await row("INSERT INTO public.patient_tokens(project_id,patient_code,token,active,expires_at,created_by) VALUES($1,'SYN-LINK',$2,true,now()+interval '1 day',$3) RETURNING id", [project, plaintext.valid, owner])).id;
  await refused('0039_patient_token_hashing.sql', /有 1 组链接明文重复.*需人工核对后再迁移/, 'duplicate plaintext stops 0039');
  await db.query('DELETE FROM public.patient_tokens WHERE id=$1', [duplicate]);
  await db.exec('ALTER TABLE public.patient_tokens ADD CONSTRAINT patient_tokens_token_key UNIQUE(token)');
  await applyReviewed([NEW_MIGRATIONS[1]]);
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
  for (const value of [...Object.values(plaintext), legacyLinks.short, legacyLinks.upper]) assert.ok(!tableText.includes(value), 'no plaintext remains in any column');
  const submissionAudit = await row("SELECT token_hash FROM public.security_audit_logs WHERE event_type='visit_submitted'");
  assert.equal(submissionAudit.token_hash, sha256(plaintext.valid), 'link digest equals the existing audit digest');
  await assert.rejects(db.query("INSERT INTO public.patient_tokens(project_id,patient_code,token,token_hash) VALUES($1,'SYN-LINK','plaintext',$2)",
    [project, sha256('plaintext')]), error => error.code === '23514', 'a plaintext link can never be stored again');
  pass('0039 replaces every stored link by its SHA-256 digest; no plaintext remains; audit digests align');

  // Legacy-format values: digest kept, link revoked (first revocation kept), each audited.
  for (const [key, value] of Object.entries(legacyLinks)) {
    const now = afterTokens.get(legacyIds[key]);
    assert.equal(now.token, null);
    assert.equal(now.token_hash, sha256(value));
    assert.equal(now.active, false, `${key} legacy link disabled`);
    assert.ok(now.revoked_at, `${key} legacy link revoked`);
    if (key === 'upper') {
      assert.equal(now.revoke_reason, '旧版已撤销', 'an earlier revocation reason is kept');
      assert.equal(new Date(now.revoked_at).getTime(), legacyBefore.get(legacyIds[key]).revoked_at.getTime(), 'and its time');
    } else assert.equal(now.revoke_reason, 'legacy_token_format');
    assert.equal(new Date(now.updated_at).getTime(), legacyBefore.get(legacyIds[key]).updated_at.getTime(), 'metadata trigger bypassed');
  }
  const legacyAudit = await rows("SELECT token_hash,severity,details FROM public.security_audit_logs WHERE event_type='legacy_token_format_revoked' ORDER BY details->>'token_id'");
  assert.deepEqual(legacyAudit.map(a => a.details.token_id).sort(), Object.values(legacyIds).sort());
  assert.ok(legacyAudit.every(a => a.severity === 'HIGH' && Object.values(legacyLinks).every(v => !v || !JSON.stringify(a.details).includes(v))));
  const erased = await rows("SELECT project_id,patient_code,token_hash,details FROM public.security_audit_logs WHERE event_type='plaintext_tokens_erased'");
  assert.equal(erased.length, 1, 'one summary entry for the erasure');
  assert.deepEqual([erased[0].project_id, erased[0].patient_code, erased[0].token_hash], [null, null, null]);
  assert.equal(erased[0].details.erased_count, beforeTokens.length + 3);
  assert.equal(erased[0].details.legacy_format_revoked_count, 3);
  assert.equal(erased[0].details.summary, `已清除 ${beforeTokens.length + 3} 条明文链接（其中 3 条格式异常的旧链接已同时停用）`);
  for (const value of Object.values(plaintext)) assert.ok(!JSON.stringify(erased[0].details).includes(value), 'counts only, no link material');
  await as(null, async () => {
    for (const value of Object.values(legacyLinks)) await assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [value]), invalidLink);
  });
  pass('0039 revokes and audits legacy-format links and records one count-only summary of the erased plaintext');

  const contextColumns = ['project_name', 'center_code', 'patient_code', 'sex', 'birth_year', 'can_write', 'single_use',
    'token_expires_at', 'public_title', 'institution_name', 'ethics_approval_no', 'contact_display'];
  await as(null, async () => {
    const context = await row('SELECT * FROM public.patient_get_context($1)', [plaintext.valid]);
    assert.equal(context.patient_code, 'SYN-LINK');
    assert.deepEqual([context.project_name, context.center_code, context.can_write, context.single_use], ['Synthetic adoption project', 'SYN', true, false]);
    const columns = (await db.query('SELECT * FROM public.patient_get_context($1)', [plaintext.valid])).fields.map(f => f.name);
    assert.deepEqual(columns, contextColumns, 'the patient page receives exactly the twelve fields it shows or needs');
    for (const business of ['project_id', 'module', 'trial_expires_at', 'trial_grace_until', 'subscription_plan', 'subscription_active_until', 'write_block_reason']) {
      assert.ok(!columns.includes(business), `${business} is not returned to a link holder`);
    }
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
    assert.equal(replay.invalid_fields, null);
  });
  const contextProc = await row(`SELECT has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,p.prosecdef,p.proconfig
    FROM pg_proc p WHERE p.oid='public.patient_get_context(text)'::regprocedure`);
  assert.deepEqual(contextProc, {anon_execute: true, prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp']});
  pass('links issued before the upgrade keep working by digest; the patient context carries no project id or account details');

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
  // Leaving the study needs a stated reason on every path.
  await as(editor, async () => {
    for (const reason of [null, '', '  ', '是']) {
      await assert.rejects(setStatus('SYN-OK15', {consent_status: 'declined', consent_date: ''}, reason), fails('study_exit_reason_required'));
    }
    await assert.rejects(setStatus('SYN-OK15', {followup_status: 'deceased'}), fails('study_exit_reason_required'));
  });
  assert.equal(await consentResearch('SYN-OK15'), null, 'refused exit changed nothing');
  await as(editor, () => setStatus('SYN-OK15', {consent_status: 'declined', consent_date: ''}, '患者拒绝参加研究'));
  assert.equal(await consentResearch('SYN-OK15'), false);
  // Undoing an exit, or changing the status fields of a participant who left, needs a reason too.
  await as(owner, async () => {
    for (const reason of [null, '', '  ', '是']) {
      await assert.rejects(setStatus('SYN-OK15', {consent_status: 'unconfirmed'}, reason), fails('study_exit_reason_required'), `undo with ${JSON.stringify(reason)}`);
    }
    await assert.rejects(setStatus('SYN-OK15', {consent_status: 'consented'}, '患者手机13812345678'), fails('pii_detected_blocked'));
    await assert.rejects(setStatus('SYN-OK15', {consent_version: 'V0.9'}), fails('study_exit_reason_required'), 'consent form version of a participant who declined');
    await assert.rejects(setStatus('SYN-OK15', {followup_status: 'lost'}), fails('study_exit_reason_required'), 'follow-up status of a participant who declined');
  });
  assert.equal(await consentResearch('SYN-OK15'), false, 'refused undo changed nothing');
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
  assert.equal((await row(`SELECT change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id
    WHERE b.project_id=$1 AND b.patient_code='SYN-OK15' AND a.field_name='consent_status' AND a.new_value='declined'`, [project])).change_reason, '患者拒绝参加研究');
  pass('set_patient_study_status: owner/editor only, validated keys and values, recording or undoing an exit needs a reason, derived consent flag, field audit with reason');

  await as(owner, async () => {
    await assert.rejects(db.query("UPDATE public.patients_baseline SET consent_research=false WHERE project_id=$1 AND patient_code='SYN-OK'", [project]),
      fails('consent_research_is_derived'));
    await assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,consent_research) VALUES($1,'SYN-NEW1',CURRENT_DATE,true)", [project]),
      fails('consent_research_is_derived'));
    const csvBatch = randomUUID();
    const imported = await row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [project, 'baseline',
      JSON.stringify([{patient_code: 'SYN-CSV', baseline_date: '2025-03-01', consent_status: 'consented', consent_date: '2025-03-01', followup_status: 'active'}]), csvBatch]);
    assert.equal(imported.r.inserted, 1);
    await assert.rejects(row('SELECT public.import_registry_rows($1,$2,$3,$4) AS r', [project, 'baseline',
      JSON.stringify([{patient_code: 'SYN-CSV2', baseline_date: '2025-03-01', consent_research: 'true'}]), randomUUID()]), fails('unsupported_column: consent_research'));
    const csvId = (await row("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSV'", [project])).id;
    // The study status given with a new patient is field-audited with the batch as its reason.
    assert.deepEqual((await rows("SELECT field_name,old_value,new_value,changed_by,change_reason FROM public.field_audit_log WHERE table_name='patients_baseline' AND record_id=$1 ORDER BY field_name", [csvId]))
      .map(a => [a.field_name, a.old_value, a.new_value, a.changed_by, a.change_reason]), [
      ['consent_date', null, '2025-03-01', owner, `CSV导入批次 ${csvBatch}`],
      ['consent_research', null, 'true', owner, `CSV导入批次 ${csvBatch}`],
      ['consent_status', null, 'consented', owner, `CSV导入批次 ${csvBatch}`]]);
    await assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"consent_status\":null}','核对原始记录')", [project, csvId]),
      fails('invalid_consent_status'));
    // The correction dialog never changes study status: that is set_patient_study_status.
    for (const [changes, field] of [[{consent_status: 'withdrawn'}, 'consent_status'], [{consent_status: 'unconfirmed'}, 'consent_status'],
      [{consent_version: 'V2'}, 'consent_version'], [{consent_date: '2025-03-02'}, 'consent_date'],
      [{followup_status: 'lost', treatment_arm: 'A'}, 'followup_status'], [{followup_status_date: '2025-03-02'}, 'followup_status_date']]) {
      await assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,$3,'患者书面撤回同意')", [project, csvId, JSON.stringify(changes)]),
        error => error.message === `study_status_requires_dedicated_action: ${field}`, JSON.stringify(changes));
    }
  });
  assert.deepEqual(await row("SELECT consent_status,consent_research,treatment_arm FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSV'", [project]),
    {consent_status: 'consented', consent_research: true, treatment_arm: null}, 'refused corrections changed nothing');
  await db.query("DELETE FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSV'", [project]);
  pass('consent flag cannot be written directly; CSV import uses the explicit status fields and a new patient\'s status is field-audited; correction cannot change study status');

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
  const withdrawId = (await row('SELECT id FROM public.patient_tokens WHERE token_hash=$1', [sha256(plaintext.withdraw)])).id;
  const exitAudit = await row("SELECT token_hash,details FROM public.security_audit_logs WHERE event_type='study_exit_tokens_revoked' AND patient_code='SYN-DUE'");
  assert.deepEqual(exitAudit.details, {reason: 'consent_withdrawn', revoked_token_count: 1, revoked_token_ids: [withdrawId]}, 'the audit lists the revoked link ids');
  assert.equal(exitAudit.token_hash, null);
  assert.ok(!JSON.stringify(exitAudit).includes(plaintext.withdraw) && !JSON.stringify(exitAudit).includes(sha256(plaintext.withdraw)), 'no link material in the audit');
  pass('consent withdrawal stops link collection for that patient and audits the revoked link ids; loss to follow-up keeps the link');

  // ---- CSV import cannot record, undo or change a study exit --------------------------------
  // Synthetic patients for this group only (removed at the end): SYN-CSVA stays in the study,
  // SYN-CSVW withdraws consent through the dedicated action.
  for (const code of ['SYN-CSVA', 'SYN-CSVW']) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by) VALUES($1,$2,CURRENT_DATE-60,'F',1985,$3)", [project, code, owner]);
  }
  await as(owner, () => setStatus('SYN-CSVW', {consent_status: 'withdrawn', consent_date: '2025-07-01'}, '患者书面撤回同意'));
  const csvRow = async code => (await row('SELECT to_jsonb(b) - ARRAY[\'updated_at\',\'updated_by\'] AS r FROM public.patients_baseline b WHERE project_id=$1 AND patient_code=$2', [project, code]))?.r;
  const csvBefore = {a: await csvRow('SYN-CSVA'), w: await csvRow('SYN-CSVW')};
  const importBaseline = list => row("SELECT public.import_registry_rows($1,'baseline',$2,$3) AS r", [project, JSON.stringify(list), randomUUID()]).then(x => x.r);
  const studyRefused = (rowNo, field) => error => error.message === `row_${rowNo}_study_status_requires_dedicated_action: ${field}`;
  const d60 = await day(-60), d10 = await day(-10);
  await as(owner, async () => {
    // New patients cannot be created as having left; the whole batch is refused.
    await assert.rejects(importBaseline([{patient_code: 'SYN-CSVN1', baseline_date: d60}, {patient_code: 'SYN-CSVN2', baseline_date: d60, consent_status: 'declined'}]),
      studyRefused(2, 'consent_status'));
    await assert.rejects(importBaseline([{patient_code: 'SYN-CSVN3', baseline_date: d60, followup_status: 'deceased', followup_status_date: d10}]), studyRefused(1, 'followup_status'));
    await assert.rejects(importBaseline([{patient_code: 'SYN-CSVN3', baseline_date: d60, consent_status: 'withdrawn'}]), studyRefused(1, 'consent_status'));
    // An existing patient cannot be moved into the exit state...
    for (const [change, field] of [[{consent_status: 'withdrawn'}, 'consent_status'], [{consent_status: 'declined', consent_date: d10}, 'consent_status'],
      [{followup_status: 'withdrawn', followup_status_date: d10}, 'followup_status'], [{followup_status: 'deceased'}, 'followup_status']]) {
      await assert.rejects(importBaseline([{patient_code: 'SYN-CSVA', treatment_arm: 'A'}, {patient_code: 'SYN-CSVW', treatment_arm: 'A'}].map((r, i) => i ? r : {...r, ...change})),
        studyRefused(1, field), JSON.stringify(change));
    }
    // ...nor out of it, nor may the status fields of a patient who left change.
    for (const [change, field] of [[{consent_status: 'consented'}, 'consent_status'], [{consent_status: 'unconfirmed'}, 'consent_status'],
      [{consent_status: 'declined'}, 'consent_status'], [{consent_date: d10}, 'consent_date'], [{consent_version: 'V2'}, 'consent_version'],
      [{followup_status: 'lost'}, 'followup_status'], [{followup_status_date: d10}, 'followup_status_date']]) {
      await assert.rejects(importBaseline([{patient_code: 'SYN-CSVA', treatment_arm: 'B'}, {patient_code: 'SYN-CSVW', ...change}]),
        studyRefused(2, field), JSON.stringify(change));
    }
  });
  assert.equal(Number((await row("SELECT count(*) AS n FROM public.patients_baseline WHERE project_id=$1 AND patient_code LIKE 'SYN-CSVN%'", [project])).n), 0, 'refused batches created nobody');
  assert.deepEqual({a: await csvRow('SYN-CSVA'), w: await csvRow('SYN-CSVW')}, csvBefore, 'refused batches changed nobody');
  await as(owner, async () => {
    // Identical study values are no change; other columns of a patient who left may be imported.
    assert.equal((await importBaseline([{patient_code: 'SYN-CSVW', consent_status: 'withdrawn', consent_date: '2025-07-01', treatment_arm: 'A'}])).updated, 1);
    // Non-exit statuses are still imported, and audited with the batch.
    const batch = randomUUID();
    assert.equal((await row("SELECT public.import_registry_rows($1,'baseline',$2,$3) AS r", [project,
      JSON.stringify([{patient_code: 'SYN-CSVA', consent_status: 'consented', consent_date: d60, followup_status: 'lost', followup_status_date: d10}]), batch])).r.updated, 1);
    assert.deepEqual((await rows("SELECT a.field_name,a.change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id WHERE b.project_id=$1 AND b.patient_code='SYN-CSVA' ORDER BY a.field_name", [project]))
      .map(a => [a.field_name, a.change_reason]), ['consent_date', 'consent_research', 'consent_status', 'followup_status', 'followup_status_date'].map(f => [f, `CSV导入批次 ${batch}`]));
    // The audited correction may fix other fields of a patient who left (design choice: data
    // collected before the exit can still be entered), never the study status.
    const wId = (await row("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSVW'", [project])).id;
    assert.equal((await row("SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"treatment_arm\":\"B\"}','核对随机分组') AS r", [project, wId])).r.record.treatment_arm, 'B');
    await assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-CSVW',7,false)", [project]), fails('patient_not_eligible_for_links'), 'no link after a refused undo');
  });
  assert.deepEqual(await row("SELECT consent_status,consent_date::text AS d,consent_research FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-CSVW'", [project]),
    {consent_status: 'withdrawn', d: '2025-07-01', consent_research: false});
  // A new patient created directly with a study status is audited too (no reason given).
  await as(editor, () => db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,consent_status,consent_version) VALUES($1,'SYN-CSVI',$2::date,'waiver','EC-2025-07')", [project, d60]));
  assert.deepEqual((await rows("SELECT a.field_name,a.old_value,a.new_value,a.changed_by,a.change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id WHERE b.project_id=$1 AND b.patient_code='SYN-CSVI' ORDER BY a.field_name", [project]))
    .map(a => [a.field_name, a.old_value, a.new_value, a.changed_by, a.change_reason]), [
    ['consent_research', null, 'true', editor, '新建患者时登记的研究状态（未填写原因）'],
    ['consent_status', null, 'waiver', editor, '新建患者时登记的研究状态（未填写原因）'],
    ['consent_version', null, 'EC-2025-07', editor, '新建患者时登记的研究状态（未填写原因）']]);
  await db.query("DELETE FROM public.patients_baseline WHERE project_id=$1 AND patient_code IN ('SYN-CSVA','SYN-CSVW','SYN-CSVI')", [project]);
  pass('CSV import cannot create a patient who left, record or undo an exit, or change the status fields of a patient who left (row-numbered, whole batch refused); non-exit statuses import and are audited');

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
  const statusRows = async () => new Map((await rows(`SELECT patient_code,followup_state,next_due_date::text AS next_due,
    days_since_last_visit,visit_count,first_visit_date::text AS first_visit,last_visit_date::text AS last_visit,active_link_count,
    last_link_created_at,last_link_expires_at,last_patient_submission_at,center_code,consent_status,followup_status
    FROM public.v_patient_followup_status WHERE project_id=$1`, [project])).map(r => [r.patient_code, r]));
  // SYN-DUE withdrew consent (follow-up status still active): never due again. Patients
  // without visits are due at baseline + interval: overdue, due soon, or not yet due.
  const expected90 = {'SYN-NOVISIT': ['overdue', -310], 'SYN-OK': ['ok', 80], 'SYN-DUE': ['inactive', 10], 'SYN-DUE0': ['due_soon', 0],
    'SYN-OK15': ['ok', 15], 'SYN-OVER': ['overdue', -1], 'SYN-LOST': ['inactive', -210], 'SYN-LINK': ['ok', 90],
    'SYN-DUE10': ['due_soon', 10], 'SYN-NEW': ['no_visit', 60], 'SYN-NEWDUE': ['due_soon', 10], 'SYN-NOBASE': ['no_visit', null]};
  const ownerView = await as(owner, statusRows);
  assert.deepEqual([...ownerView.keys()].sort(), [...codes].sort());
  for (const [code, [state, due]] of Object.entries(expected90)) {
    assert.equal(ownerView.get(code).followup_state, state, `${code} state`);
    assert.equal(ownerView.get(code).next_due, due === null ? null : await day(due), `${code} next due date`);
  }
  assert.equal(ownerView.get('SYN-NOVISIT').days_since_last_visit, null);
  assert.equal(ownerView.get('SYN-NOVISIT').visit_count, 0);
  assert.equal(ownerView.get('SYN-NEWDUE').visit_count, 0);
  assert.equal(ownerView.get('SYN-DUE').visit_count, 2);
  assert.equal(ownerView.get('SYN-DUE').consent_status, 'withdrawn');
  assert.equal(ownerView.get('SYN-DUE').followup_status, 'active');
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
    assert.deepEqual((await rows('SELECT patient_code,followup_state FROM public.v_patient_followup_status')), [{patient_code: 'SYN-OK', followup_state: 'overdue'}],
      'a patient never followed up since a baseline 400 days ago is overdue');
  });
  await as(owner, async () => assert.equal((await rows('SELECT * FROM public.v_patient_followup_status WHERE project_id=$1', [otherProject])).length, 0));
  await as(owner, () => setSettings({followup_interval_days: 30}));
  const shorter = await as(owner, statusRows);
  for (const [code, state] of Object.entries({'SYN-OK': 'ok', 'SYN-DUE': 'inactive', 'SYN-DUE0': 'overdue', 'SYN-OK15': 'overdue', 'SYN-LINK': 'ok',
    'SYN-NOVISIT': 'overdue', 'SYN-LOST': 'inactive', 'SYN-DUE10': 'overdue', 'SYN-NEW': 'due_soon', 'SYN-NEWDUE': 'overdue', 'SYN-NOBASE': 'no_visit'})) {
    assert.equal(shorter.get(code).followup_state, state, `${code} with a 30-day interval`);
  }
  assert.equal(shorter.get('SYN-OK').next_due, await day(20));
  assert.equal(shorter.get('SYN-NEW').next_due, await day(0), 'first follow-up due today counts as due soon');
  await as(owner, () => setSettings({followup_interval_days: 90}));
  pass('v_patient_followup_status: withdrawn consent is inactive, never-visited patients become due/overdue, boundaries, interval, link columns by permission, isolation');

  const overview = async pid => row('SELECT * FROM public.v_project_overview WHERE project_id=$1', [pid]);
  const expectedIssues = Number((await row("SELECT count(*) AS n FROM public.data_issues WHERE project_id=$1 AND status IN ('OPEN','IN_PROGRESS')", [project])).n);
  assert.ok(expectedIssues >= 2, 'at least the generated missing-core issue and the in-progress issue are open');
  const ownerOverview = await as(owner, () => overview(project));
  // 12 patients: SYN-DUE (consent withdrawn) and SYN-LOST are not active; overdue = SYN-NOVISIT,
  // SYN-OVER; due soon = SYN-DUE0, SYN-DUE10, SYN-NEWDUE; not yet due without visits = SYN-NEW, SYN-NOBASE.
  assert.deepEqual({...ownerOverview, last_visit_date: undefined}, {
    project_id: project, followup_interval_days: 90, n_patients: 12, n_active: 10, n_visits: 10, n_visits_30d: 3,
    n_core_complete_visits: 7, core_completeness: '0.7000', n_overdue: 2, n_due_soon: 3, n_no_visit: 2, last_visit_date: undefined,
    n_consent_confirmed: 2, n_consent_unconfirmed: 9, n_open_issues: expectedIssues});
  assert.equal((await as(owner, () => row('SELECT last_visit_date::text AS d FROM public.v_project_overview WHERE project_id=$1', [project]))).d, await day(0));
  for (const user of [editor, analyst, viewer]) assert.deepEqual(await as(user, () => overview(project)), ownerOverview);
  await as(outsider, async () => {
    assert.equal(await overview(project), undefined);
    const own = await overview(otherProject);
    assert.equal(own.n_patients, 1);
    assert.equal(own.n_visits, 0);
    assert.equal(own.core_completeness, null, 'no visits means completeness is unknown, not zero');
    assert.equal(own.n_no_visit, 0, 'never followed up and past baseline + interval is not "not yet due"');
    assert.equal(own.n_overdue, 1);
    assert.equal(own.n_active, 1);
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
  pass('v_project_overview: counts follow followup_state, core completeness, consent and open quality issues; same for every member; isolated; caller privileges only');

  // ---- Registry "today" is the Beijing date, whatever the session time zone -------------
  const localToday = (await row('SELECT registry_private.local_today()::text AS d')).d;
  assert.equal(localToday, (await row("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS d")).d);
  const zoneDates = {};
  for (const zone of ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    await db.exec(`SET timezone='${zone}'`);
    const r = await row("SELECT registry_private.local_today()::text AS lt,(now() AT TIME ZONE 'Asia/Shanghai')::date::text AS sh,current_date::text AS cd");
    assert.equal(r.lt, localToday, `${zone}: local_today does not follow the session zone`);
    assert.equal(r.sh, localToday);
    zoneDates[zone] = r.cd;
  }
  assert.ok(Object.values(zoneDates).some(d => d !== localToday), 'at least one session zone has another current_date right now, so the checks below are meaningful');
  const fnMeta = await row(`SELECT p.provolatile,p.prosecdef,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon FROM pg_proc p WHERE p.oid='registry_private.local_today()'::regprocedure`);
  assert.deepEqual(fnMeta, {provolatile: 's', prosecdef: false, proconfig: ['search_path=pg_catalog'], auth: true, anon: false});
  const shanghaiView = await as(owner, statusRows);
  const shanghaiOverview = await as(owner, () => overview(project));
  for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
    await db.exec(`SET timezone='${zone}'`);
    assert.deepEqual(await as(owner, statusRows), shanghaiView, `${zone}: same due dates, states and day counts`);
    assert.deepEqual(await as(owner, () => overview(project)), shanghaiOverview, `${zone}: same overview`);
  }
  // Every "not after today" rule that refuses input uses the Beijing date: a date equal to
  // local_today is accepted and the next day is refused, from a session in any zone.
  const tomorrow = (await row('SELECT (registry_private.local_today()+1)::text AS d')).d;
  const newLink = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-NEW',7,false) AS t", [project])).t);
  for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati']) {
    await db.exec(`SET timezone='${zone}'`);
    await as(null, async () => {
      const future = db.query('SELECT * FROM public.patient_submit_visit_v2($1,$2::date,120,80,90,300,NULL,NULL,$3)', [newLink, tomorrow, randomUUID()]);
      await assert.rejects(future, fails('future_visit_date'), `${zone}: patient visit dated tomorrow`);
    });
    await as(owner, async () => {
      await assert.rejects(row("SELECT public.import_registry_rows($1,'visits',$2,$3)", [project, JSON.stringify([{patient_code: 'SYN-NEW', visit_date: tomorrow, sbp: 120, dbp: 80}]), randomUUID()]),
        fails('invalid_or_future_date: visit_date'));
      await assert.rejects(row("SELECT public.import_registry_rows($1,'baseline',$2,$3)", [project, JSON.stringify([{patient_code: 'SYN-TOMORROW', baseline_date: tomorrow}]), randomUUID()]),
        fails('invalid_or_future_date: baseline_date'));
      await assert.rejects(setStatus('SYN-OK15', {consent_date: tomorrow}), fails('invalid_or_future_date: consent_date'));
      await assert.rejects(db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp) VALUES($1,'SYN-NEW',$2::date,120,80)", [project, tomorrow]), fails('future_visit_date'));
      await assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date) VALUES($1,'SYN-TOMORROW',$2::date)", [project, tomorrow]), fails('future_baseline_date'));
      await assert.rejects(db.query("UPDATE public.patients_baseline SET consent_date=$2::date WHERE project_id=$1 AND patient_code='SYN-OK15'", [project, tomorrow]), fails('invalid_or_future_date: consent_date'));
    });
  }
  await db.exec("SET timezone='Etc/GMT+12'");
  const todayVisit = await as(null, async () => row('SELECT * FROM public.patient_submit_visit_v2($1,$2::date,120,80,90,300,NULL,NULL,$3)', [newLink, localToday, randomUUID()]));
  assert.equal(todayVisit.status, 'submitted', 'a patient visit dated the Beijing today is accepted');
  await as(owner, async () => {
    assert.equal((await row("SELECT public.import_registry_rows($1,'baseline',$2,$3) AS r", [project, JSON.stringify([{patient_code: 'SYN-TODAY', baseline_date: localToday}]), randomUUID()])).r.inserted, 1);
    assert.equal((await setStatus('SYN-OK15', {consent_date: localToday})).consent_date, localToday);
    await db.query("UPDATE public.patients_baseline SET followup_status_date=$2::date WHERE project_id=$1 AND patient_code='SYN-OK15'", [project, localToday]);
  });
  await db.exec("SET timezone='Asia/Shanghai'");
  pass('registry today: local_today equals the Beijing date in any session zone; views, imports, status changes, direct writes and patient submissions all use it');

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
  // The plaintext-based legacy entry keeps the first revocation reason and time as well.
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'再次撤销的原因')", [issued]));
  assert.deepEqual(await row('SELECT active,revoked_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [stored.id]), revoked);
  const revokeAudits = async id => Number((await row("SELECT count(*) AS n FROM public.security_audit_logs WHERE event_type='token_revoked' AND details->>'token_id'=$1", [id])).n);
  assert.equal(await revokeAudits(stored.id), 1, 'a repeated revocation through the legacy entry is not audited again');
  const legacy = await as(owner, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-OK15',7,true) AS t", [project])).t);
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'仍持有明文的旧撤销入口')", [legacy]));
  await as(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [legacy]), denied));
  assert.equal((await row('SELECT revoke_reason FROM public.patient_tokens WHERE token_hash=$1', [sha256(legacy)])).revoke_reason, '仍持有明文的旧撤销入口');
  // A deactivated link that already carries a reason keeps it when revoked by id.
  const inactiveId = (await row('SELECT id FROM public.patient_tokens WHERE token_hash=$1', [sha256(plaintext.inactive)])).id;
  await db.query("UPDATE public.patient_tokens SET revoke_reason='原停用原因' WHERE id=$1", [inactiveId]);
  await as(owner, () => row("SELECT public.revoke_patient_token_by_id($1,$2,'再次撤销')", [project, inactiveId]));
  const inactiveNow = await row('SELECT revoked_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [inactiveId]);
  assert.ok(inactiveNow.revoked_at instanceof Date);
  assert.equal(inactiveNow.revoke_reason, '原停用原因');
  // The same through the legacy entry: the deactivation reason is kept, the revocation is
  // recorded once, and repeating it changes nothing and audits nothing.
  const deactivated = await as(owner, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-OK15',7,false) AS t", [project])).t);
  const deactivatedId = (await row('SELECT id FROM public.patient_tokens WHERE token_hash=$1', [sha256(deactivated)])).id;
  await db.query("UPDATE public.patient_tokens SET active=false,revoke_reason='原停用原因（旧入口）' WHERE id=$1", [deactivatedId]);
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'旧入口撤销')", [deactivated]));
  const deactivatedNow = await row('SELECT active,revoked_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [deactivatedId]);
  assert.deepEqual([deactivatedNow.active, deactivatedNow.revoked_at instanceof Date, deactivatedNow.revoke_reason], [false, true, '原停用原因（旧入口）']);
  await as(owner, () => row("SELECT public.revoke_patient_token($1,'再次旧入口撤销')", [deactivated]));
  assert.deepEqual(await row('SELECT active,revoked_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [deactivatedId]), deactivatedNow);
  assert.equal(await revokeAudits(deactivatedId), 1);
  await as(viewer, async () => assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-OK',7,false)", [project]), denied));
  pass('new links: plaintext returned once, digest stored; revoke by id is permission-checked, audited and immediately effective; first revocation reason is kept');

  // Malformed bearer input is refused before any lookup, on every entry that takes a link.
  const boundary = {short: 'a'.repeat(23), min: 'b'.repeat(24), max: 'c'.repeat(200), long: 'd'.repeat(201)};
  for (const value of Object.values(boundary)) {
    await db.query("INSERT INTO public.patient_tokens(project_id,patient_code,token_hash,active,expires_at,single_use,created_by) VALUES($1,'SYN-OK15',$2,true,now()+interval '1 day',false,$3)",
      [project, sha256(value), owner]);
  }
  await as(null, async () => {
    assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [boundary.min])).patient_code, 'SYN-OK15', '24 characters is a lookup');
    assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [boundary.max])).patient_code, 'SYN-OK15', '200 characters is a lookup');
    for (const bad of [boundary.short, boundary.long, '', null]) {
      for (const fn of ['patient_get_context($1)', 'patient_list_visits($1,30)', 'patient_list_events($1,30)']) {
        await assert.rejects(db.query(`SELECT * FROM public.${fn}`, [bad]), invalidLink, `${fn} refuses malformed input`);
      }
      await assert.rejects(db.query('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)', [bad, randomUUID()]), invalidLink);
    }
  });
  await as(owner, async () => {
    for (const bad of [boundary.short, '', null]) await assert.rejects(row('SELECT public.revoke_patient_token($1,$2)', [bad, '格式错误']), invalidLink);
  });
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.patient_tokens WHERE token_hash = ANY($1) AND revoked_at IS NULL', [[sha256(boundary.short), sha256(boundary.long)]])).n), 2, 'refused input changed nothing');
  await db.query('DELETE FROM public.patient_tokens WHERE token_hash = ANY($1)', [Object.values(boundary).map(sha256)]);
  pass('NULL, empty, shorter than 24 or longer than 200 characters is an invalid link before any lookup (context, lists, submission, revocation)');

  // ---- Participants who left the study get no links and cannot submit -------------------
  const visitCount = async code => Number((await row('SELECT count(*) AS n FROM public.visits_long WHERE project_id=$1 AND patient_code=$2', [project, code])).n);
  await as(editor, async () => {
    await assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-DUE',7,false)", [project]), fails('patient_not_eligible_for_links'), 'withdrawn consent');
    await assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-UNKNOWN',7,false)", [project]), fails('patient_not_found'));
    assert.match((await row("SELECT public.create_patient_token_v2($1,'SYN-LOST',7,false) AS t", [project])).t, /^[0-9a-f]{32}$/, 'lost to follow-up may still get a link');
  });
  const dueVisits = await visitCount('SYN-DUE');
  // (a) The link was revoked automatically when consent was withdrawn.
  await as(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)', [plaintext.withdraw, randomUUID()]), invalidLink));
  // (b) A link that escaped revocation (race with the exit change): refused, revoked, audited.
  const escaped = randomUUID().replaceAll('-', '');
  const escapedId = (await row("INSERT INTO public.patient_tokens(project_id,patient_code,token_hash,active,expires_at,single_use,created_by) VALUES($1,'SYN-DUE',$2,true,now()+interval '7 days',true,$3) RETURNING id",
    [project, sha256(escaped), owner])).id;
  await as(null, async () => {
    for (const fn of ['patient_get_context($1)', 'patient_list_visits($1,30)']) await assert.rejects(db.query(`SELECT * FROM public.${fn}`, [escaped]), invalidLink, `${fn}: no data for a withdrawn participant`);
    const refusal = await row('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)', [escaped, randomUUID()]);
    assert.deepEqual([refusal.visit_id, refusal.status, refusal.receipt_token, refusal.invalid_fields], [null, 'token_revoked', null, null]);
    assert.match(refusal.message, /已停用，本次未保存/);
    await assert.rejects(db.query('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)', [escaped, randomUUID()]), invalidLink);
  });
  assert.equal(await visitCount('SYN-DUE'), dueVisits, 'nothing was stored for the withdrawn participant');
  assert.deepEqual(await row('SELECT active,used_at,revoke_reason FROM public.patient_tokens WHERE id=$1', [escapedId]), {active: false, used_at: null, revoke_reason: 'patient_exited'});
  const exitedAudit = await row("SELECT token_hash,severity,details FROM public.security_audit_logs WHERE event_type='patient_exited_submission_refused'");
  assert.deepEqual(exitedAudit, {token_hash: sha256(escaped), severity: 'HIGH', details: {token_id: escapedId, consent_status: 'withdrawn', followup_status: 'active'}});
  pass('declined/withdrawn/deceased participants: no new link (patient_not_eligible_for_links); revoked or escaped links store nothing and the escaped one is revoked and audited');

  // ---- Direct table writes follow the same study status rules -----------------------------
  const okRow = async () => (await row("SELECT to_jsonb(b) AS r FROM public.patients_baseline b WHERE project_id=$1 AND patient_code='SYN-OK'", [project])).r;
  const okBefore = await okRow();
  await as(editor, async () => {
    const update = (sql, args = []) => db.query(`UPDATE public.patients_baseline SET ${sql} WHERE project_id=$1 AND patient_code='SYN-OK'`, [project, ...args]);
    await assert.rejects(update('consent_date=$2::date', [tomorrow]), fails('invalid_or_future_date: consent_date'));
    await assert.rejects(update('followup_status_date=$2::date', [tomorrow]), fails('invalid_or_future_date: followup_status_date'));
    for (const version of [' V3 ', 'V3 ', '', '   ', 'v1\tv2']) await assert.rejects(update('consent_version=$2', [version]), fails('invalid_consent_version'), JSON.stringify(version));
    // Entering the exit state is the dedicated action's alone.
    const dedicated = fails('study_status_requires_dedicated_action');
    await assert.rejects(update("followup_status='deceased'"), dedicated);
    await assert.rejects(update("followup_status='withdrawn'"), dedicated);
    await assert.rejects(update("consent_status='withdrawn'"), dedicated);
    await assert.rejects(update("consent_status='declined',consent_date=CURRENT_DATE"), dedicated);
    await assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,consent_status) VALUES($1,'SYN-DECLINED',CURRENT_DATE,'declined')", [project]), dedicated);
    await assert.rejects(db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,followup_status) VALUES($1,'SYN-DECEASED',CURRENT_DATE,'deceased')", [project]), dedicated);
    // A stated reason, or any session setting, does not turn a plain write into that action.
    for (const sql of ["followup_status='deceased',followup_status_date=CURRENT_DATE", "consent_status='withdrawn'"]) {
      await db.exec('BEGIN');
      await db.query("SELECT set_config('app.registry_change_reason','家属告知患者去世',true),set_config('registry.study_exit_only','on',true),set_config('registry.study_status_rpc','on',true)");
      await assert.rejects(update(sql), dedicated, sql);
      await db.exec('ROLLBACK');
    }
    // The dedicated action's row mark cannot be written or read by a member.
    await assert.rejects(db.query('INSERT INTO registry_private.study_status_rpc_rows(xact_id,record_id) VALUES(pg_current_xact_id(),$1)', [okBefore.id]), denied);
    await assert.rejects(db.query('SELECT registry_private.study_status_rpc_active($1)', [okBefore.id]), denied);
    // Leaving the exit state, or changing a recorded exit, directly: SYN-DUE withdrew consent.
    const exited = (sql, args = []) => db.query(`UPDATE public.patients_baseline SET ${sql} WHERE project_id=$1 AND patient_code='SYN-DUE'`, [project, ...args]);
    for (const sql of ["consent_status='consented'", "consent_status='unconfirmed'", "consent_status='declined'", 'consent_date=CURRENT_DATE-1',
      "consent_version='V5'", "followup_status='lost'", 'followup_status_date=CURRENT_DATE']) {
      await assert.rejects(exited(sql), dedicated, sql);
    }
  });
  assert.deepEqual(await okRow(), okBefore, 'refused direct writes changed nothing');
  assert.deepEqual(await row("SELECT consent_status,consent_date::text AS d,consent_version,followup_status FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-DUE'", [project]),
    {consent_status: 'withdrawn', d: '2025-06-01', consent_version: null, followup_status: 'active'});
  await as(editor, async () => {
    await db.query("UPDATE public.patients_baseline SET consent_version='V1.0' WHERE project_id=$1 AND patient_code='SYN-OK15'", [project]);
    await db.query("UPDATE public.patients_baseline SET followup_status='transferred' WHERE project_id=$1 AND patient_code='SYN-NOBASE'", [project]);
    // Other columns of a participant who left may still be written (data collected before the exit).
    await db.query("UPDATE public.patients_baseline SET treatment_arm='A' WHERE project_id=$1 AND patient_code='SYN-DUE'", [project]);
  });
  pass('direct table writes: no future consent/status dates (Beijing date), trimmed consent version; entering, leaving or changing a study exit is refused whatever the session settings');

  // ---- Out-of-range patient values are a structured result, never a database error -------
  const youngYear = Number((await row('SELECT extract(year FROM registry_private.local_today())::int - 19 AS y')).y);
  await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by) VALUES($1,'SYN-YOUNG',CURRENT_DATE-30,'M',$2,$3)", [project, youngYear, owner]);
  const youngLink = await as(editor, async () => (await row("SELECT public.create_patient_token_v2($1,'SYN-YOUNG',7,true) AS t", [project])).t);
  const submit = (sbp, dbp, scr, upcr, notes = null) => as(null, () => row('SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,$2,$3,$4,$5,NULL,$6,$7)',
    [youngLink, sbp, dbp, scr, upcr, notes, randomUUID()]));
  for (const [values, fields] of [
    [[350, 210, 90, 300], ['sbp', 'dbp']], [[39, 19, 90, 300], ['sbp', 'dbp']], [[120, 80, 5, 300], ['scr_umol_l']],
    [[120, 80, 5001, 300], ['scr_umol_l']], [[120, 80, 90, 50001], ['upcr']], [[120, null, null, -1], ['upcr']],
    // 10 μmol/L is inside the creatinine range, but the server-calculated eGFR of a
    // 19-year-old man exceeds the table's 0–200 range.
    [[120, 80, 10, 300], ['scr_umol_l']]]) {
    const result = await submit(...values);
    assert.deepEqual([result.status, result.visit_id, result.receipt_token, result.invalid_fields], ['invalid_values', null, null, fields], JSON.stringify(values));
    assert.match(result.message, /超出系统允许的范围，本次未保存/);
  }
  // Any CHECK violation not anticipated by the function becomes the same result.
  await db.exec("ALTER TABLE public.visits_long ADD CONSTRAINT synthetic_notes_check CHECK (notes IS DISTINCT FROM 'synthetic-check-violation') NOT VALID");
  const caught = await submit(120, 80, 90, 300, 'synthetic-check-violation');
  await db.exec('ALTER TABLE public.visits_long DROP CONSTRAINT synthetic_notes_check');
  assert.deepEqual([caught.status, caught.visit_id, caught.invalid_fields], ['invalid_values', null, ['notes']]);
  // A check raised by a trigger that names its column is reported by that column.
  await db.exec(`CREATE FUNCTION pg_temp.synthetic_column_check() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.notes = 'synthetic-column-violation' THEN RAISE EXCEPTION 'synthetic' USING ERRCODE='check_violation', COLUMN='visit_date'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_column_check BEFORE INSERT ON public.visits_long FOR EACH ROW EXECUTE FUNCTION pg_temp.synthetic_column_check();`);
  const caughtColumn = await submit(120, 80, 90, 300, 'synthetic-column-violation');
  await db.exec('DROP TRIGGER synthetic_column_check ON public.visits_long');
  assert.deepEqual([caughtColumn.status, caughtColumn.invalid_fields], ['invalid_values', ['visit_date']]);
  assert.equal(await visitCount('SYN-YOUNG'), 0, 'nothing stored');
  assert.deepEqual(await row('SELECT active,used_at,revoked_at FROM public.patient_tokens WHERE token_hash=$1', [sha256(youngLink)]), {active: true, used_at: null, revoked_at: null}, 'the single-use link is not consumed');
  // Workbench paths: a calculated eGFR above 200 is an input error with its own code; the hint
  // names every input of the calculation (creatinine, birth year, sex).
  const tooHigh = error => error.code === '23514' && error.message === 'egfr_out_of_range_check_scr'
    && ['血肌酐', '出生年份', '性别'].every(word => error.hint.includes(word));
  await as(owner, async () => {
    await assert.rejects(row("SELECT public.import_registry_rows($1,'visits',$2,$3)", [project, JSON.stringify([{patient_code: 'SYN-YOUNG', visit_date: await day(-1), sbp: 120, dbp: 80, scr_umol_l: 10}]), randomUUID()]),
      tooHigh, 'CSV/visit entry import');
    await assert.rejects(db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l) VALUES($1,'SYN-YOUNG',CURRENT_DATE-2,120,80,10)", [project]), tooHigh, 'direct write');
    assert.equal((await row("SELECT public.import_registry_rows($1,'visits',$2,$3) AS r", [project, JSON.stringify([{patient_code: 'SYN-YOUNG', visit_date: await day(-1), sbp: 120, dbp: 80, scr_umol_l: 90}]), randomUUID()])).r.inserted, 1);
  });
  const accepted = await submit(120, 80, 90, 300);
  assert.equal(accepted.status, 'submitted');
  assert.equal(await visitCount('SYN-YOUNG'), 2, 'the imported visit and the accepted submission');
  assert.ok((await row('SELECT used_at FROM public.patient_tokens WHERE token_hash=$1', [sha256(youngLink)])).used_at instanceof Date);
  // Correcting the birth year recalculates eGFR from the same creatinine (50 -> 30 years old at
  // 10 μmol/L): the same error, and its hint does not blame the creatinine alone.
  const visitYear = Number((await row('SELECT extract(year FROM CURRENT_DATE-5)::int AS y')).y);
  await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by) VALUES($1,'SYN-AGE',CURRENT_DATE-30,'M',$2,$3)", [project, visitYear - 50, owner]);
  await db.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,created_by) VALUES($1,'SYN-AGE',CURRENT_DATE-5,120,80,10,$2)", [project, owner]);
  const ageVisit = await row("SELECT egfr,egfr_formula_version FROM public.visits_long WHERE project_id=$1 AND patient_code='SYN-AGE'", [project]);
  assert.ok(ageVisit.egfr_formula_version === 'CKD-EPI-2021-Cr' && Number(ageVisit.egfr) < 200, JSON.stringify(ageVisit));
  const ageId = (await row("SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-AGE'", [project])).id;
  await as(owner, async () => {
    await assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,$3,'核对出生年份')", [project, ageId, JSON.stringify({birth_year: visitYear - 30})]),
      tooHigh, 'birth year correction');
  });
  assert.deepEqual(await row("SELECT sex,birth_year FROM public.patients_baseline WHERE id=$1", [ageId]), {sex: 'M', birth_year: visitYear - 50});
  pass('out-of-range values: patient submission returns invalid_values with field names (nothing stored, link not consumed); a calculated eGFR above 200 is egfr_out_of_range_check_scr on workbench paths, with a hint naming creatinine, birth year and sex');

  // ---- Lock order: study exits and patient submissions wait, never deadlock ---------------
  const admin = await connectOther();
  const other = await connectOther();
  const third = await connectOther();
  const mainPid = Number((await row('SELECT pg_backend_pid() AS p')).p);
  const thirdPid = Number((await third.query('SELECT pg_backend_pid() AS p')).rows[0].p);
  const waitsOnLock = pid => async () => (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock';
  async function eventually(check, label) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
    throw new Error(`timed out: ${label}`);
  }
  const outcome = promise => promise.then(value => ({value}), error => ({error}));
  const noDeadlock = result => assert.ok(!result.error || result.error.code !== '40P01', `no deadlock: ${result.error?.message}`);
  await db.exec("SET deadlock_timeout='100ms'");
  for (const code of ['SYN-RACE1', 'SYN-RACE2', 'SYN-RACE3', 'SYN-RACE4']) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by) VALUES($1,$2,CURRENT_DATE-30,'F',1980,$3)", [project, code, owner]);
  }
  const raceLink = async (code, single = false) => as(editor, async () => (await row('SELECT public.create_patient_token_v2($1,$2,7,$3) AS t', [project, code, single])).t);
  const raceId = async code => (await row('SELECT id FROM public.patients_baseline WHERE project_id=$1 AND patient_code=$2', [project, code])).id;
  const submitSql = 'SELECT * FROM public.patient_submit_visit_v2($1,CURRENT_DATE,120,80,90,300,NULL,NULL,$2)';

  // (1) A correction cannot withdraw consent. The dedicated action does, and holds the patient;
  // a submission waits for it, then is refused.
  const link1 = await raceLink('SYN-RACE1');
  const race1Id = await raceId('SYN-RACE1');
  await as(owner, async () => assert.rejects(row("SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"consent_status\":\"withdrawn\"}','患者书面撤回同意')", [project, race1Id]),
    error => error.message === 'study_status_requires_dedicated_action: consent_status'));
  await other.query('BEGIN');
  await setRole(other, owner);
  await other.query("SELECT public.set_patient_study_status($1,'SYN-RACE1','{\"consent_status\":\"withdrawn\"}','患者书面撤回同意')", [project]);
  const pending1 = outcome(as(null, () => db.query(submitSql, [link1, randomUUID()])));
  await eventually(waitsOnLock(mainPid), 'submission waits for the status change');
  await other.query('COMMIT; RESET ROLE');
  const result1 = await pending1;
  noDeadlock(result1);
  assert.ok(result1.error && invalidLink(result1.error), 'refused after the withdrawal committed');
  assert.equal(await visitCount('SYN-RACE1'), 0);

  // (2) A submission holds the patient; a CSV import withdrawing consent waits for it and is then
  // refused (nothing changes, the link keeps working). The dedicated action waits for the next
  // submission, then withdraws consent and revokes the link.
  const link2 = await raceLink('SYN-RACE2');
  await other.query('BEGIN');
  await setRole(other, null);
  assert.equal((await other.query(submitSql, [link2, randomUUID()])).rows[0].status, 'submitted');
  const pending2 = outcome(as(owner, () => row("SELECT public.import_registry_rows($1,'baseline',$2,$3) AS r", [project, JSON.stringify([{patient_code: 'SYN-RACE2', consent_status: 'withdrawn'}]), randomUUID()])));
  await eventually(waitsOnLock(mainPid), 'import waits for the submission');
  await other.query('COMMIT; RESET ROLE');
  const result2 = await pending2;
  noDeadlock(result2);
  assert.equal(result2.error?.message, 'row_1_study_status_requires_dedicated_action: consent_status', JSON.stringify(result2.value));
  assert.deepEqual(await row('SELECT active,revoke_reason FROM public.patient_tokens WHERE token_hash=$1', [sha256(link2)]), {active: true, revoke_reason: null}, 'the refused import revoked nothing');
  await other.query('BEGIN');
  await setRole(other, null);
  assert.equal((await other.query(submitSql, [link2, randomUUID()])).rows[0].status, 'submitted');
  const pending2b = outcome(as(owner, () => setStatus('SYN-RACE2', {consent_status: 'withdrawn'}, '患者书面撤回同意')));
  await eventually(waitsOnLock(mainPid), 'the status change waits for the submission');
  await other.query('COMMIT; RESET ROLE');
  const result2b = await pending2b;
  noDeadlock(result2b);
  assert.equal(result2b.value?.changed, true, result2b.error?.message);
  assert.equal(await visitCount('SYN-RACE2'), 2, 'both earlier submissions are kept');
  assert.equal((await row('SELECT revoke_reason FROM public.patient_tokens WHERE token_hash=$1', [sha256(link2)])).revoke_reason, 'consent_withdrawn');

  // (3) A plain table write cannot record a death, even with a stated reason. The dedicated
  // action holds the patient; a submission waits for it, then is refused.
  const link3 = await raceLink('SYN-RACE3');
  await other.query('BEGIN');
  await setRole(other, editor);
  await other.query("SELECT set_config('app.registry_change_reason','家属告知患者去世',true)");
  await assert.rejects(other.query("UPDATE public.patients_baseline SET followup_status='deceased',followup_status_date=CURRENT_DATE WHERE project_id=$1 AND patient_code='SYN-RACE3'", [project]),
    fails('study_status_requires_dedicated_action'));
  await other.query('ROLLBACK');
  await other.query('BEGIN');
  await setRole(other, editor);
  await other.query("SELECT public.set_patient_study_status($1,'SYN-RACE3',$2,'家属告知患者去世')", [project, JSON.stringify({followup_status: 'deceased', followup_status_date: await day(0)})]);
  const pending3 = outcome(as(null, () => db.query(submitSql, [link3, randomUUID()])));
  await eventually(waitsOnLock(mainPid), 'submission waits for the status change');
  await other.query('COMMIT; RESET ROLE');
  const result3 = await pending3;
  noDeadlock(result3);
  assert.ok(result3.error && invalidLink(result3.error));
  await as(editor, async () => assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-RACE3',7,false)", [project]), fails('patient_not_eligible_for_links'), 'deceased'));
  assert.equal((await row("SELECT change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id WHERE b.project_id=$1 AND b.patient_code='SYN-RACE3' AND a.field_name='followup_status'", [project])).change_reason, '家属告知患者去世');

  // (4) A third session holds one link row; the exit change (baseline, then links) waits for
  // it while a submission on another link waits for the baseline. Everything completes.
  const link4a = await raceLink('SYN-RACE4');
  const link4b = await raceLink('SYN-RACE4');
  const link4aId = (await row('SELECT id FROM public.patient_tokens WHERE token_hash=$1', [sha256(link4a)])).id;
  await other.query('BEGIN');
  await setRole(other, owner);
  await other.query("SELECT public.revoke_patient_token_by_id($1,$2,'发错对象')", [project, link4aId]);
  const pending4 = outcome(as(owner, () => setStatus('SYN-RACE4', {consent_status: 'withdrawn'}, '患者书面撤回同意')));
  await eventually(waitsOnLock(mainPid), 'exit change waits for the held link row');
  await setRole(third, null);
  const pending4b = outcome(third.query(submitSql, [link4b, randomUUID()]));
  await eventually(waitsOnLock(thirdPid), 'submission waits for the exit change');
  await other.query('COMMIT; RESET ROLE');
  const [result4, result4b] = await Promise.all([pending4, pending4b]);
  noDeadlock(result4); noDeadlock(result4b);
  assert.equal(result4.value?.changed, true, result4.error?.message);
  assert.ok(result4b.error && invalidLink(result4b.error), result4b.value ? JSON.stringify(result4b.value.rows) : '');
  await third.query('RESET ROLE');
  assert.deepEqual((await rows('SELECT revoke_reason FROM public.patient_tokens WHERE token_hash = ANY($1) ORDER BY revoke_reason', [[sha256(link4a), sha256(link4b)]])).map(r => r.revoke_reason),
    ['consent_withdrawn', '发错对象']);

  // (5) A direct multi-row visit insert (as the API sends it) waits for a patient held by another
  // session while a correction or a baseline import of another of its patients starts. The insert
  // takes the project row before any baseline row, so the correction/import waits behind it.
  const otherPid = Number((await other.query('SELECT pg_backend_pid() AS p')).rows[0].p);
  for (const code of ['SYN-RACE5X', 'SYN-RACE5Y']) {
    await db.query("INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by) VALUES($1,$2,CURRENT_DATE-30,'F',1980,$3)", [project, code, owner]);
  }
  const race5X = await raceId('SYN-RACE5X');
  for (const [label, sql, args, offset] of [
    ['correction', "SELECT public.correct_registry_record($1,'patients_baseline',$2,'{\"treatment_arm\":\"A\"}','核对随机分组')", [project, race5X], -3],
    ['baseline import', "SELECT public.import_registry_rows($1,'baseline',$2,$3)", [project, JSON.stringify([{patient_code: 'SYN-RACE5X', treatment_arm: 'B'}]), randomUUID()], -4]]) {
    await third.query('BEGIN');
    await third.query("SELECT 1 FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-RACE5Y' FOR UPDATE", [project]);
    await other.query('BEGIN');
    await setRole(other, editor);
    const inserting = outcome(other.query("INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp) VALUES($1,'SYN-RACE5X',$2::date,120,80),($1,'SYN-RACE5Y',$2::date,121,81)", [project, await day(offset)]));
    await eventually(waitsOnLock(otherPid), `direct insert waits for the held patient (${label})`);
    const writing = outcome(as(owner, () => db.query(sql, args)));
    await eventually(waitsOnLock(mainPid), `${label} waits for the direct insert`);
    await third.query('COMMIT');
    const inserted = await inserting;
    noDeadlock(inserted);
    assert.equal(inserted.value?.rowCount, 2, inserted.error?.message);
    await other.query('COMMIT; RESET ROLE');
    const written = await writing;
    noDeadlock(written);
    assert.ok(!written.error, written.error?.message);
  }
  assert.equal(await visitCount('SYN-RACE5X') + await visitCount('SYN-RACE5Y'), 4);
  assert.equal((await row("SELECT treatment_arm FROM public.patients_baseline WHERE id=$1", [race5X])).treatment_arm, 'B');
  await db.exec('RESET deadlock_timeout');
  pass('lock order project → baseline → links on every path: exits only through set_patient_study_status (correction, import and direct write refused, also while waiting); exits, submissions, direct visit inserts, corrections and imports wait for each other without deadlock (40P01)');

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
  assert.match(content.field_notes.consent_date, /当前同意状态对应的日期.*拒绝或撤回为拒绝或撤回日期.*历次.*审计记录/);
  assert.match(content.field_notes.followup_status_date, /当前随访状态的变更日期/);
  for (const secret of [...Object.values(plaintext), issued, legacy, escaped, newLink, youngLink, link1, link2, link3, link4a, link4b]) {
    assert.ok(!exported.content_text.includes(secret) && !exported.content_text.includes(sha256(secret)), 'no link or link digest in exports');
  }
  pass('frozen export includes consent/follow-up columns, project study details and the meaning of the current consent date; no link material');

  // ---- Re-running the increments is harmless ----------------------------------------------
  const snapshot = await rows('SELECT id,consent_status,consent_research,updated_at FROM public.patients_baseline ORDER BY id');
  const tokenSnapshot = await rows('SELECT id,token,token_hash,active,updated_at FROM public.patient_tokens ORDER BY id');
  const auditSnapshot = await rows('SELECT id FROM public.security_audit_logs ORDER BY id');
  const fieldAuditCount = Number((await row('SELECT count(*) AS n FROM public.field_audit_log')).n);
  for (const file of NEW_MIGRATIONS) await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8'));
  assert.deepEqual(await rows('SELECT id,consent_status,consent_research,updated_at FROM public.patients_baseline ORDER BY id'), snapshot);
  assert.deepEqual(await rows('SELECT id,token,token_hash,active,updated_at FROM public.patient_tokens ORDER BY id'), tokenSnapshot);
  assert.deepEqual(await rows('SELECT id FROM public.security_audit_logs ORDER BY id'), auditSnapshot, 'no further security audit entries');
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.field_audit_log')).n), fieldAuditCount, 'no further field audit entries');
  assert.equal(Number((await row('SELECT count(*) AS n FROM public.registry_schema_versions')).n), 8);
  await as(null, async () => assert.equal((await row('SELECT patient_code FROM public.patient_get_context($1)', [plaintext.valid])).patient_code, 'SYN-LINK'));
  pass('re-applying 0038/0039 keeps entered consent, derived values, digests, audits and working links');

  // ---- Row-level security decides project access once per query, exactly as before ---------
  // A large synthetic project (bulk-loaded with triggers off): 240 patients, 3 visits and one
  // link each. The owner is also listed as a viewer of it, the editor is a viewer there and the
  // analyst an editor, so the same user holds different roles in different projects.
  const bigProject = randomUUID();
  await db.exec('SET session_replication_role=replica');
  await db.query("INSERT INTO public.projects(id,name,center_code,module,created_by) VALUES($1,'Synthetic large project','BIG','IGAN',$2)", [bigProject, owner]);
  await db.query(`INSERT INTO public.patients_baseline(project_id,patient_code,baseline_date,sex,birth_year,created_by)
    SELECT $1,'BIG-'||lpad(g::text,4,'0'),CURRENT_DATE-400,'M',1970,$2 FROM generate_series(1,240) g`, [bigProject, owner]);
  await db.query(`INSERT INTO public.visits_long(project_id,patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,created_by)
    SELECT $1,'BIG-'||lpad(g::text,4,'0'),CURRENT_DATE-360+v*100,120,80,90,300,$2 FROM generate_series(1,240) g,generate_series(1,3) v`, [bigProject, owner]);
  await db.query(`INSERT INTO public.patient_tokens(project_id,patient_code,token_hash,expires_at,single_use,created_by)
    SELECT $1,'BIG-'||lpad(g::text,4,'0'),encode(sha256(convert_to('big-'||g,'UTF8')),'hex'),now()+interval '30 days',false,$2 FROM generate_series(1,240) g`, [bigProject, owner]);
  await db.exec('SET session_replication_role=origin; ANALYZE');
  await db.query("INSERT INTO public.project_members(project_id,user_id,role,created_by) VALUES($1,$2,'viewer',$2),($1,$3,'viewer',$2),($1,$4,'editor',$2)", [bigProject, owner, editor, analyst]);
  // (a) The set lookup answers exactly as has_project_permission, for every user (including no
  // user), project (including an unknown one) and permission (including unknown and none).
  const permissionCases = [];
  for (const user of [owner, editor, analyst, viewer, outsider, null]) {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user || '']);
    for (const r of await rows(`SELECT p::text AS project,perm,public.has_project_permission(p,perm) AS expected,
        p IN (SELECT registry_private.project_ids_with_permission(perm)) AS actual
      FROM unnest($1::uuid[]) AS p CROSS JOIN unnest($2::text[]) AS perm`,
      [[project, otherProject, bigProject, randomUUID()], ['read', 'write', 'tokens', 'export', 'manage', 'owner', '', null]])) {
      permissionCases.push({user, ...r});
    }
  }
  await db.exec('RESET request.jwt.claim.sub');
  assert.deepEqual(permissionCases.filter(c => c.expected !== c.actual), [], 'same answer as has_project_permission');
  assert.equal(permissionCases.length, 6 * 4 * 8);
  assert.equal(permissionCases.filter(c => c.expected).length, (5 + 5) + (3 + 1) + (2 + 3) + 1 + 5, 'granted pairs: owner 5+5, editor 3+1, analyst 2+3, viewer 1, outsider 5');
  const setFn = await row(`SELECT p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_schema_privilege('authenticated','registry_private','USAGE') AS schema_usage
    FROM pg_proc p WHERE p.oid='registry_private.project_ids_with_permission(text)'::regprocedure`);
  assert.deepEqual(setFn, {prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, pg_temp'], auth: true, anon: false, schema_usage: false});
  await as(owner, async () => assert.rejects(db.query("SELECT registry_private.project_ids_with_permission('read')"), denied, 'not callable by name or through the API'));
  assert.deepEqual(await rows("SELECT tablename,policyname FROM pg_policies WHERE qual ~ 'has_project_permission' OR with_check ~ 'has_project_permission'"), [], 'no policy asks per row');
  // (b) The board, its count and the overview evaluate the permission set a fixed number of times,
  // whatever the number of rows, and never call has_project_permission per row.
  // Function call counters of this backend (not yet reported counts accumulate across
  // transactions, so the difference around the one query is taken inside one transaction).
  const callCounters = () => row(`SELECT coalesce(pg_stat_get_xact_function_calls('public.has_project_permission(uuid,text)'::regprocedure),0)::int AS per_row,
    coalesce(pg_stat_get_xact_function_calls('registry_private.project_ids_with_permission(text)'::regprocedure),0)::int AS per_query`);
  async function permissionCalls(sql, args) {
    await db.exec('BEGIN');
    try {
      await db.exec("SET LOCAL track_functions='all'");
      const before = await callCounters();
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      await db.exec('SET LOCAL ROLE authenticated');
      const result = await db.query(sql, args);
      await db.exec('RESET ROLE');
      const after = await callCounters();
      return {rows: result.rows, per_row: after.per_row - before.per_row, per_query: after.per_query - before.per_query};
    } finally { await db.exec('ROLLBACK'); }
  }
  const boardSql = 'SELECT * FROM public.v_patient_followup_status WHERE project_id=$1 ORDER BY patient_id';
  const countSql = 'SELECT count(*)::int AS n FROM public.v_patient_followup_status WHERE project_id=$1';
  const overviewSql = 'SELECT * FROM public.v_project_overview WHERE project_id=$1';
  const smallCount = Number((await row('SELECT count(*) AS n FROM public.patients_baseline WHERE project_id=$1', [project])).n);
  for (const sql of [boardSql, countSql, overviewSql]) {
    const small = await permissionCalls(sql, [project]), big = await permissionCalls(sql, [bigProject]);
    assert.deepEqual([small.per_row, big.per_row], [0, 0], `${sql}: no per-row permission call`);
    assert.equal(big.per_query, small.per_query, `${sql}: ${smallCount} and 240 patients evaluate the permission set equally often`);
    assert.ok(big.per_query >= 1 && big.per_query <= 12, `${sql}: ${big.per_query} evaluations`);
    if (sql === boardSql) assert.deepEqual([small.rows.length, big.rows.length], [smallCount, 240]);
    if (sql === overviewSql) assert.deepEqual([big.rows[0].n_patients, big.rows[0].n_visits, big.rows[0].n_active], [240, 720, 240]);
  }
  pass('row-level security: one set lookup per query with exactly has_project_permission\'s answers (no per-row calls), executable by signed-in users only and not by name');

  // ---- After the account trial ends: recording an exit still works; nothing else does ----
  await db.query("UPDATE public.user_profiles SET account_trial_expires_at=now()-interval '1 day' WHERE user_id=$1", [owner]);
  const today = await day(0);
  await as(editor, async () => {
    const moved = await setStatus('SYN-OK', {followup_status: 'transferred', followup_status_date: today}, '转至外院随访');
    assert.deepEqual([moved.followup_status, moved.followup_status_date, moved.changed], ['transferred', today, true]);
    for (const [code, changes, reason] of [
      ['SYN-OK', {followup_status: 'active'}, '恢复随访'], ['SYN-OK', {consent_version: 'V3.0'}, null],
      ['SYN-DUE', {consent_status: 'consented'}, '重新签署'], ['SYN-OK15', {consent_status: 'consented'}, null],
      ['SYN-OK15', {consent_status: 'withdrawn', consent_version: 'V9'}, '撤回同意'], ['SYN-OK', {followup_status: 'transferred'}, '重复登记']]) {
      await assert.rejects(setStatus(code, changes, reason), fails('subscription_required'), JSON.stringify(changes));
    }
    await assert.rejects(row("SELECT public.create_patient_token_v2($1,'SYN-OK15',7,false)", [project]), fails('subscription_required'));
  });
  await as(owner, async () => {
    const left = await setStatus('SYN-LINK', {consent_status: 'withdrawn', consent_date: today}, '患者书面撤回同意');
    assert.deepEqual([left.consent_status, left.consent_date, left.changed], ['withdrawn', today, true]);
    // A plain table write gets no exemption, even with a reason or a forged flag: an exit is
    // refused as not the dedicated action, any other change by the account write guard.
    for (const [setting, value, sql, code] of [['app.registry_change_reason', '撤回同意', "consent_status='withdrawn'", 'study_status_requires_dedicated_action'],
      ['registry.study_status_rpc', 'on', "consent_status='withdrawn'", 'study_status_requires_dedicated_action'],
      ['registry.study_exit_only', 'on', "consent_version='V9'", 'subscription_required']]) {
      await db.exec('BEGIN');
      await db.query('SELECT set_config($1,$2,true)', [setting, value]);
      await assert.rejects(db.query(`UPDATE public.patients_baseline SET ${sql} WHERE project_id=$1 AND patient_code='SYN-OK15'`, [project]), fails(code), sql);
      await db.exec('ROLLBACK');
    }
  });
  // The exemption covers only a move from "not left" to "left" and the first entry of its date:
  // never a move between exit statuses or a change to a recorded exit date.
  await as(owner, async () => {
    for (const [code, changes] of [
      ['SYN-OK', {followup_status: 'lost'}], ['SYN-OK', {followup_status: 'deceased'}], ['SYN-OK', {followup_status_date: await day(-1)}],
      ['SYN-RACE3', {followup_status: 'lost'}], ['SYN-RACE3', {followup_status: 'transferred'}], ['SYN-RACE3', {followup_status_date: await day(-1)}],
      ['SYN-LINK', {consent_status: 'declined'}], ['SYN-LINK', {consent_date: await day(-1)}], ['SYN-LINK', {consent_date: ''}],
      ['SYN-LINK', {followup_status: 'deceased', consent_date: await day(-1)}]]) {
      await assert.rejects(setStatus(code, changes, '核对原始记录'), fails('subscription_required'), `${code} ${JSON.stringify(changes)}`);
    }
    const lost = await setStatus('SYN-NOVISIT', {followup_status: 'lost'}, '多次联系不上');
    assert.deepEqual([lost.followup_status, lost.followup_status_date, lost.changed], ['lost', null, true]);
    assert.equal((await setStatus('SYN-NOVISIT', {followup_status_date: await day(-2)}, '补填失访日期')).followup_status_date, await day(-2), 'first entry of the date');
    await assert.rejects(setStatus('SYN-NOVISIT', {followup_status_date: await day(-3)}, '修改失访日期'), fails('subscription_required'), 'a recorded date stays');
    assert.equal((await setStatus('SYN-OVER', {consent_status: 'declined'}, '患者拒绝参加研究')).consent_status, 'declined');
    assert.equal((await setStatus('SYN-OVER', {consent_date: await day(-2)}, '补填拒绝日期')).consent_date, await day(-2), 'first entry of the date');
    await assert.rejects(setStatus('SYN-OVER', {consent_date: await day(-3)}, '修改拒绝日期'), fails('subscription_required'), 'a recorded date stays');
    await assert.rejects(setStatus('SYN-OVER', {consent_status: 'withdrawn'}, '改为撤回'), fails('subscription_required'), 'declined -> withdrawn');
  });
  assert.deepEqual(await row("SELECT followup_status,followup_status_date::text AS d FROM public.patients_baseline WHERE project_id=$1 AND patient_code='SYN-RACE3'", [project]),
    {followup_status: 'deceased', d: today}, 'refused changes changed nothing');
  assert.equal((await row("SELECT change_reason FROM public.field_audit_log a JOIN public.patients_baseline b ON b.id=a.record_id WHERE b.project_id=$1 AND b.patient_code='SYN-OK' AND a.field_name='followup_status'", [project])).change_reason, '转至外院随访');
  await as(null, async () => {
    for (const value of [plaintext.valid, plaintext.single]) await assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [value]), invalidLink, 'withdrawal after expiry revokes links');
  });
  await as(owner, async () => {
    assert.equal((await setSettings({contact_display: '研究办公室'})).contact_display, '研究办公室');
    const lastLink = (await row("SELECT id FROM public.patient_tokens WHERE project_id=$1 AND token_hash=$2", [project, sha256(plaintext.lost)])).id;
    await row("SELECT public.revoke_patient_token_by_id($1,$2,'试用结束后撤销')", [project, lastLink]);
  });
  await as(null, async () => assert.rejects(db.query('SELECT * FROM public.patient_get_context($1)', [plaintext.lost]), denied));
  pass('after the trial ends: consent withdrawal and stopped follow-up (and the first entry of their date) are recorded with links revoked; moves between exit statuses, changed exit dates, other status changes, new links and plain table writes are refused; settings and revocation still work');

  console.log(`ADOPTION_DB_OK ${groups} groups; synthetic local PostgreSQL 17 database only.`);
} finally {
  for (const client of extraClients) await client.end().catch(() => {});
  await db.close();
}
