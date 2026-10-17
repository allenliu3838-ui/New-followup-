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
const SUPABASE_URL = config.match(/SUPABASE_URL:\s*"([^"]+)"/)[1];
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
// 接口挂在站点路径下（如 /sb）时，去掉前缀后按 Supabase 原路径模拟
const SB_PREFIX = new URL(SUPABASE_URL).pathname.replace(/\/+$/, '');

// ---------- pure helpers ----------
// Loaded as source text so Node treats the browser module as ESM without a package.json type.
const wf = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(SITE, 'lib/patient-workflow.js'), 'utf8')));
const codes = ['token_invalid_or_expired', 'token_expired', 'token_revoked', 'single_use_token_already_used', 'token_invalid',
  'subscription_required', 'trial_expired', 'rate_limited', 'same_day_limit_exceeded', 'pii_detected_blocked', 'future_visit_date',
  'visit_before_baseline', 'idempotency_conflict', 'missing_core_fields', 'something_unexpected_xyz',
  'patient_exited', 'patient_not_eligible_for_links', 'invalid_values', 'new row for relation "visits_long" violates check constraint "visits_sbp_range"'];
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

// Hard limits must equal the visits_long CHECK constraints in the migrations.
{
  const sql = ['0002_clinical_constraints.sql', '0014_pr3_validators.sql']
    .map(name => fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8')).join('\n');
  const between = column => sql.match(new RegExp(`check\\s*\\(\\s*${column}\\s+is null or \\(\\s*${column}\\s+between\\s+(\\d+)\\s+and\\s+(\\d+)`, 'i')).slice(1).map(Number);
  assert.deepEqual(wf.DB_LIMITS.sbp, between('sbp'));
  assert.deepEqual(wf.DB_LIMITS.dbp, between('dbp'));
  assert.deepEqual(wf.DB_LIMITS.scr_umol, between('scr_umol_l'));
  assert.deepEqual(wf.DB_LIMITS.egfr, between('egfr'));
  assert.equal(wf.DB_LIMITS.upcr_mgg[1], Number(sql.match(/upcr\s*>=\s*0\s+AND\s+upcr\s*<=\s*(\d+)/i)[1]));
}
const visit = over => ({ visitDate: '2025-06-14', sbp: '120', dbp: '70', scr: '90', scrUnit: 'umol', upcr: '300', upcrUnit: 'mgg', notes: '', ...over });
const errorsOf = over => wf.validateVisit(visit(over)).errors;
assert.deepEqual(errorsOf({}), []);
assert.deepEqual(errorsOf({ sbp: '300', dbp: '20', scr: '10', upcr: '50', upcrUnit: 'gg' }), [], 'database bounds are inclusive');
for (const over of [{ sbp: '301' }, { sbp: '39', dbp: '30' }, { dbp: '201', sbp: '250' }, { dbp: '19' }, { scr: '5001' },
  { scr: '57', scrUnit: 'mgdl' }, { upcr: '50001' }, { upcr: '51', upcrUnit: 'gg' }]) {
  assert.equal(errorsOf(over).length, 1, 'out-of-range value not blocked: ' + JSON.stringify(over));
}
assert.match(errorsOf({ scr: '1.1' })[0].message, /数值看起来是 mg\/dL，请切换单位/);
assert.match(errorsOf({ scr: '98', scrUnit: 'mgdl' })[0].message, /数值看起来是 μmol\/L，请切换单位/);
assert.match(errorsOf({ upcr: '450', upcrUnit: 'gg' })[0].message, /数值看起来是 mg\/g，请切换单位/);
// Database refusals become "输入有误" (back to the form), never a network retry.
{
  const check = wf.classifyPatientError({ code: '23514', message: 'new row for relation "visits_long" violates check constraint "visits_scr_range"',
    details: 'Failing row contains (x, sbp token_expired)', hint: null });
  assert.equal(check.kind, 'input');
  assert.match(check.message, /^输入有误/);
  assert.deepEqual(check.fields, ['scr'], 'failing-row details (participant notes) must not be scanned');
  assert.deepEqual(wf.submissionOutcome({ status: 'invalid_values', invalid_fields: 'sbp, dbp', visit_id: null }).fields, ['sbp', 'dbp']);
  assert.deepEqual(wf.submissionOutcome({ status: 'invalid_values', invalid_fields: ['p_upcr', 'egfr'] }).fields, ['scr', 'upcr']);
  assert.deepEqual(wf.submissionOutcome({ status: 'invalid_values', fields: '{"scr_umol_l"}' }).fields, ['scr']);
  const generic = wf.submissionOutcome({ status: 'invalid_values', message: '数值超出范围' });
  assert.equal(generic.kind, 'input');
  assert.deepEqual(generic.fields, []);
  assert.match(generic.message, /^输入有误：有数值超出/);
  assert.equal(wf.classifyPatientError({ code: 'P0001', message: 'invalid_values', details: 'upcr' }).fields[0], 'upcr');
}
assert.equal(wf.submissionOutcome({ status: 'patient_exited' }).message, '您已退出本研究，无需再填写。如有疑问请联系研究团队。');
assert.equal(wf.classifyPatientError({ code: 'P0001', message: 'patient_not_eligible_for_links' }).kind, 'exited');
assert.equal(wf.contextErrorMessage({ message: 'patient_not_eligible_for_links' }).kind, 'exited');
assert.notEqual(wf.classifyPatientError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }).kind, 'duplicate');
assert.equal(wf.classifyPatientError({ message: 'AbortError: signal is aborted without reason' }).kind, 'network');
assert.equal(wf.beijingDateString(new Date('2026-10-12T16:30:00Z')), '2026-10-13');
assert.equal(wf.beijingDateString(new Date('2026-10-12T15:59:00Z')), '2026-10-12');
assert.equal(wf.dataLocationLead(undefined) + '隐私政策', '数据存储在中国境内（阿里云上海）的服务器，详见隐私政策');
assert.equal(wf.dataLocationLead({ DATA_LOCATION_NOTE: '数据存储于中国境内。' }), '数据存储于中国境内。详见');
// The link is read from the address once, then removed from it (kept in memory only).
assert.equal(wf.linkFromAddress({ hash: '#abc_DEF-1', pathname: '/followup' }), 'abc_DEF-1');
assert.equal(wf.linkFromAddress({ pathname: '/p/abc%2D1' }), 'abc-1');
assert.equal(wf.linkFromAddress({ pathname: '/patient.html', search: '?pt=xyz' }), 'xyz');
assert.equal(wf.linkFromAddress({ pathname: '/followup', hash: '#' }), null);
assert.equal(wf.addressWithoutLink('https://r.example/followup#secret-link'), '/followup');
assert.equal(wf.addressWithoutLink('https://r.example/p/secret-link'), '/followup');
assert.equal(wf.addressWithoutLink('https://r.example/patient.html?pt=secret-link&lang=zh#x'), '/patient.html?lang=zh');

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
// The narrowed patient_get_context contract: no project id, module, trial, subscription
// or write-block columns. The page must not need them.
const baseContext = {
  project_name: '内部项目名-不应显示', center_code: 'SH01',
  patient_code: 'IGAN-007', sex: 'M', birth_year: 1980,
  can_write: true, single_use: false, token_expires_at: '2026-12-31T08:00:00Z',
  public_title: 'IgA 肾病长期随访研究', institution_name: '示例大学附属医院肾内科',
  ethics_approval_no: '伦审2026-018号', contact_display: '研究护士 王老师',
};
// Older servers still return these columns; the page must ignore them.
const legacyColumns = {
  project_id: '00000000-0000-4000-8000-000000000001', module: 'igan',
  trial_expires_at: '2026-10-20T00:00:00Z', trial_grace_until: '2026-10-27T00:00:00Z', subscription_plan: 'trial',
  subscription_active_until: null, write_block_reason: null,
};
const visitRows = [{ visit_date: '2025-05-01', sbp: 130, dbp: 80, scr_umol_l: 98, upcr: 520, egfr: 78.2, notes: '' }];
const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const pgError = code => json({ code: '42501', message: code, details: null, hint: null }, 400);

