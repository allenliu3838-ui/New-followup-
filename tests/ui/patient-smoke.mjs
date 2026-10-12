// Browser smoke test for the participant follow-up page (/p/<link>).
// Static files are served locally; every Supabase RPC is answered by page.route with
// synthetic data. No real database, no network beyond 127.0.0.1.
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/ui/patient-smoke.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const config = fs.readFileSync(path.join(SITE, 'config.js'), 'utf8');
const SUPABASE_HOST = new URL(config.match(/SUPABASE_URL:\s*"([^"]+)"/)[1]).host;

// ---------- pure helpers ----------
// Loaded as source text so Node treats the browser module as ESM without a package.json type.
const wf = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(SITE, 'lib/patient-workflow.js'), 'utf8')));
const codes = ['token_invalid_or_expired', 'token_expired', 'token_revoked', 'single_use_token_already_used', 'token_invalid',
  'subscription_required', 'trial_expired', 'rate_limited', 'same_day_limit_exceeded', 'pii_detected_blocked', 'future_visit_date',
  'visit_before_baseline', 'idempotency_conflict', 'missing_core_fields', 'something_unexpected_xyz'];
for (const code of codes) {
  const { message } = wf.classifyPatientError({ message: code, details: 'ERROR: ' + code });
  assert.ok(message && !/[A-Za-z_]{4,}/.test(message.replace(/UPCR/g, '')), `untranslated message for ${code}: ${message}`);
}
assert.match(wf.classifyPatientError('token_expired').message, /已过期/);
assert.match(wf.classifyPatientError('token_revoked').message, /停用/);
assert.match(wf.classifyPatientError('single_use_token_already_used').message, /已经提交过/);
assert.match(wf.classifyPatientError('token_invalid').message, /无法识别/);
assert.equal(wf.classifyPatientError('trial_expired').message, '本研究暂时不接受在线填报，请联系研究团队。');
assert.equal(wf.classifyPatientError({ message: 'TypeError: Failed to fetch' }).kind, 'network');
assert.equal(wf.submissionOutcome({ status: 'same_day_limit_exceeded', visit_id: null }).kind, 'limit');
assert.equal(wf.submissionOutcome({ status: 'submitted', visit_id: 'x', message: '已提交，无需重复录入' }).replay, true);
assert.equal(wf.studyInfo({ project_name: '内部名', public_title: '  ' }).title, '内部名');
assert.equal(wf.normalizedNumber('1.2', 88.4), 106.08);

// ---------- static server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/p/') || pathname === '/followup') pathname = '/patient.html';
  const file = path.join(SITE, path.normalize(pathname));
  if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function launch() {
  try { return await chromium.launch(); } catch (error) {
    // Fall back to an already-installed Chromium build; never download browsers here.
    const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse().flatMap(name => [
      path.join(dir, name, 'chrome-linux/headless_shell'), path.join(dir, name, 'chrome-linux/chrome')]) : [];
    const executablePath = candidates.find(p => fs.existsSync(p));
    if (!executablePath) throw error;
    return chromium.launch({ executablePath });
  }
}
const browser = await launch();

// ---------- synthetic Supabase ----------
const baseContext = {
  project_id: '00000000-0000-4000-8000-000000000001', project_name: '内部项目名-不应显示', center_code: 'SH01', module: 'igan',
  patient_code: 'IGAN-007', sex: 'M', birth_year: 1980,
  trial_expires_at: '2026-10-20T00:00:00Z', trial_grace_until: '2026-10-27T00:00:00Z', subscription_plan: 'trial',
  subscription_active_until: null, can_write: true, write_block_reason: null, single_use: false,
  token_expires_at: '2026-12-31T08:00:00Z',
  public_title: 'IgA 肾病长期随访研究', institution_name: '示例大学附属医院肾内科',
  ethics_approval_no: '伦审2026-018号', contact_display: '研究护士 王老师',
};
const visitRows = [{ visit_date: '2025-05-01', sbp: 130, dbp: 80, scr_umol_l: 98, upcr: 520, egfr: 78.2, notes: '' }];
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const pgError = code => json({ code: '42501', message: code, details: null, hint: null }, 400);

