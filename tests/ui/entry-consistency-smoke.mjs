// 录入一致性冒烟测试（合成数据，不连接任何数据库）：研究日期按北京时间、血压的各种输入方式结果一致。
// 运行：node tests/ui/entry-consistency-smoke.mjs   成功时打印 ENTRY_CONSISTENCY_UI_OK。
// 页面只加载本地 site/lib/ 模块，用假的依赖打开“录入随访”等对话框；剪贴板需要安全来源，所以用 https 的合成来源。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const ORIGIN = 'https://registry.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const BASELINE = '2020-01-01';
const PROBE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><script type="module">
import * as board from '/lib/followup-board.js';
import { createFollowupDialogs } from '/lib/followup-dialogs.js';
const record = { id: 'b1', patient_code: 'P001', consent_status: 'unconfirmed', consent_date: null, consent_version: null, followup_status: 'active', followup_status_date: null };
const query = { select(){return query;}, eq(){return query;}, order(){return query;}, limit(){return query;}, abortSignal(){return query;},
  maybeSingle(){ return Promise.resolve({ data: record, error: null }); }, then(r){ return Promise.resolve({ data: [], error: null }).then(r); } };
window.__rpc = [];
const sb = { from(){ return query; }, rpc: async (name, body) => { window.__rpc.push([name, body]); return { data: { inserted: 1, updated: 0, skipped: 0, total: 1 }, error: null }; } };
const deps = { sb, can: () => true, capture: () => ({ project: { id: 'p', name: '合成项目' } }), toast: t => { window.__toast = t; },
  getRow: code => ({ patient_code: code, baseline_date: '${BASELINE}' }), rowsLoaded: () => true, containsPII: () => false, isCurrent: () => true,
  assertCurrent: () => {}, errorMessage: e => String(e?.message || e), setBusy: () => {}, onSaved: () => {}, openHistory: () => {},
  canManageLinks: () => true, clearSelection: () => {}, getProject: () => ({ id: 'p' }), linkOrigin: () => '${ORIGIN}' };