async function openPage({ token, rpc, staticRoute, beforeGoto, entry = 'p', waitUntil = 'load' }) {
  const target = entry === 'followup' ? `${BASE}/followup#${token}` : entry === 'query' ? `${BASE}/patient.html?pt=${token}&lang=zh` : `${BASE}/p/${token}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await context.newPage();
  const record = { external: [], errors: [], calls: [], console: [], token };
  page.on('pageerror', error => record.errors.push(String(error)));
  page.on('console', message => record.console.push(message.text()));
  page.on('dialog', dialog => { record.errors.push('unexpected dialog: ' + dialog.message()); dialog.dismiss(); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.host !== `127.0.0.1:${server.address().port}` && url.host !== SUPABASE_HOST) record.external.push(request.url());
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1') {
      const action = staticRoute ? await staticRoute(url) : undefined;
      if (action === 'abort') return route.abort('failed');
      return route.continue();
    }
    if (url.host !== SUPABASE_HOST) return route.abort('blockedbyclient');
    if (SB_PREFIX && url.pathname.startsWith(SB_PREFIX + '/')) url.pathname = url.pathname.slice(SB_PREFIX.length);
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
  if (beforeGoto) await beforeGoto(page);
  await page.goto(target, { waitUntil });
  return { page, context, record };
}

const bodyText = page => page.evaluate(() => document.body.innerText);

// The link must not stay in the address bar or in the current history entry once the page has read it.
async function assertAddressClean(page, token, expectedPath, label) {
  const address = await page.evaluate(() => ({ href: location.href, hash: location.hash, state: JSON.stringify(history.state) }));
  assert.ok(!address.href.includes(token) && !String(address.state).includes(token), `${label}: link left in the address/history entry: ${address.href}`);
  assert.equal(address.hash, '', `${label}: fragment left in the address`);
  assert.equal(new URL(address.href).pathname + new URL(address.href).search, expectedPath, `${label}: address after removing the link`);
}
const FORBIDDEN = /试用|剩余\s*\d+\s*天|订阅|subscription|trial|token|Token|令牌|患者编号|后台/;

// Also: the link (bearer token) never lands in browser storage, cookies or the console.
async function assertClean(record, label, page) {
  assert.deepEqual(record.external, [], `${label}: external hosts requested`);
  assert.deepEqual(record.errors, [], `${label}: uncaught errors`);
  assert.ok(!record.console.some(line => line.includes(record.token)), `${label}: link printed to the console`);
  if (page) {
    const stored = await page.evaluate(() => {
      const dump = store => { try { return JSON.stringify(Object.entries(store)); } catch (_) { return ''; } };
      return [dump(window.localStorage), dump(window.sessionStorage), document.cookie].join('\n');
    });
    assert.ok(!stored.includes(record.token), `${label}: link written to browser storage`);
  }
}

// WCAG relative-luminance contrast between an element's text and its first opaque background.
async function contrastOf(page, selector) {
  const [fg, bg] = await page.evaluate(sel => {
    const node = document.querySelector(sel);
    let back = node; let color = 'rgba(0, 0, 0, 0)';
    while (back && /rgba\(0, 0, 0, 0\)|transparent/.test(color)) { color = getComputedStyle(back).backgroundColor; back = back.parentElement; }
    if (/rgba\(0, 0, 0, 0\)|transparent/.test(color)) color = getComputedStyle(document.documentElement).backgroundColor;
    return [getComputedStyle(node).color, color];
  }, selector);
  const lum = css => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
      .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

async function fillVisit(page, { date = '2025-06-14', sbp = '120', dbp = '70', scr = '90', upcr = '300', scrUnit = 'umol', upcrUnit = 'mgg' } = {}) {
  await page.fill('#visitDate', date);
  await page.fill('#sbp', sbp); await page.fill('#dbp', dbp); await page.fill('#scr', scr); await page.fill('#upcr', upcr);
  await page.selectOption('#scrUnit', scrUnit); await page.selectOption('#upcrUnit', upcrUnit);
}
const submits = record => record.calls.filter(c => c.name === 'patient_submit_visit_v2');

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
  await assertAddressClean(page, 'synthetic-multi-0001', '/followup', '/p/<link>');
  const info = await page.textContent('#studyInfo');
  for (const expected of ['示例大学附属医院肾内科（由研究团队提供）', '伦审2026-018号（由研究团队提供）', '研究护士 王老师', 'IGAN-007']) assert.ok(info.includes(expected), `study info missing ${expected}`);
  assert.equal(await page.getAttribute('meta[name="referrer"]', 'content'), 'no-referrer');
  await page.waitForSelector('#visitsBox table');
  let text = await bodyText(page);
  assert.ok(!FORBIDDEN.test(text), 'forbidden wording visible: ' + text.match(FORBIDDEN));
  assert.ok(!text.includes('内部项目名-不应显示'), 'internal project name shown although public_title exists');
  assert.ok((await page.textContent('footer')).includes('技术支持：肾域科研平台'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'horizontal scroll on a phone');
  const about = await page.textContent('#aboutStudy');
  for (const part of ['这是什么', '谁能看到这些数据', '不要填写的内容', '填错了怎么办', '可以退出吗']) assert.ok(about.includes(part), 'about section missing ' + part);
  // Who can see the data, stated as it is: the team, the technical platform, and anyone holding the link.
  const access = (await page.textContent('#dataAccess')).replace(/\s+/g, '');
  for (const part of ['研究团队的授权人员', '提供技术服务的平台', '持有本链接的人都可以看到本页显示的历史记录', '请不要转发链接',
    '数据存储在中国境内（阿里云上海）的服务器，详见隐私政策。']) assert.ok(access.includes(part), 'data access text missing ' + part);
  assert.ok(!/只有本研究团队/.test(about), 'overstated access claim is back');
  assert.equal(await page.getAttribute('#dataAccess a', 'href'), '/privacy');
  assert.equal(await page.textContent('#dataAccess a'), '隐私政策');
  assert.ok(await page.$('footer a[href="/privacy"]'), 'footer privacy link missing');
  for (const sel of ['footer > div', 'footer a[href="/privacy"]']) {
    const ratio = await contrastOf(page, sel);
    assert.ok(ratio >= 4.5, `${sel} contrast ${ratio.toFixed(2)} < 4.5`);
  }

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
  assert.equal(payload.p_token, 'synthetic-multi-0001', 'submission uses the link kept in memory');
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
  // The date just submitted now counts as "already on record" for the next entry.
  await fillVisit(page, { date: '2025-06-15' });
  await page.click('#btnSubmit');
  await page.waitForSelector('#reviewBox:not([hidden])');
  assert.equal(await page.isVisible('#dupBox'), true, 'same-day reminder missing right after submitting that date');
  await assertClean(record, 'multi-use', page);
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
  await assertClean(record, code, page);
  await context.close();
}

// ---------- Scenario C: project not accepting entries (read-only) ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-readonly', rpc: async name => {
    if (name === 'patient_get_context') return json([{ ...baseContext, ...legacyColumns, can_write: false, write_block_reason: 'subscription_required', trial_expires_at: '2026-01-01T00:00:00Z' }]);
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
  await assertClean(record, 'read-only', page);
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
  await assertClean(record, 'single-use', page);
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
  await assertClean(record, 'same-day limit', page);
  await context.close();
}

// ---------- Scenario F: hostile text in study info and every history field never runs ----------
{
  const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">"\'><svg/onload=window.__xss=99><a href="javascript:window.__xss=7">x</a>';
  const hostile = { ...baseContext, project_name: XSS, center_code: XSS, patient_code: XSS, public_title: XSS, institution_name: XSS,
    ethics_approval_no: XSS, contact_display: 'javascript:window.__xss=5 ' + XSS, token_expires_at: XSS };
  const rows = {
    patient_list_visits: [{ visit_date: XSS, sbp: XSS, dbp: XSS, scr_umol_l: XSS, upcr: XSS, egfr: XSS, notes: XSS }],
    patient_list_labs: [{ lab_date: XSS, lab_name: XSS, lab_value: XSS, lab_unit: XSS }],
    patient_list_meds: [{ drug_name: XSS, drug_class: XSS, dose: XSS, start_date: XSS, end_date: XSS }],
    patient_list_variants: [{ test_date: XSS, test_name: XSS, gene: XSS, variant: XSS, classification: XSS, zygosity: XSS }],
    patient_list_events: [{ event_type: XSS, event_date: XSS, source: XSS, notes: XSS }],
  };
  const { page, context, record } = await openPage({ token: 'synthetic-hostile', entry: 'followup', rpc: async name => {
    if (name === 'patient_get_context') return json([hostile]);
    if (rows[name]) return json(rows[name]);
    if (name === 'patient_submit_visit_v2') return pgError('token_revoked');
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForSelector('#visitsBox table');
  await assertAddressClean(page, 'synthetic-hostile', '/followup', '/followup#<link>');
  await page.click('#moreRecords summary');
  await page.waitForSelector('#eventsBox table');
  await page.waitForSelector('#variantsBox table');
  // A server rejection shows the hostile contact text through the hint, still as text.
  await fillVisit(page);
  await page.click('#btnSubmit');
  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#submitHint').textContent.includes('停用'));
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    xss: window.__xss || 0,
    injected: document.querySelectorAll('body img, body svg, body iframe, body object, body embed, main script').length,
    jsLinks: [...document.querySelectorAll('a')].filter(a => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length,
    title: document.querySelector('#studyTitle').textContent,
    info: document.querySelector('#studyInfo').textContent,
  }));
  assert.equal(state.xss, 0, 'injected script ran');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'long text widens the page on a phone');
  assert.equal(state.injected, 0, 'markup from data was parsed into elements');
  assert.equal(state.jsLinks, 0, 'javascript: link created from data');
  assert.equal(state.title, XSS, 'hostile title not shown as plain text');
  assert.ok(state.info.includes('<svg/onload='), 'hostile study info not shown as plain text');
  await assertClean(record, 'hostile text', page);
  await context.close();
}

// ---------- Scenario G: database refusals (23514 / invalid_values) -> "输入有误", back to the form ----------
{
  const replies = [
    pgError('new row for relation "visits_long" violates check constraint "visits_scr_range"'),
    json([{ visit_id: null, server_time: null, receipt_token: null, receipt_expires_at: null, status: 'invalid_values', message: 'x', invalid_fields: 'sbp,dbp' }]),
    json([{ visit_id: null, server_time: null, receipt_token: null, receipt_expires_at: null, status: 'invalid_values', message: 'x', invalid_fields: ['upcr'] }]),
    json([{ visit_id: null, server_time: null, receipt_token: null, receipt_expires_at: null, status: 'invalid_values', message: 'x' }]),
    json([{ visit_id: '31111111-2222-4333-8444-555555555555', server_time: '2025-06-14T01:05:00Z', receipt_token: null,
      receipt_expires_at: null, status: 'submitted', message: '提交成功' }]),
  ];
  replies[0] = { ...replies[0], body: JSON.stringify({ code: '23514', message: 'new row for relation "visits_long" violates check constraint "visits_scr_range"',
    details: 'Failing row contains (secret notes)', hint: null }) };
  const { page, context, record } = await openPage({ token: 'synthetic-check', rpc: async name => {
    if (name === 'patient_get_context') return json([{ ...baseContext, single_use: true }]);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') return replies[submits(record).length - 1];
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => !document.querySelector('#visitFields').disabled);
  await fillVisit(page);
  const expectations = [
    { focus: 'scr', parts: ['输入有误', '血清肌酐', '本次没有保存'] },
    { focus: 'sbp', parts: ['输入有误', '收缩压、舒张压'] },
    { focus: 'upcr', parts: ['输入有误', 'UPCR'] },
    { focus: 'sbp', parts: ['输入有误：有数值超出系统可接受的范围'] },
  ];
  for (const [index, expected] of expectations.entries()) {
    await page.click('#btnSubmit');
    await page.waitForSelector('#reviewBox:not([hidden])');
    await page.click('#btnSubmit');
    // Fields stay locked while reviewing and submitting; they unlock only once the refusal is handled.
    await page.waitForFunction(() => !document.querySelector('#visitFields').disabled);
    assert.equal(submits(record).length, index + 1);
    const view = await page.evaluate(() => ({ hint: document.querySelector('#submitHint').textContent, button: document.querySelector('#btnSubmit').textContent.trim(),
      disabled: document.querySelector('#btnSubmit').disabled, review: !document.querySelector('#reviewBox').hidden, focus: document.activeElement?.id,
      sbp: document.querySelector('#sbp').value }));
    for (const part of expected.parts) assert.ok(view.hint.includes(part), `refusal ${index}: ${view.hint}`);
    assert.ok(!/check|constraint|visits_|invalid|网络|重试/i.test(view.hint), `refusal ${index} shows raw or network text: ${view.hint}`);
    assert.equal(view.button, '核对并提交', `refusal ${index}: still in retry mode`);
    assert.equal(view.disabled, false, `refusal ${index}: form locked`);
    assert.equal(view.review, false);
    assert.equal(view.focus, expected.focus, `refusal ${index}: focus`);
    assert.equal(view.sbp, '120', 'entered values must stay for correction');
  }
  await page.fill('#sbp', '118');
  await page.click('#btnSubmit');
  await page.click('#btnSubmit');
  await page.waitForSelector('#doneBox:not([hidden])');
  const ids = submits(record).map(c => c.body.p_request_id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5, 'a refused payload must not be retried under the same request id');
  await assertClean(record, 'database refusal', page);
  await context.close();
}

// ---------- Scenario H: out-of-range values are stopped in the page, before any request ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-range', rpc: async name => {
    if (name === 'patient_get_context') return json([{ ...baseContext, birth_year: 2000 }]);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') return json([{ visit_id: '41111111-2222-4333-8444-555555555555', server_time: '2025-06-14T01:05:00Z',
      receipt_token: null, receipt_expires_at: null, status: 'submitted', message: '提交成功' }]);
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => !document.querySelector('#visitFields').disabled);
  const blocked = async (values, pattern, focus) => {
    await fillVisit(page, values);
    await page.click('#btnSubmit');
    await page.waitForFunction(() => document.querySelector('#submitHint').textContent.length > 0);
    assert.equal(await page.isVisible('#reviewBox'), false, 'review opened for an out-of-range value');
    const qc = await page.textContent('#qcBox');
    assert.match(qc, pattern);
    assert.match(await page.textContent('#submitHint'), pattern);
    assert.equal(await page.evaluate(() => document.activeElement?.id), focus);
  };
  // Creatinine typed as mg/dL while the unit is still μmol/L.
  await blocked({ scr: '1.1' }, /数值看起来是 mg\/dL，请切换单位/, 'scr');
  await blocked({ scr: '98', scrUnit: 'mgdl' }, /数值看起来是 μmol\/L，请切换单位/, 'scr');
  await blocked({ upcr: '450', upcrUnit: 'gg' }, /数值看起来是 mg\/g，请切换单位/, 'upcr');
  await blocked({ sbp: '350' }, /40–300 mmHg/, 'sbp');
  await blocked({ dbp: '15' }, /20–200 mmHg/, 'dbp');
  // Creatinine inside 10–5000 μmol/L but so low the database's eGFR (0–200) would refuse it.
  await blocked({ scr: '10' }, /eGFR/, 'scr');
  assert.equal(submits(record).length, 0, 'out-of-range values reached the server');
  await fillVisit(page, { scr: '1.1', scrUnit: 'mgdl' });
  await page.click('#btnSubmit');
  await page.waitForSelector('#reviewBox:not([hidden])');
  assert.ok((await page.textContent('#reviewBox')).includes('1.1 mg/dL（换算为 97.24 μmol/L）'));
  await page.click('#btnSubmit');
  await page.waitForSelector('#doneBox:not([hidden])');
  assert.equal(submits(record)[0].body.p_scr_umol_l, 97.24);
  await assertClean(record, 'range checks', page);
  await context.close();
}

// ---------- Scenario I: a date already on record asks before a second entry ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-sameday', rpc: async name => {
    if (name === 'patient_get_context') return json([baseContext]);
    if (name === 'patient_list_visits') return json(visitRows);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') return json([{ visit_id: '51111111-2222-4333-8444-555555555555', server_time: '2025-05-01T01:05:00Z',
      receipt_token: null, receipt_expires_at: null, status: 'submitted', message: '提交成功' }]);
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForSelector('#visitsBox table');
  await fillVisit(page, { date: '2025-05-02' });
  await page.click('#btnSubmit');
  await page.waitForSelector('#reviewBox:not([hidden])');
  assert.equal(await page.isVisible('#dupBox'), false, 'reminder shown for a new date');
  await page.click('#btnBack');
  await page.fill('#visitDate', visitRows[0].visit_date);
  await page.click('#btnSubmit');
  await page.waitForSelector('#reviewBox:not([hidden])');
  assert.equal(await page.isVisible('#dupBox'), true, 'no reminder for a date already on record');
  assert.ok((await page.textContent('#dupBox')).includes('这一天已经有一条随访记录，确定还要再提交一条吗？'));
  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#submitHint').textContent.includes('勾选'));
  assert.equal(submits(record).length, 0, 'submitted without confirming the second same-day entry');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'dupConfirm');
  await page.check('#dupConfirm');
  await page.click('#btnSubmit');
  await page.waitForSelector('#doneBox:not([hidden])');
  assert.equal(submits(record).length, 1);
  await assertClean(record, 'same-day reminder', page);
  await context.close();
}

// ---------- Scenario J: participant has left the study ----------
const EXITED = '您已退出本研究，无需再填写。如有疑问请联系研究团队。';
for (const [label, reply] of [
  ['status patient_exited', () => json([{ visit_id: null, server_time: null, receipt_token: null, receipt_expires_at: null, status: 'patient_exited', message: 'x' }])],
  ['error patient_not_eligible_for_links', () => pgError('patient_not_eligible_for_links')],
]) {
  const { page, context, record } = await openPage({ token: 'synthetic-exit-' + label.length, rpc: async name => {
    if (name === 'patient_get_context') return json([baseContext]);
    if (name.startsWith('patient_list_')) return json([]);
    if (name === 'patient_submit_visit_v2') return reply();
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => !document.querySelector('#visitFields').disabled);
  await fillVisit(page);
  await page.click('#btnSubmit');
  await page.click('#btnSubmit');
  await page.waitForFunction(() => document.querySelector('#formSection').hidden);
  const status = await page.textContent('#linkStatus');
  assert.ok(status.startsWith(EXITED), `${label}: ${status}`);
  assert.ok(!/patient|eligible|exited/.test(await bodyText(page)), `${label}: raw code visible`);
  assert.equal(await page.isVisible('#formSection'), false, `${label}: form still shown`);
  await assertClean(record, label, page);
  await context.close();
}
{
  const { page, context, record } = await openPage({ token: 'synthetic-exit-context', rpc: async name => {
    if (name === 'patient_get_context') return pgError('patient_not_eligible_for_links');
    throw new Error('history must not load after exit: ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#linkStatus').textContent.length > 0);
  assert.equal(await page.textContent('#linkStatus'), EXITED);
  assert.equal(await page.isVisible('#formSection'), false);
  assert.equal(await page.isVisible('#btnVerifyContext'), false, 'exit is not a retryable failure');
  await assertClean(record, 'exited at open', page);
  await context.close();
}

// ---------- Scenario K: page program fails to load -> message and reload, never an endless wait ----------
{
  let blockVendor = true;
  const { page, context, record } = await openPage({ token: 'synthetic-modfail', entry: 'followup',
    staticRoute: url => (blockVendor && url.pathname === '/lib/vendor/supabase.js' ? 'abort' : undefined),
    rpc: async name => {
      if (name === 'patient_get_context') return json([baseContext]);
      if (name.startsWith('patient_list_')) return json([]);
      throw new Error('unexpected rpc ' + name);
    } });
  await page.waitForSelector('#btnReload:not([hidden])', { timeout: 5000 });
  assert.equal(await page.textContent('#studyTitle'), '页面没有加载完整');
  assert.match(await page.textContent('#linkStatus'), /没有加载成功.*重新加载/);
  blockVendor = false;
  await page.click('#btnReload');
  await page.waitForFunction(() => document.querySelector('#studyTitle').textContent.includes('IgA'));
  assert.equal(await page.isVisible('#btnReload'), false);
  record.errors = record.errors.filter(e => !/supabase\.js|Failed to fetch dynamically imported module/.test(e));
  await assertClean(record, 'module failure', page);
  await context.close();
}
{
  // A stalled load (no error, no answer) gives up after 20 s instead of waiting forever.
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const { page, context, record } = await openPage({ token: 'synthetic-modhang', waitUntil: 'commit',
    beforeGoto: page => page.clock.install(),
    staticRoute: url => (url.pathname === '/patient.js' ? stalled : undefined),
    rpc: async () => json([]) });
  await page.waitForFunction(() => typeof window.__patientBootFailed === 'function');
  assert.equal(await page.textContent('#studyTitle'), '正在读取研究信息…');
  assert.equal(await page.isVisible('#btnReload'), false);
  await page.clock.runFor(21000);
  await page.waitForSelector('#btnReload:not([hidden])', { timeout: 2000 });
  assert.equal(await page.textContent('#studyTitle'), '页面没有加载完整');
  release('abort');
  await assertClean(record, 'module stall', page);
  await context.close();
}

// ---------- Scenario L: a stalled server call ends in a retry prompt, not an endless wait ----------
{
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const { page, context, record } = await openPage({ token: 'synthetic-rpc-hang',
    beforeGoto: page => page.clock.install(),
    rpc: async name => {
      if (name === 'patient_get_context') { await stalled; return json([baseContext]); }
      return json([]);
    } });
  await page.waitForFunction(() => window.__patientPageStarted === true);
  await page.clock.runFor(21000);
  await page.waitForFunction(() => document.querySelector('#linkStatus').textContent.includes('重新验证链接'), null, { timeout: 2000 });
  assert.equal(await page.isVisible('#btnVerifyContext'), true);
  await assertAddressClean(page, 'synthetic-rpc-hang', '/followup', 'stalled context');
  release();
  // The link is no longer in the address: re-verifying uses the copy kept in memory.
  await page.click('#btnVerifyContext');
  await page.waitForFunction(() => document.querySelector('#studyTitle').textContent.includes('IgA'), null, { timeout: 5000 });
  const contexts = record.calls.filter(c => c.name === 'patient_get_context');
  assert.ok(contexts.length >= 2 && contexts.every(c => c.body.p_token === 'synthetic-rpc-hang'), 're-verify must send the in-memory link');
  assert.equal(await page.isVisible('#formSection'), true, 'form available after re-verifying');
  await assertAddressClean(page, 'synthetic-rpc-hang', '/followup', 'after re-verify');
  await assertClean(record, 'stalled context', page);
  await context.close();
}

// ---------- Scenario M: ?pt= links, and another link opened in the same tab ----------
{
  const { page, context, record } = await openPage({ token: 'synthetic-query-0001', entry: 'query', rpc: async (name, body) => {
    if (name === 'patient_get_context') return json([{ ...baseContext, patient_code: body.p_token === 'synthetic-second-0002' ? 'IGAN-008' : 'IGAN-007' }]);
    if (name.startsWith('patient_list_')) return json([]);
    throw new Error('unexpected rpc ' + name);
  } });
  await page.waitForFunction(() => document.querySelector('#studyInfo').textContent.includes('IGAN-007'));
  await assertAddressClean(page, 'synthetic-query-0001', '/patient.html?lang=zh', '?pt=<link>');
  // A second link pasted into the same tab opens that link and is removed from the address too.
  await page.evaluate(() => { location.hash = '#synthetic-second-0002'; });
  await page.waitForFunction(() => document.querySelector('#studyInfo').textContent.includes('IGAN-008'));
  assert.deepEqual(record.calls.filter(c => c.name === 'patient_get_context').map(c => c.body.p_token), ['synthetic-query-0001', 'synthetic-second-0002']);
  await assertAddressClean(page, 'synthetic-second-0002', '/patient.html?lang=zh', 'second link');
  // A fragment that is not a link keeps the current link.
  await page.evaluate(() => { location.hash = '#'; });
  await page.waitForTimeout(200);
  assert.ok((await page.textContent('#studyInfo')).includes('IGAN-008'));
  assert.equal(record.calls.filter(c => c.name === 'patient_get_context').length, 2);
  record.token = 'synthetic-second-0002';
  await assertClean(record, 'second link', page);
  await context.close();
}

await browser.close();
server.close();
console.log('PATIENT_UI_OK');