async function openPage({ token, rpc }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await context.newPage();
  const record = { external: [], errors: [], calls: [] };
  page.on('pageerror', error => record.errors.push(String(error)));
  page.on('dialog', dialog => { record.errors.push('unexpected dialog: ' + dialog.message()); dialog.dismiss(); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.host !== `127.0.0.1:${server.address().port}` && url.host !== SUPABASE_HOST) record.external.push(request.url());
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.host !== SUPABASE_HOST) return route.abort('blockedbyclient');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const match = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
    if (!match) return route.fulfill({ status: 404, headers: cors, body: '{}' });
    const name = match[1];
    const body = request.postDataJSON() || {};
    record.calls.push({ name, body });
    const result = await rpc(name, body, record);
    if (result === 'abort') return route.abort('failed');
    return route.fulfill({ status: result.status, headers: { ...cors, 'content-type': 'application/json' }, body: result.body });
  });
  await page.goto(`${BASE}/p/${token}`);
  return { page, context, record };
}

const bodyText = page => page.evaluate(() => document.body.innerText);
const FORBIDDEN = /试用|剩余\s*\d+\s*天|订阅|subscription|trial|token|Token|令牌|患者编号|后台/;

function assertClean(record, label) {
  assert.deepEqual(record.external, [], `${label}: external hosts requested`);
  assert.deepEqual(record.errors, [], `${label}: uncaught errors`);
}

