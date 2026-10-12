// 公开页面冒烟测试（公开页面单元 B：使用说明、详细手册、系统介绍、登录、注册、登录回调）。
// 运行：PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/ui/public-b-smoke.mjs
//
// 浏览器的每个请求都被拦截：本站文件从本地 site/ 读取；认证与数据接口（config.js 中的
// SUPABASE_URL）由本脚本返回合成响应；kidneysphere.com 共享顶栏返回空内容；其他主机一律
// 记为违规并中止。不联网、不创建任何真实账号。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const { chromium } = await import('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const ORIGIN = 'http://localhost';
const CONFIG_TEXT = fs.readFileSync(path.join(SITE, 'config.js'), 'utf8');
const SUPABASE_URL = (CONFIG_TEXT.match(/SUPABASE_URL\s*:\s*"([^"]+)"/) || [])[1];
if (!SUPABASE_URL) throw new Error('config.js 中没有 SUPABASE_URL');
const SUPABASE_HOST = new URL(SUPABASE_URL).hostname;
const ALLOWED_EXTERNAL = new Set(['kidneysphere.com']);
const BANNED = ['NEJM', '顶刊', '科研小白', '零风险', '无隐私风险', '宽限', 'Token', 'token', '令牌', 'PII', '后台', 'Issue', '一键'];
const ENGLISH_ERRORS = ['Invalid login credentials', 'User already registered', 'Email link is invalid', 'Failed to fetch', 'Email not confirmed', 'rate limit', 'Signups not allowed'];
const TRIAL_TEXT = '30 天免费试用 · 含 1 个项目 · 注册无需付款信息 · 到期后转为只读，已录数据可继续查看和导出';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