window.__board = board;
window.__dialogs = createFollowupDialogs(deps);
window.__ready = true;
</script></body></html>`;

function chromiumExecutable() {
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* 使用本机已安装的版本 */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const found = (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => path.join(root, name, 'chrome-linux', 'chrome'))
    .find(file => fs.existsSync(file));
  if (!found) throw new Error('未找到已安装的 Chromium。请设置 PLAYWRIGHT_BROWSERS_PATH；本测试不会下载浏览器。');
  return found;
}

const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
let groups = 0;
const pass = label => { groups++; console.log(`PASS ${label}`); };

async function openProbe({ timezoneId = 'Asia/Shanghai', now = null } = {}) {
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const external = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === '/__probe.html') return route.fulfill({ status: 200, contentType: TYPES['.html'], body: PROBE });
    const file = path.normalize(path.join(SITE, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (now) await page.clock.setFixedTime(new Date(now));
  await page.goto(`${ORIGIN}/__probe.html`);
  await page.waitForFunction(() => window.__ready);
  return { context, page, errors, external };
}

const openVisit = async page => {
  await page.evaluate(() => { document.querySelectorAll('[data-registry-modal]').forEach(n => n.remove()); window.__rpc.length = 0; window.__dialogs.openVisitEntry('P001'); });
  await page.waitForSelector('#veSbp');
};
const fieldState = page => page.evaluate(() => {
  const q = s => document.querySelector(s);
  return { sbp: q('#veSbp')?.value ?? null, dbp: q('#veDbp')?.value ?? null, bpHint: q('#veBpHint')?.textContent ?? '', bpTone: q('#veBpHint')?.dataset.tone ?? '',
    missing: q('#veMissing')?.textContent ?? '', feedback: q('#veFeedback')?.textContent ?? '', rpc: window.__rpc.map(([n, b]) => [n, b?.p_rows]) };
});
const setDate = (page, selector, value) => page.evaluate(([s, v]) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, [selector, value]);

try {
  // ── 1. 纯函数：研究日期、血压解析、随访行 ───────────────────────────
  {
    const { context, page, errors } = await openProbe();
    const r = await page.evaluate(() => {
      const b = window.__board;
      const at = iso => b.researchToday(Date.parse(iso));
      const pairs = ['130/80', ' 130/80 ', '130 / 80', '１３０／８０', '130/80 mmHg', '130/80mmHg', '130/80​', ' 130/80　', '130\\80', '130∕80', '130⁄80', '180/110', '120.5/80.5',
        '130/8O', '130/', '/80', '1300/80', '130-80', 'abc', ''].map(t => [t, b.splitBloodPressure(t)]);
      const interp = [
        ['130/80', ''], ['130/80', '80'], ['130/80', '85'], ['', '130/80'], ['130/8O', ''], ['130', '80'], ['130/80', '130/80'],
      ].map(([s, d]) => [s, d, b.interpretBloodPressure(s, d)]);
      const row = (sbp, dbp) => b.buildVisitRow({ patientCode: 'P001', visitDate: '2026-10-01', sbp, dbp, scr: '', upcr: '', scrUnit: 'umol', upcrUnit: 'mgg', notes: '' }, { today: '2026-10-28' });
      return {
        dates: [at('2026-10-27T15:59:59Z'), at('2026-10-27T16:00:00Z'), at('2026-10-28T15:30:00Z'), at('2026-12-31T16:00:00Z')],
        message: b.futureDateMessage('随访日期', '2026-10-28'),
        pairs, interp,
        typedPair: row('130/80', ''), badPair: row('130/8O', ''), conflict: row('130/80', '85'), plain: row('130', '80'), lowPair: row('13/80', ''),
        future: b.buildVisitRow({ patientCode: 'P001', visitDate: '2026-10-29', sbp: '120', dbp: '80' }, { today: '2026-10-28' }).errors,
      };
    });
    assert.deepEqual(r.dates, ['2026-10-27', '2026-10-28', '2026-10-28', '2027-01-01'], '北京时间零点前后');
    assert.equal(r.message, '随访日期不能晚于今天（北京时间 2026-10-28）。研究日期统一按北京时间计算。');
    const pair = Object.fromEntries(r.pairs.map(([t, v]) => [t, v]));
    for (const t of ['130/80', ' 130/80 ', '130 / 80', '１３０／８０', '130/80 mmHg', '130/80mmHg', '130/80​', ' 130/80　', '130\\80', '130∕80', '130⁄80']) {
      assert.deepEqual(pair[t], { sbp: '130', dbp: '80' }, `“${t}”应识别为 130/80`);
    }
    assert.deepEqual(pair['180/110'], { sbp: '180', dbp: '110' });
    assert.deepEqual(pair['120.5/80.5'], { sbp: '120.5', dbp: '80.5' });
    for (const t of ['130/8O', '130/', '/80', '1300/80', '130-80', 'abc', '']) assert.equal(pair[t], null, `“${t}”不应识别为血压`);
    const interp = r.interp.map(([s, d, v]) => [s, d, v.split ? `${v.split.sbp}/${v.split.dbp}` : (v.error ? `error:${v.error.field}` : 'none')]);
    assert.deepEqual(interp, [
      ['130/80', '', '130/80'], ['130/80', '80', '130/80'], ['130/80', '85', 'error:sbp'], ['', '130/80', '130/80'],
      ['130/8O', '', 'error:sbp'], ['130', '80', 'none'], ['130/80', '130/80', '130/80'],
    ]);
    assert.deepEqual([r.typedPair.row.sbp, r.typedPair.row.dbp, r.typedPair.errors, r.typedPair.missing], [130, 80, [], ['血肌酐', '尿蛋白肌酐比']],
      '收缩压一栏的“130/80”在离焦之前也按两项计算，不提示缺舒张压');
    assert.equal(r.badPair.errors.length, 1);
    assert.match(r.badPair.errors[0].message, /^无法识别血压“130\/8O”。请按“收缩压\/舒张压”填写/);
    assert.ok(!r.badPair.missing.includes('舒张压') && !('sbp' in r.badPair.row), '无法识别时不保存、不提示缺舒张压');
    assert.match(r.conflict.errors[0].message, /两者不一致/);
    assert.deepEqual([r.plain.row.sbp, r.plain.row.dbp], [130, 80]);
    // 写法合法但数值超范围：按范围规则提示（与分两栏填写相同），不保存。
    assert.deepEqual(r.lowPair.errors.map(e => e.message), ['收缩压须在 40–300 mmHg 之间，请核对。', '舒张压须低于收缩压，请核对是否填反。']);
    assert.deepEqual(r.future.map(e => e.message), ['随访日期不能晚于今天（北京时间 2026-10-28）。研究日期统一按北京时间计算。']);
    assert.deepEqual(errors, []);
    await context.close();
    pass('研究日期按北京时间（零点前后）；血压写法识别（空格、全角、mmHg、零宽字符、三位舒张压）；非法与冲突写法给中文提示');
  }

  // ── 2. 不同时区、跨日时刻：默认日期、上限与提示一致 ───────────────────
  // 北京 10-28 00:30（洛杉矶仍是 10-27 上午）；北京 10-28 23:30（奥克兰已是 10-29 清晨）。
  for (const [now, expected] of [['2026-10-27T16:30:00Z', '2026-10-28'], ['2026-10-28T15:30:00Z', '2026-10-28']]) {
    for (const timezoneId of ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const { context, page, errors, external } = await openProbe({ timezoneId, now });
      await openVisit(page);
      const dateState = () => page.evaluate(() => { const n = document.querySelector('#veDate'); return { value: n.value, max: n.max, valid: n.checkValidity(), message: n.validationMessage, hint: document.querySelector('#veDateHint').textContent, tone: document.querySelector('#veDateHint').dataset.tone || '' }; });
      const initial = await dateState();
      assert.deepEqual([initial.value, initial.max, initial.valid], [expected, expected, true], `${timezoneId} @ ${now}：默认日期与上限应为北京时间的今天`);
      assert.equal(initial.hint, `研究日期按北京时间，今天是 ${expected}。`);
      await setDate(page, '#veDate', '2026-10-29');
      const future = await dateState();
      assert.equal(future.valid, false);
      assert.equal(future.message, `随访日期不能晚于今天（北京时间 ${expected}）。研究日期统一按北京时间计算。`, '浏览器校验提示为中文');
      assert.equal(future.hint, future.message);
      assert.equal(future.tone, 'error');
      await setDate(page, '#veDate', expected);
      assert.equal((await dateState()).valid, true, `${expected} 不是未来日期`);
      await page.fill('#veSbp', '128');
      await page.fill('#veDbp', '78');
      await page.click('#veSave');
      await page.waitForFunction(() => window.__rpc.length === 1);
      const saved = (await fieldState(page)).rpc[0];
      assert.deepEqual(saved, ['import_registry_rows', [{ patient_code: 'P001', visit_date: expected, sbp: 128, dbp: 78 }]]);
      // 其他对话框的日期上限同样按北京时间。
      await page.evaluate(codes => { window.__dialogs.openBulkStartDate(codes); }, ['P001']);
      await page.waitForSelector('#bsDate');
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#bsDate').value, document.querySelector('#bsDate').max]), [expected, expected]);
      await setDate(page, '#bsDate', '2026-10-29');
      assert.equal(await page.evaluate(() => document.querySelector('#bsDate').validationMessage), `提醒起算日不能晚于今天（北京时间 ${expected}）。研究日期统一按北京时间计算。`);
      await page.evaluate(() => document.querySelectorAll('[data-registry-modal]').forEach(n => n.remove()));
      await page.evaluate(() => window.__dialogs.openStudyStatus('P001'));
      await page.waitForSelector('#ssConsentDate');
      assert.equal(await page.evaluate(() => document.querySelector('#ssConsentDate').max), expected);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await context.close();
    }
  }
  pass('上海、洛杉矶、奥克兰在北京时间零点前后：默认日期、上限、未来日期提示一致，保存的是北京时间的研究日期');

  // ── 3. 血压：逐字键入、真实粘贴、输入法/剪贴板建议、自动化插入、离焦和保存结果一致 ─────
  {
    const { context, page, errors } = await openProbe({ now: '2026-10-28T04:00:00Z' });
    const methods = [
      ['逐字键入后按 Tab', async () => { await page.click('#veSbp'); await page.keyboard.type('130/80'); await page.keyboard.press('Tab'); }],
      ['逐字键入后直接点保存（不先离开）', null],
      ['Ctrl+V 粘贴 130/80', async () => { await page.evaluate(() => navigator.clipboard.writeText('130/80')); await page.click('#veSbp'); await page.keyboard.press('Control+V'); }],
      ['Ctrl+V 粘贴带前后空格', async () => { await page.evaluate(() => navigator.clipboard.writeText('  130/80 ')); await page.click('#veSbp'); await page.keyboard.press('Control+V'); }],
      ['Ctrl+V 粘贴全角', async () => { await page.evaluate(() => navigator.clipboard.writeText('１３０／８０')); await page.click('#veSbp'); await page.keyboard.press('Control+V'); }],
      ['Ctrl+V 粘贴带 mmHg', async () => { await page.evaluate(() => navigator.clipboard.writeText('130/80 mmHg')); await page.click('#veSbp'); await page.keyboard.press('Control+V'); }],
      ['Ctrl+V 粘贴到舒张压栏', async () => { await page.evaluate(() => navigator.clipboard.writeText('130/80')); await page.click('#veDbp'); await page.keyboard.press('Control+V'); }],
      ['输入法/剪贴板建议一次插入（insertText）', async () => { await page.click('#veSbp'); await page.keyboard.insertText('130/80'); }],
      ['execCommand 插入', async () => { await page.click('#veSbp'); await page.evaluate(() => document.execCommand('insertText', false, '130/80')); }],
    ];
    for (const [label, act] of methods) {
      await openVisit(page);
      if (act) {
        await act();
        const s = await fieldState(page);
        assert.deepEqual([s.sbp, s.dbp], ['130', '80'], `${label}：应拆为 130 和 80，实际 ${JSON.stringify(s)}`);
        assert.ok(!s.missing.includes('舒张压'), `${label}：不应提示缺舒张压`);
        assert.match(s.bpHint, /已拆分为收缩压 130 mmHg、舒张压 80 mmHg/);
      } else {
        await page.click('#veSbp');
        await page.keyboard.type('130/80');
        const before = await fieldState(page);
        assert.equal(before.sbp, '130/80', '逐字键入时不提前拆分');
        assert.ok(!before.missing.includes('舒张压'), '逐字键入完整的 130/80 时不提示缺舒张压');
        assert.match(before.bpHint, /识别为收缩压 130 mmHg、舒张压 80 mmHg/);
      }
      await page.click('#veSave');
      await page.waitForFunction(() => window.__rpc.length === 1);
      const saved = (await fieldState(page)).rpc[0][1][0];
      assert.deepEqual([saved.sbp, saved.dbp], [130, 80], `${label}：提交的血压应为 130/80，实际 ${JSON.stringify(saved)}`);
    }
    // 三位舒张压逐字键入：中途不能被拆成 130/10。
    await openVisit(page);
    await page.click('#veSbp');
    await page.keyboard.type('180/110');
    assert.equal((await fieldState(page)).sbp, '180/110');
    await page.keyboard.press('Tab');
    assert.deepEqual(await fieldState(page).then(s => [s.sbp, s.dbp]), ['180', '110']);
    // 非法写法：粘贴后保留原样、给中文提示、不提交。
    for (const bad of ['130/8O', '130//80', '130/']) {
      await openVisit(page);
      await page.evaluate(t => navigator.clipboard.writeText(t), bad);
      await page.click('#veSbp');
      await page.keyboard.press('Control+V');
      await page.keyboard.press('Tab');
      const s = await fieldState(page);
      assert.equal(s.sbp, bad, '非法写法不被静默改写');
      assert.equal(s.bpTone, 'error');
      assert.equal(s.bpHint, `无法识别血压“${bad}”。请按“收缩压/舒张压”填写，例如 130/80；也可以分别填写两栏。`);
      assert.equal(await page.evaluate(() => document.querySelector('#veSbp').classList.contains('fu-invalid')), true);
      await page.click('#veSave');
      assert.match((await fieldState(page)).feedback, /无法识别血压/);
      assert.equal((await fieldState(page)).rpc.length, 0, '非法写法不提交');
    }
    // 两栏冲突：收缩压栏写 130/80，舒张压栏又是 85。
    await openVisit(page);
    await page.fill('#veDbp', '85');
    await page.click('#veSbp');
    await page.keyboard.type('130/80');
    await page.keyboard.press('Tab');
    const conflict = await fieldState(page);
    assert.deepEqual([conflict.sbp, conflict.dbp, conflict.bpTone], ['130/80', '85', 'error'], '冲突时不覆盖已填的舒张压');
    assert.match(conflict.bpHint, /两者不一致/);
    assert.deepEqual(errors, []);
    await context.close();
    pass('血压：逐字键入、Ctrl+V（含空格/全角/mmHg、粘贴到舒张压栏）、输入法与剪贴板建议、自动化插入，拆分与提交结果一致；三位舒张压不提前拆分；非法与冲突写法不提交');
  }
  console.log(`ENTRY_CONSISTENCY_UI_OK ${groups} groups`);
} finally {
  await browser.close();
}
