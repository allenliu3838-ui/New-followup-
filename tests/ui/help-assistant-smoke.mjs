// 使用问答（help-assistant）浏览器冒烟测试：只用本地 site/ 文件，不连接任何外部服务。
// 运行：node tests/ui/help-assistant-smoke.mjs   成功时打印 HELP_ASSISTANT_UI_OK。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';


const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const ORIGIN = 'http://registry.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const FAQ = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/help-faq.json'), 'utf8'));

// 问答库本身：编号唯一、字段齐全、链接指向存在的页面、不含身份信息示例。
{
  const ids = FAQ.items.map(it => it.id);
  assert.equal(new Set(ids).size, ids.length, '问答编号不得重复');
  assert.ok(FAQ.items.length >= 30, '问答至少 30 条');
  for (const it of FAQ.items) {
    assert.ok(it.q && it.a && Array.isArray(it.k) && it.k.length >= 3, `问答字段不全：${it.id}`);
    assert.match(it.link, /^\/[a-z0-9-]+\.html$/, `链接格式：${it.id}`);
    assert.ok(fs.existsSync(path.join(SITE, it.link)), `链接页面不存在：${it.link}`);
  }
}

const SELF_CHECK_SKIP = new Set();
const CASES = [
  ['单位怎么换算', 'units'],
  ['链接过期了怎么办', 'link-expired'],
  ['录错了怎么改', 'correct'],
  ['为什么有的患者没有进入分析', 'consent'],
  ['怎么批量确认知情同意', 'consent-bulk'],
  ['老患者导进来全是逾期', 'start-date'],
  ['导出的csv用excel打开', 'excel'],
  ['数据存在哪里', 'data-location'],
  ['怎么添加同事', 'members'],
  ['eGFR要自己算吗', 'egfr'],
  ['多中心怎么合并', 'multicenter'],
  ['忘记密码', 'verify-email'],
  ['多少钱', 'price'],
  ['胱抑素C', 'cystatin-egfr'],
  ['尿红细胞', 'urine-rbc'],
];

// 不下载浏览器：优先使用 Playwright 自带的，否则用 PLAYWRIGHT_BROWSERS_PATH 下已安装的 Chromium。
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
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN' });
  const external = [];
  const faqRequests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    // 页面原有的 kidneysphere.com 共享样式不属于问答助手，与公开页面测试一样放行为空内容。
    if (url.hostname === 'kidneysphere.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.origin !== ORIGIN) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === '/assets/help-faq.json') faqRequests.push(url.search);
    const file = path.normalize(path.join(SITE, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${ORIGIN}/guide.html`);

  const btn = page.locator('#ksHelpBtn');
  await btn.waitFor();
  assert.equal(await page.locator('#ksHelpPanel').isVisible(), false, '默认收起');
  assert.equal(faqRequests.length, 0, '打开前不加载问答库');
  await btn.click();
  await page.locator('#ksHelpResults .kh-chip').first().waitFor();
  assert.equal(faqRequests.length, 1);
  assert.match(faqRequests[0], /^\?v=registry-/, '问答库带版本号，避免缓存旧答案');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ksHelpInput', '打开后焦点在输入框');

  const ask = async query => {
    await page.fill('#ksHelpInput', query);
    await page.press('#ksHelpInput', 'Enter');
    await page.waitForFunction(() => document.querySelector('#ksHelpResults')?.childElementCount > 0);
    return page.locator('#ksHelpResults [data-help-id]').evaluateAll(list => list.map(x => x.dataset.helpId));
  };

  for (const [query, expected] of CASES) {
    const got = await ask(query);
    assert.equal(got[0], expected, `“${query}”应首先给出 ${expected}，实际 ${got.join(',')}`);
  }
  for (const it of FAQ.items) {
    if (SELF_CHECK_SKIP.has(it.id)) continue;
    const got = await ask(it.q);
    assert.ok(got.slice(0, 3).includes(it.id), `用原问题“${it.q}”应能找到 ${it.id}，实际 ${got.join(',')}`);
  }

  // 找不到答案时给出联系方式；输入的 HTML 不被解析。
  const none = await ask('<img src=x onerror="window.__helpXss=1">量子纠缠');
  assert.deepEqual(none, []);
  assert.ok((await page.locator('#ksHelpResults').textContent()).includes('china@kidneysphere.com'));
  assert.equal(await page.evaluate(() => window.__helpXss), undefined);
  assert.equal(await page.locator('#ksHelpPanel img').count(), 0);

  // 答案中的链接只指向本站页面。
  await ask('单位怎么换算');
  assert.equal(await page.locator('#ksHelpResults a.kh-more').first().getAttribute('href'), '/guide.html');

  // Esc 关闭，焦点回到按钮。
  await page.press('#ksHelpInput', 'Escape');
  assert.equal(await page.locator('#ksHelpPanel').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ksHelpBtn');

  // 手机宽度：展开后页面不横向滚动，面板在可视区域内。
  await page.setViewportSize({ width: 390, height: 844 });
  await btn.click();
  const box = await page.locator('#ksHelpPanel').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, `面板超出屏幕：${JSON.stringify(box)}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `手机宽度下不应横向滚动（${overflow}px）`);

  // 其他引入页面同样可用。
  for (const entry of ['/user-manual-cn.html']) {
    const p2 = await context.newPage();
    p2.on('pageerror', e => errors.push(`${entry}: ${e.message}`));
    await p2.goto(`${ORIGIN}${entry}`);
    await p2.locator('#ksHelpBtn').click();
    await p2.locator('#ksHelpResults .kh-chip').first().waitFor();
    await p2.close();
  }

  assert.deepEqual(external, [], '不得请求外部主机');
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
console.log('HELP_ASSISTANT_UI_OK');