function resolveSiteFile(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  for (const candidate of [rel, `${rel}.html`]) {
    const abs = path.normalize(path.join(SITE, candidate));
    if (!abs.startsWith(SITE + path.sep)) return null;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
// Fulfil and report the request as handled.
const reply = async (route, status, body) => { await json(route, status, body); return true; };

function fakeJwt(sub, email) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })}.c2lnbmF0dXJl`;
}

function fakeUser(email, identities = true) {
  const id = '11111111-2222-4333-8444-555555555555';
  return {
    id, aud: 'authenticated', role: 'authenticated', email, created_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
    identities: identities ? [{ id, user_id: id, identity_id: id, provider: 'email', identity_data: { email, sub: id } }] : [],
  };
}

// auth(route, req, url) handles every request to the auth/data host; return true when handled.
async function openPage(browser, urlPath, { auth } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const external = [];
  const supabaseCalls = [];
  const errors = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Deliberately aborted requests (network-failure scenario) are expected resource errors.
    if (/Failed to load resource/.test(text)) return;
    if (/global\.(error|unhandledrejection)/.test(text)) errors.push(`uncaught: ${text}`);
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === ORIGIN) {
      const file = resolveSiteFile(url.pathname);
      if (!file) return route.fulfill({ status: 404, contentType: TYPES['.html'], body: fs.readFileSync(path.join(SITE, '404.html')) });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    if (url.hostname === SUPABASE_HOST) {
      let body = null;
      try { body = req.postDataJSON(); } catch (_) { body = req.postData(); }
      supabaseCalls.push({ method: req.method(), path: url.pathname, search: url.search, body });
      if (auth && await auth(route, req, url, body)) return;
      return json(route, 404, { message: 'not mocked' });
    }
    if (ALLOWED_EXTERNAL.has(url.hostname)) {
      return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.css') ? TYPES['.css'] : TYPES['.js'], body: '' });
    }
    external.push(req.url());
    return route.abort('blockedbyclient');
  });
  await page.goto(`${ORIGIN}${urlPath}`, { waitUntil: 'load' });
  await page.waitForTimeout(250);
  return { context, page, external, supabaseCalls, errors };
}

function commonChecks(name, r) {
  check(r.errors.length === 0, `${name}: 未捕获异常 ${JSON.stringify(r.errors)}`);
  check(r.external.length === 0, `${name}: 请求了不允许的外部主机 ${JSON.stringify(r.external)}`);
}

async function visibleText(page) {
  return page.evaluate(() => document.body.innerText + '\n' + document.title + '\n' +
    Array.from(document.querySelectorAll('meta[name=description],meta[property^="og:"]')).map(m => m.content).join('\n'));
}

async function bannedWords(name, page, extra = []) {
  const text = await visibleText(page);
  for (const w of [...BANNED, ...extra]) check(!text.includes(w), `${name}: 可见文字含禁用措辞「${w}」`);
  for (const w of ENGLISH_ERRORS) check(!text.includes(w), `${name}: 可见文字含英文错误原文「${w}」`);
}

async function anchorsResolve(name, page) {
  const missing = await page.evaluate(() => Array.from(document.querySelectorAll('a[href^="#"]'))
    .map(a => a.getAttribute('href').slice(1)).filter(id => id && !document.getElementById(decodeURIComponent(id))));
  check(missing.length === 0, `${name}: 页内锚点没有对应 id ${JSON.stringify(missing)}`);
}

async function abbreviationsExplained(name, page, list) {
  const text = await page.evaluate(() => document.querySelector('main').textContent.replace(/\s+/g, ' '));
  for (const abbr of list) {
    const idx = text.indexOf(abbr);
    check(idx >= 0, `${name}: 没有出现缩写 ${abbr}`);
    if (idx < 0) continue;
    const before = text.slice(idx - 1, idx), after = text.slice(idx + abbr.length, idx + abbr.length + 1);
    check((before === '（' && after === '）') || after === '（', `${name}: 缩写 ${abbr} 首次出现时没有中文解释：…${text.slice(Math.max(0, idx - 12), idx + abbr.length + 12)}…`);
  }
}

async function hintText(page, selector) {
  return (await page.locator(selector).innerText()).trim();
}

async function fillSignup(page, email) {
  await page.locator('#btnRegister:not([disabled])').waitFor({ timeout: 10000 });
  await page.fill('#email', email);
  await page.fill('#password', 'Aa1!aaaa');
  await page.fill('#confirmPwd', 'Aa1!aaaa');
  await page.check('#agreeTerms');
}

const signupCalls = (r) => r.supabaseCalls.filter(c => c.path === '/auth/v1/signup');

// The installed Chromium may carry a different build number than the playwright package
// expects; never download, fall back to the browser already present in PLAYWRIGHT_BROWSERS_PATH.
const LAUNCH_ARGS = ['--disable-background-networking', '--disable-component-update', '--no-pings'];
async function launchBrowser() {
  try {
    return await chromium.launch({ args: LAUNCH_ARGS });
  } catch (err) {
    if (!/Executable doesn't exist/.test(String(err && err.message))) throw err;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const candidates = [process.env.CHROMIUM_PATH];
    for (const d of fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : []) {
      if (/^chromium-\d+$/.test(d)) candidates.push(path.join(base, d, 'chrome-linux', 'chrome'));
    }
    const exe = candidates.find(c => c && fs.existsSync(c));
    if (!exe) throw err;
    return chromium.launch({ executablePath: exe, args: LAUNCH_ARGS });
  }
}

const browser = await launchBrowser();
try {
  // ── /guide ──────────────────────────────────────────────────────────────
  {
    const r = await openPage(browser, '/guide');
    commonChecks('guide', r);
    const quick = r.page.locator('#quickstart');
    check(await quick.isVisible(), 'guide: 快速上手标题不可见');
    const box = await quick.boundingBox();
    check(box && box.y + box.height <= 800, `guide: 快速上手不在首屏 (y=${box && box.y})`);
    check((await quick.innerText()).includes('快速上手'), 'guide: #quickstart 不是快速上手');
    check(await r.page.locator('ol.quickstart > li').count() === 7, 'guide: 快速上手不是 7 步');
    const steps = await r.page.locator('ol.quickstart > li .qs-title').allInnerTexts();
    check(JSON.stringify(steps) === JSON.stringify(['注册', '建项目', '录第一例', '生成随访链接', '录随访', '看数据质控问题', '导出']), `guide: 步骤名称 ${steps}`);
    const quickText = await r.page.locator('ol.quickstart').innerText();
    for (const label of ['创建项目', '核对并保存基线', '随访链接', '生成新链接', '录入随访', '查看未解决的问题', '核对原记录', '冻结并导出完整分析包']) {
      check(quickText.includes(label), `guide: 快速上手缺少工作台按钮文字「${label}」`);
    }
    check((await r.page.locator('main').innerText()).includes('随访看板'), 'guide: 未说明随访看板');
    check(await r.page.locator('details#advanced').getAttribute('open') === null, 'guide: 进阶区默认应折叠');
    const advancedText = await r.page.locator('details#advanced').textContent();
    for (const w of ['Python', 'LOINC', 'Part 11', 'SDTM', '--protocol']) check(advancedText.includes(w), `guide: 进阶区缺少 ${w}`);
    const beforeAdvanced = await r.page.evaluate(() => {
      const main = document.querySelector('main').cloneNode(true);
      main.querySelector('#advanced')?.remove();
      return main.textContent;
    });
    for (const w of ['Anaconda', 'LOINC', 'Part 11', 'SDTM', 'pip install']) check(!beforeAdvanced.includes(w), `guide: 「${w}」应只出现在进阶区`);
    check(!/candidates_egfr_decline|candidates_igan_proteinuria/.test(await r.page.content()), 'guide: 仍引用旧的候选文件名');
    await anchorsResolve('guide', r.page);
    await bannedWords('guide', r.page, ['patient_code', 'Banff 排斥分级']);
    await abbreviationsExplained('guide', r.page, ['PI', 'CRC', 'Scr', 'UPCR', 'eGFR', 'MEST-C', 'DCC']);
    const trial = await r.page.evaluate(() => ({
      text: document.querySelector('[data-pricing="trialSummary"]')?.textContent.trim(),
      expected: window.PricingConfig && typeof window.PricingConfig.trialSummary === 'function' ? window.PricingConfig.trialSummary() : null,
    }));
    check(trial.text === (trial.expected || TRIAL_TEXT), `guide: 试用规则文字不一致 ${trial.text}`);
    // A link into the collapsed fold opens it.
    await r.page.click('a[href="#advanced"]');
    check(await r.page.locator('details#advanced').getAttribute('open') !== null, 'guide: 点击“进阶”链接后折叠区未展开');
    await r.context.close();

    const deep = await openPage(browser, '/guide#advanced-protocol');
    check(await deep.page.locator('#advanced-protocol').isVisible(), 'guide: 直接打开 #advanced-protocol 时目标不可见');
    commonChecks('guide#advanced-protocol', deep);
    await deep.context.close();
  }

  // ── /user-manual-cn ─────────────────────────────────────────────────────
  {
    const r = await openPage(browser, '/user-manual-cn');
    commonChecks('manual', r);
    await anchorsResolve('manual', r.page);
    await bannedWords('manual', r.page);
    await abbreviationsExplained('manual', r.page, ['PI', 'CRC', 'Scr', 'UPCR', 'eGFR', 'MEST-C', 'DCC', 'KFRE']);
    const toc = await r.page.evaluate(() => Array.from(document.querySelectorAll('nav.toc a')).map(a => {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      return { label: a.textContent.trim(), heading: target ? target.textContent.trim() : null, tag: target?.tagName };
    }));
    toc.forEach((item, i) => {
      check(item.tag === 'H2', `manual: 目录项 ${item.label} 没有指向二级标题`);
      check(item.label.startsWith(`${i + 1} `), `manual: 目录序号错误 ${item.label}`);
      check(item.heading && item.heading.startsWith(`${i + 1}. `), `manual: 目录 ${item.label} 与标题 ${item.heading} 序号不一致`);
    });
    const h2 = await r.page.locator('main h2').allInnerTexts();
    h2.forEach((text, i) => check(text.startsWith(`${i + 1}. `), `manual: 二级标题序号不连续 ${text}`));
    for (const id of ['faq-storage', 'faq-visibility', 'faq-multicenter', 'faq-formats', 'faq-phone', 'faq-link-expired', 'faq-correct', 'faq-delete', 'faq-retention', 'recovery']) {
      check(await r.page.locator(`#${id}`).count() === 1, `manual: 缺少常见问题 #${id}`);
    }
    const faqTitles = await r.page.locator('#faq ~ h3').allInnerTexts();
    check(faqTitles.every(t => !/[a-z]+_[a-z_]+/.test(t)), `manual: 常见问题标题含错误码 ${faqTitles}`);
    const html = await r.page.content();
    check(!/candidates_egfr_decline\.csv|candidates_igan_proteinuria\.csv/.test(html), 'manual: 仍引用旧的候选文件名');
    for (const f of ['candidates_unconfirmed_egfr_decline.csv', 'endpoints_per_protocol.csv', 'timepoints_per_protocol.csv', 'protocol_template.json']) check(html.includes(f), `manual: 缺少 ${f}`);
    check(!/直接把这个链接发给用户|作者|TODO/.test(await visibleText(r.page)), 'manual: 含作者笔记或内部说明');
    await r.context.close();

    // Every cross-page anchor from the guide resolves in the manual.
    const g = await openPage(browser, '/guide');
    const targets = await g.page.evaluate(() => Array.from(document.querySelectorAll('a[href^="/user-manual-cn#"]')).map(a => a.getAttribute('href').split('#')[1]));
    await g.context.close();
    const m = await openPage(browser, '/user-manual-cn');
    for (const id of new Set(targets)) check(await m.page.locator(`[id="${id}"]`).count() === 1, `guide → manual 锚点 #${id} 不存在`);
    const back = await m.page.evaluate(() => Array.from(document.querySelectorAll('a[href^="/guide#"]')).map(a => a.getAttribute('href').split('#')[1]));
    await m.context.close();
    const g2 = await openPage(browser, '/guide');
    for (const id of new Set(back)) check(await g2.page.locator(`[id="${id}"]`).count() === 1, `manual → guide 锚点 #${id} 不存在`);
    await g2.context.close();
  }

  // ── /slides ─────────────────────────────────────────────────────────────
  {
    const r = await openPage(browser, '/slides');
    commonChecks('slides', r);
    await anchorsResolve('slides', r.page);
    const all = await r.page.evaluate(() => document.querySelector('#deck').textContent);
    for (const w of [...BANNED, 'patient_code', '数据存储在中国区域', '7 天', '核心功能试用', 'kidneysphere.ai']) check(!all.includes(w), `slides: 含不当措辞「${w}」`);
    check(all.includes('随访看板') && all.includes('录入随访') && all.includes('冻结数据版本'), 'slides: 未使用统一术语');
    check(all.includes('数据协调中心（DCC）'), 'slides: DCC 首次出现未注明中文');
    const trial = await r.page.locator('[data-pricing="trialSummary"]').first().textContent();
    const expected = await r.page.evaluate(() => window.PricingConfig?.trialSummary ? window.PricingConfig.trialSummary() : null);
    check(trial.trim() === (expected || TRIAL_TEXT), `slides: 试用规则文字不一致 ${trial}`);
    check((await r.page.locator('#counter').innerText()).trim() === '1 / 13', 'slides: 页码初始值错误');
    await r.page.click('#btnNext');
    check((await r.page.locator('#counter').innerText()).trim() === '2 / 13', 'slides: 翻页失败');
    await r.context.close();
  }

  // ── /signup：需要邮箱确认（双击只发一次请求，同一邮箱再提交不再请求）──
  {
    const r = await openPage(browser, '/signup', {
      auth: async (route, req, url, body) => {
        if (url.pathname === '/auth/v1/signup') {
          await new Promise(res => setTimeout(res, 300));
          return reply(route, 200, fakeUser(body.email, true));
        }
        return false;
      },
    });
    const signupTrial = await r.page.evaluate(() => ({
      text: document.querySelector('[data-pricing="trialSummary"]')?.textContent.trim(),
      expected: window.PricingConfig && typeof window.PricingConfig.trialSummary === 'function' ? window.PricingConfig.trialSummary() : null,
    }));
    check(signupTrial.text === (signupTrial.expected || TRIAL_TEXT), `signup: 试用规则文字不一致 ${signupTrial.text}`);
    const rules = await r.page.locator('#passwordRules').innerText();
    check(['8 位', '大写字母', '小写字母', '数字', '特殊字符'].every(w => rules.includes(w)), `signup: 密码规则提示不完整 ${rules}`);
    await fillSignup(r.page, 'confirm@example.org');
    await r.page.locator('#btnRegister').click();
    // While the request is pending: the button shows progress and further submits are ignored.
    const pending = await r.page.evaluate(() => {
      const form = document.querySelector('#registerForm');
      form.requestSubmit();
      form.requestSubmit();
      const button = document.querySelector('#btnRegister');
      return { label: button.textContent, disabled: button.disabled, busy: form.getAttribute('aria-busy') };
    });
    check(pending.label.includes('正在注册') && pending.disabled && pending.busy === 'true', `signup: 提交中没有显示请求中状态 ${JSON.stringify(pending)}`);
    await r.page.waitForFunction(() => /确认邮件已发往/.test(document.querySelector('#registerHint').innerText), null, { timeout: 10000 });
    const hint = await hintText(r.page, '#registerHint');
    check(hint.includes('需要验证邮箱') && hint.includes('confirm@example.org'), `signup(确认): 提示错误 ${hint}`);
    check(await r.page.locator('#btnResendConfirm').count() === 1, 'signup(确认): 缺少重新发送确认邮件');
    await r.page.fill('#password', 'Aa1!aaaa');
    await r.page.fill('#confirmPwd', 'Aa1!aaaa');
    await r.page.locator('#btnRegister').click();
    await r.page.waitForTimeout(300);
    check(signupCalls(r).length === 1, `signup(确认): 注册请求发出 ${signupCalls(r).length} 次`);
    const call = signupCalls(r)[0];
    check(call && /auth-callback/.test(decodeURIComponent(call.search)) && /returnTo=\/signup/.test(decodeURIComponent(call.search)), `signup: 确认邮件回跳地址错误 ${call && call.search}`);
    check(await r.page.locator('#registerHint').isVisible(), 'signup(确认): 提示没有持续显示');
    await bannedWords('signup(确认)', r.page);
    commonChecks('signup(确认)', r);
    await r.context.close();
  }

  // ── /signup：邮箱已注册（两种返回形式）──
  for (const variant of ['placeholder', 'error']) {
    const r = await openPage(browser, '/signup', {
      auth: async (route, req, url, body) => {
        if (url.pathname !== '/auth/v1/signup') return false;
        if (variant === 'placeholder') return reply(route, 200, fakeUser(body.email, false));
        return reply(route, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      },
    });
    await fillSignup(r.page, 'exists@example.org');
    await r.page.locator('#btnRegister').dblclick();
    await r.page.waitForFunction(() => /该邮箱已注册/.test(document.querySelector('#registerHint').innerText), null, { timeout: 10000 });
    check(await r.page.locator('#registerHint a[href="/login"]').count() === 1, `signup(已注册/${variant}): 没有登录链接`);
    check(await r.page.locator('#registerHint a[href^="/login?mode=reset"]').count() === 1, `signup(已注册/${variant}): 没有忘记密码入口`);
    await r.page.fill('#password', 'Aa1!aaaa');
    await r.page.fill('#confirmPwd', 'Aa1!aaaa');
    await r.page.locator('#btnRegister').click();
    await r.page.waitForTimeout(300);
    check(signupCalls(r).length === 1, `signup(已注册/${variant}): 注册请求发出 ${signupCalls(r).length} 次`);
    await bannedWords(`signup(已注册/${variant})`, r.page);
    commonChecks(`signup(已注册/${variant})`, r);
    await r.context.close();
  }

  // ── /signup：网络失败 → 结果不确定，阻止重复提交 ──
  {
    const r = await openPage(browser, '/signup', {
      auth: async (route, req, url) => {
        if (url.pathname !== '/auth/v1/signup') return false;
        await route.abort('failed');
        return true;
      },
    });
    await fillSignup(r.page, 'offline@example.org');
    await r.page.locator('#btnRegister').click();
    await r.page.waitForFunction(() => /暂时无法确认注册是否成功/.test(document.querySelector('#registerHint').innerText), null, { timeout: 15000 });
    check(await r.page.locator('#btnRegister').isDisabled(), 'signup(网络失败): 注册按钮应停用');
    check((await r.page.locator('#btnRegister').innerText()).includes('请先核对注册结果'), 'signup(网络失败): 按钮文字错误');
    await r.page.locator('#registerForm').evaluate(form => form.requestSubmit());
    await r.page.waitForTimeout(300);
    check(signupCalls(r).length === 1, `signup(网络失败): 注册请求发出 ${signupCalls(r).length} 次`);
    await bannedWords('signup(网络失败)', r.page);
    commonChecks('signup(网络失败)', r);
    await r.context.close();
  }

  // ── /signup：已登录 → 引导在模板插入后绑定，接口与工作台一致 ──
  {
    const rpcCalls = [];
    const r = await openPage(browser, '/signup', {
      auth: async (route, req, url, body) => {
        if (url.pathname === '/auth/v1/signup') {
          const user = fakeUser(body.email, true);
          return reply(route, 200, { access_token: fakeJwt(user.id, body.email), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-fake', user });
        }
        if (url.pathname.startsWith('/rest/v1/rpc/')) {
          const name = url.pathname.split('/').pop();
          rpcCalls.push({ name, body });
          if (name === 'create_project') return reply(route, 200, '99999999-8888-4777-8666-555555555555');
          { await route.fulfill({ status: 204, body: '' }); return true; }
        }
        if (url.pathname === '/rest/v1/patients_baseline') { await route.fulfill({ status: 201, body: '' }); return true; }
        return false;
      },
    });
    await fillSignup(r.page, 'session@example.org');
    await r.page.locator('#btnRegister').click();
    await r.page.locator('#onboardingCard #obStep1').waitFor({ state: 'visible', timeout: 10000 });
    check(await r.page.locator('#onboardingConsent').isChecked(), 'signup(已登录): 引导页未继承协议勾选');
    await r.page.click('#btnObSkip1');
    await r.page.locator('#obStep2.active').waitFor({ timeout: 5000 });
    await r.page.fill('#obProjName', '模拟项目');
    await r.page.fill('#obProjCenter', 'TEST01');
    await r.page.click('#btnObStep2');
    await r.page.locator('#obStep3.active').waitFor({ timeout: 5000 });
    await r.page.fill('#obPatCode', 'DEMO001');
    await r.page.click('#btnObStep3');
    await r.page.locator('#obDone.active').waitFor({ timeout: 5000 });
    const names = rpcCalls.map(c => c.name);
    check(names.filter(n => n === 'log_consent').length === 1, `signup(已登录): 协议记录调用 ${names}`);
    check(rpcCalls.find(c => c.name === 'log_consent')?.body?.p_policy_version === 'v2.0', 'signup(已登录): 协议版本应为 v2.0');
    check(names.includes('create_project'), 'signup(已登录): 未调用与工作台一致的 create_project');
    check(r.supabaseCalls.some(c => c.path === '/rest/v1/patients_baseline' && c.method === 'POST'), 'signup(已登录): 未写入第一例基线');
    commonChecks('signup(已登录)', r);
    await r.context.close();
  }

  // ── /login：英文错误翻译、忘记密码入口、限流等待时间、邮箱登录链接模式 ──
  {
    const r = await openPage(browser, '/login', {
      auth: async (route, req, url) => {
        if (url.pathname === '/auth/v1/token') return reply(route, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return false;
      },
    });
    await r.page.locator('#btnLogin:not([disabled])').waitFor({ timeout: 10000 });
    await r.page.fill('#email', 'user@example.org');
    await r.page.fill('#password', 'wrong-password');
    await r.page.click('#btnLogin');
    await r.page.waitForFunction(() => /邮箱或密码不正确/.test(document.querySelector('#loginHint').innerText), null, { timeout: 10000 });
    check(await r.page.locator('#loginHint #hintForgot').count() === 1, 'login: 密码错误时没有指向忘记密码');
    await bannedWords('login(密码错误)', r.page);
    for (let i = 1; i < 10; i++) {
      await r.page.locator('#btnLogin:not([disabled])').waitFor({ timeout: 5000 });
      await r.page.click('#btnLogin');
    }
    await r.page.locator('#btnLogin:not([disabled])').waitFor({ timeout: 5000 });
    check(r.supabaseCalls.filter(c => c.path === '/auth/v1/token').length === 10, `login: 密码登录请求次数 ${r.supabaseCalls.filter(c => c.path === '/auth/v1/token').length}`);
    await r.page.click('#btnLogin');
    await r.page.waitForTimeout(200);
    const limited = await hintText(r.page, '#loginHint');
    check(/请等待约 \d+ 分钟后再试/.test(limited) && limited.includes('15 分钟内最多 10 次'), `login: 限流提示未写明等待时间 ${limited}`);
    await r.page.click('#loginHint #hintForgot').catch(() => {});
    await r.page.click('#tabReset');
    check(await r.page.locator('#btnSendReset').isVisible(), 'login: 忘记密码模式未显示发送按钮');
    commonChecks('login', r);
    await r.context.close();

    const link = await openPage(browser, '/login?mode=link', {
      auth: async (route, req, url) => (url.pathname === '/auth/v1/otp' ? reply(route, 200, {}) : false),
    });
    await link.page.locator('#btnSendLink:not([disabled])').waitFor({ timeout: 10000 });
    check(await link.page.locator('#btnLogin').isHidden(), 'login?mode=link: 未切换到登录链接模式');
    await link.page.fill('#email', 'user@example.org');
    await link.page.click('#btnSendLink');
    await link.page.waitForFunction(() => /登录链接已发送/.test(document.querySelector('#loginHint').innerText), null, { timeout: 10000 });
    const otp = link.supabaseCalls.filter(c => c.path === '/auth/v1/otp');
    check(otp.length === 1 && otp[0].body?.create_user === false, `login?mode=link: 登录链接请求不正确 ${JSON.stringify(otp)}`);
    commonChecks('login?mode=link', link);
    await link.context.close();

    const notConfirmed = await openPage(browser, '/login', {
      auth: async (route, req, url) => {
        if (url.pathname === '/auth/v1/token') return reply(route, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        if (url.pathname === '/auth/v1/resend') return reply(route, 200, {});
        return false;
      },
    });
    await notConfirmed.page.locator('#btnLogin:not([disabled])').waitFor({ timeout: 10000 });
    await notConfirmed.page.fill('#email', 'new@example.org');
    await notConfirmed.page.fill('#password', 'Aa1!aaaa');
    await notConfirmed.page.click('#btnLogin');
    await notConfirmed.page.waitForFunction(() => /还没有完成验证/.test(document.querySelector('#loginHint').innerText), null, { timeout: 10000 });
    await notConfirmed.page.locator('#loginHint button', { hasText: '重新发送确认邮件' }).click();
    await notConfirmed.page.waitForFunction(() => /确认邮件已重新发送/.test(document.querySelector('#loginHint').innerText), null, { timeout: 10000 });
    check(notConfirmed.supabaseCalls.filter(c => c.path === '/auth/v1/resend').length === 1, 'login: 未重新发送确认邮件');
    await bannedWords('login(未验证)', notConfirmed.page);
    commonChecks('login(未验证)', notConfirmed);
    await notConfirmed.context.close();
  }

  // ── /auth-callback：链接过期后在本页直接重新发送 ──
  {
    const r = await openPage(browser, '/auth-callback?returnTo=/staff#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', {
      auth: async (route, req, url) => (url.pathname === '/auth/v1/otp' ? reply(route, 200, {}) : false),
    });
    await r.page.locator('#callbackError').waitFor({ state: 'visible', timeout: 10000 });
    const msg = await r.page.locator('#callbackErrorMsg').innerText();
    check(msg.includes('已过期') || msg.includes('已经使用过'), `auth-callback: 失败原因未翻译 ${msg}`);
    check(!r.page.url().includes('error_description'), 'auth-callback: 地址栏仍保留认证参数');
    await r.page.fill('#resendEmail', 'User@Example.org ');
    await r.page.evaluate(() => { const form = document.querySelector('#resendForm'); form.requestSubmit(); form.requestSubmit(); });
    await r.page.waitForFunction(() => /新的登录链接已发送/.test(document.querySelector('#resendHint').innerText), null, { timeout: 10000 });
    const otp = r.supabaseCalls.filter(c => c.path === '/auth/v1/otp');
    check(otp.length === 1, `auth-callback: 登录链接请求次数 ${otp.length}`);
    check(otp[0]?.body?.email === 'user@example.org' && otp[0]?.body?.create_user === false, `auth-callback: 请求内容不正确 ${JSON.stringify(otp[0]?.body)}`);
    check(/auth-callback\?returnTo=\/staff/.test(decodeURIComponent(otp[0]?.search || '')), `auth-callback: 回跳地址不正确 ${otp[0]?.search}`);
    await bannedWords('auth-callback', r.page);
    commonChecks('auth-callback', r);
    await r.context.close();

    const rec = await openPage(browser, '/auth-callback?recovery=1&returnTo=/staff#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', {
      auth: async (route, req, url) => (url.pathname === '/auth/v1/recover' ? reply(route, 200, {}) : false),
    });
    await rec.page.locator('#callbackError').waitFor({ state: 'visible', timeout: 10000 });
    check((await rec.page.locator('#callbackResendBtn').innerText()).includes('重设密码'), 'auth-callback(重设密码): 按钮未切换为重新发送重设邮件');
    await rec.page.fill('#resendEmail', 'user@example.org');
    await rec.page.click('#callbackResendBtn');
    await rec.page.waitForFunction(() => /重设密码邮件已经发出/.test(document.querySelector('#resendHint').innerText), null, { timeout: 10000 });
    check(rec.supabaseCalls.filter(c => c.path === '/auth/v1/recover').length === 1, 'auth-callback(重设密码): 未调用重设密码接口');
    commonChecks('auth-callback(重设密码)', rec);
    await rec.context.close();

    const empty = await openPage(browser, '/auth-callback', {
      auth: async (route, req, url) => (url.pathname === '/auth/v1/otp' ? reply(route, 422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }) : false),
    });
    await empty.page.locator('#callbackError').waitFor({ state: 'visible', timeout: 10000 });
    await empty.page.fill('#resendEmail', 'nobody@example.org');
    await empty.page.click('#callbackResendBtn');
    await empty.page.waitForFunction(() => /还没有注册账号/.test(document.querySelector('#resendHint').innerText), null, { timeout: 10000 });
    check(await empty.page.locator('#resendHint a[href="/signup"]').count() === 1, 'auth-callback(未注册): 没有注册入口');
    await bannedWords('auth-callback(未注册)', empty.page);
    commonChecks('auth-callback(未注册)', empty);
    await empty.context.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('PUBLIC_B_FAILED');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PUBLIC_B_OK');