// ---------- Scenario A: valid multi-use link, delayed submit, retry-safe, fill again ----------
{
  let releaseSubmit;
  const submitGate = new Promise(resolve => { releaseSubmit = resolve; });
  const { page, context, record } = await openPage({ token: 'synthetic-multi-0001', rpc: async (name, body) => {
    if (name === 'patient_get_context') { assert.equal(body.p_token, 'synthetic-multi-0001'); return json([baseContext]); }
    if (name === 'patient_list_visits') return json(visitRows);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') {
      await submitGate;
      return json([{ visit_id: '11111111-2222-4333-8444-555555555555', server_time: '2025-06-15T06:30:00Z',
        receipt_token: 'synthetic-receipt', receipt_expires_at: '2025-06-16T06:30:00Z', status: 'submitted', message: '提交成功' }]);
    }
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#studyTitle').textContent.includes('IgA'));
  assert.equal(await page.textContent('#studyTitle'), 'IgA 肾病长期随访研究');
  const info = await page.textContent('#studyInfo');
  for (const expected of ['示例大学附属医院肾内科', '伦审2026-018号', '研究护士 王老师', 'IGAN-007']) assert.ok(info.includes(expected), `study info missing ${expected}`);
  await page.waitForSelector('#visitsBox table');
  let text = await bodyText(page);
  assert.ok(!FORBIDDEN.test(text), 'forbidden wording visible: ' + text.match(FORBIDDEN));
  assert.ok(!text.includes('内部项目名-不应显示'), 'internal project name shown although public_title exists');
  assert.ok((await page.textContent('footer')).includes('技术支持：肾域科研平台'));
  const about = await page.textContent('#aboutStudy');
  for (const part of ['这是什么', '谁能看到这些数据', '不要填写的内容', '填错了怎么办', '可以退出吗']) assert.ok(about.includes(part), 'about section missing ' + part);

  // Mobile ergonomics: >=16px controls, numeric keyboards, sticky submit bar.
  const styles = await page.evaluate(() => ['#visitDate', '#sbp', '#dbp', '#scr', '#scrUnit', '#upcr', '#notes']
    .map(sel => [sel, parseFloat(getComputedStyle(document.querySelector(sel)).fontSize)]));
  for (const [sel, size] of styles) assert.ok(size >= 16, `${sel} font-size ${size}px < 16px`);
  assert.equal(await page.getAttribute('#sbp', 'inputmode'), 'numeric');
  assert.equal(await page.getAttribute('#scr', 'inputmode'), 'decimal');
  assert.equal(await page.getAttribute('#upcr', 'inputmode'), 'decimal');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.submit-bar')).position), 'sticky');
  const buttonHeight = await page.evaluate(() => document.querySelector('#btnSubmit').getBoundingClientRect().height);
  assert.ok(buttonHeight >= 44, 'submit button too small for touch');

  await page.fill('#visitDate', '2025-06-15');
  await page.fill('#sbp', '128');
  await page.fill('#dbp', '78');
  await page.fill('#scr', '1.2');
  await page.selectOption('#scrUnit', 'mgdl');
  await page.fill('#upcr', '450');
  await page.click('#btnSubmit');
  await page.waitForSelector('#reviewBox:not([hidden])');
  assert.equal((await page.textContent('#btnSubmit')).trim(), '确认提交');
  assert.ok((await page.textContent('#reviewBox')).includes('106.08 μmol/L'));
  assert.equal(record.calls.filter(c => c.name === 'patient_submit_visit_v2').length, 0, 'submitted before confirmation');

  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#btnSubmit').disabled && document.querySelector('#btnSubmit').textContent.includes('正在提交'));
  await page.click('#btnSubmit', { force: true }).catch(() => {});
  await page.evaluate(() => document.querySelector('#visitForm').requestSubmit());
  assert.equal(await page.isDisabled('#btnSubmit'), true, 'submit button must be disabled during the request');
  assert.equal(record.calls.filter(c => c.name === 'patient_submit_visit_v2').length, 1, 'duplicate submit request while pending');
  releaseSubmit();
  await page.waitForSelector('#doneBox:not([hidden])');
  const done = await page.textContent('#doneBox');
  assert.ok(done.includes('已提交') && done.includes('2025-06-15') && done.includes('2025-06-15 14:30'), 'confirmation lacks date/time: ' + done);
  const values = await page.evaluate(() => ['#visitDate', '#sbp', '#dbp', '#scr', '#upcr', '#notes', '#egfr'].map(s => document.querySelector(s).value));
  assert.deepEqual(values, ['', '', '', '', '', '', ''], 'inputs not cleared after submission');
  const payload = record.calls.find(c => c.name === 'patient_submit_visit_v2').body;
  assert.equal(payload.p_token, 'synthetic-multi-0001');
  assert.equal(payload.p_scr_umol_l, 106.08);
  assert.equal(payload.p_upcr, 450);
  assert.match(payload.p_request_id, /^[0-9a-f-]{36}$/);
  assert.equal(await page.isVisible('#btnNextVisit'), true);
  assert.equal((await page.textContent('#btnNextVisit')).trim(), '再填一次');

  await page.click('#btnNextVisit');
  await page.waitForSelector('#visitForm:not([hidden])');
  assert.equal(await page.isDisabled('#sbp'), false);
  assert.equal(await page.inputValue('#sbp'), '');
  await page.click('#moreRecords summary');
  await page.waitForFunction(() => document.querySelector('#eventsBox').textContent.includes('暂无'));
  for (const name of ['patient_list_visits', 'patient_list_labs', 'patient_list_meds', 'patient_list_variants', 'patient_list_events']) {
    assert.ok(record.calls.some(c => c.name === name), `${name} not called`);
  }
  text = await bodyText(page);
  assert.ok(!FORBIDDEN.test(text), 'forbidden wording after submit: ' + text.match(FORBIDDEN));
  assertClean(record, 'multi-use');
  await context.close();
}

// ---------- Scenario B: expired / revoked / used / invalid links ----------
for (const [code, expected] of [
  ['token_invalid_or_expired', '这个随访链接已过期、已停用或已经使用过'],
  ['token_expired', '这个随访链接已过期。请联系研究团队获取新的随访链接。'],
  ['token_revoked', '已被研究团队停用'],
  ['single_use_token_already_used', '只能提交一次，且已经提交过'],
  ['token_invalid', '无法识别这个随访链接'],
]) {
  const { page, context, record } = await openPage({ token: 'synthetic-' + code, rpc: async name => {
    if (name === 'patient_get_context') return pgError(code);
    throw new Error('history must not load for a failed link: ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#linkStatus').textContent.length > 0);
  assert.ok((await page.textContent('#linkStatus')).includes(expected), `${code}: ${await page.textContent('#linkStatus')}`);
  const text = await bodyText(page);
  assert.ok(!text.includes(code) && !/token|Token|ERROR/.test(text), `${code}: raw error visible`);
  assert.equal(await page.isDisabled('#btnSubmit'), true);
  assert.equal(await page.isDisabled('#sbp'), true, 'inputs must be locked for an unusable link');
  assert.equal(await page.isVisible('#formSection'), false, 'entry form shown for an unusable link');
  assertClean(record, code);
  await context.close();
}

// ---------- Scenario C: project not accepting entries (read-only) ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-readonly', rpc: async name => {
    if (name === 'patient_get_context') return json([{ ...baseContext, can_write: false, write_block_reason: 'subscription_required', trial_expires_at: '2026-01-01T00:00:00Z' }]);
    if (name.startsWith('patient_list_')) return json([]);
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#linkStatus').textContent.length > 0);
  const status = await page.textContent('#linkStatus');
  assert.ok(status.startsWith('本研究暂时不接受在线填报，请联系研究团队。'), status);
  const text = await bodyText(page);
  assert.ok(!FORBIDDEN.test(text), 'read-only page shows reason detail: ' + text.match(FORBIDDEN));
  assert.equal(await page.isVisible('#formSection'), false, 'entry form shown although the study is not accepting entries');
  await page.waitForSelector('#visitsBox .muted');
  assert.equal(await page.isDisabled('#btnSubmit'), true);
  assertClean(record, 'read-only');
  await context.close();
}

// ---------- Scenario D: network failure keeps the same request id; single-use completes ----------
{
  let attempts = 0;
  const { page, context, record } = await openPage({ token: 'synthetic-single', rpc: async name => {
    if (name === 'patient_get_context') return json([{ ...baseContext, single_use: true, public_title: null, institution_name: null, ethics_approval_no: null, contact_display: null }]);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') {
      attempts += 1;
      if (attempts === 1) return 'abort';
      return json([{ visit_id: '21111111-2222-4333-8444-555555555555', server_time: '2025-06-14T01:05:00Z', receipt_token: null,
        receipt_expires_at: null, status: 'submitted', message: '已提交，无需重复录入' }]);
    }
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#studyTitle').textContent.includes('内部项目名'));
  assert.ok((await page.textContent('#studyInfo')).includes('请联系邀请您参加本研究的医生或研究护士'));
  await page.fill('#visitDate', '2025-06-14');
  await page.fill('#sbp', '120'); await page.fill('#dbp', '70'); await page.fill('#scr', '90'); await page.fill('#upcr', '0.3');
  await page.selectOption('#upcrUnit', 'gg');
  await page.click('#btnSubmit');
  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#btnSubmit').textContent.includes('重试提交') && !document.querySelector('#btnSubmit').disabled);
  const hint = await page.textContent('#submitHint');
  assert.ok(hint.includes('网络') && !/fetch|Error/i.test(hint), 'network hint: ' + hint);
  await page.click('#btnSubmit');
  await page.waitForSelector('#doneBox:not([hidden])');
  const submits = record.calls.filter(c => c.name === 'patient_submit_visit_v2');
  assert.equal(submits.length, 2);
  assert.equal(submits[0].body.p_request_id, submits[1].body.p_request_id, 'retry must reuse the request id');
  assert.equal(submits[0].body.p_upcr, 300);
  const done = await page.textContent('#doneBox');
  assert.ok(done.includes('没有重复保存') && done.includes('只能提交一次') && done.includes('2025-06-14 09:05'), done);
  assert.equal(await page.isVisible('#btnNextVisit'), false, 'single-use link must not offer fill again');
  const listCallsAfter = record.calls.slice(record.calls.indexOf(submits[1])).filter(c => c.name.startsWith('patient_list_'));
  assert.equal(listCallsAfter.length, 0, 'consumed single-use link requested history');
  assertClean(record, 'single-use');
  await context.close();
}

// ---------- Scenario E: structured same-day limit result is translated ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-limit', rpc: async name => {
    if (name === 'patient_get_context') return json([baseContext]);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') return json([{ visit_id: null, server_time: '2025-06-14T01:05:00Z', receipt_token: null,
      receipt_expires_at: null, status: 'same_day_limit_exceeded', message: 'x' }]);
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => !document.querySelector('#visitFields').disabled);
  await page.fill('#visitDate', '2025-06-14');
  await page.fill('#sbp', '120'); await page.fill('#dbp', '70'); await page.fill('#scr', '90'); await page.fill('#upcr', '300');
  await page.click('#btnSubmit');
  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#submitHint').textContent.includes('上限'));
  const hint = await page.textContent('#submitHint');
  assert.ok(hint.includes('研究护士 王老师') && !/same_day|limit/.test(hint), hint);
  assert.equal(await page.isDisabled('#btnSubmit'), true, 'link paused by server must lock the form');
  assertClean(record, 'same-day limit');
  await context.close();
}

await browser.close();
server.close();
console.log('PATIENT_UI_OK');
