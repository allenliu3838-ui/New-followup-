// 重新生成首页、合作页和研究广场页中预渲染的研究卡片。
// 用法：node scripts/build_collaboration_pages.mjs           写入三个页面
//       node scripts/build_collaboration_pages.mjs --check   只检查，有页面过期时退出码为 1
// 卡片 HTML 由 site/collaboration-data.js 与 site/collaboration-components.js 生成，与浏览器端用同一个渲染函数。
// 浏览器在卡片代码一致时直接复用预渲染内容，所以改了数据或渲染函数就要重新生成；
// tests/ui/public-a-smoke.mjs 会逐字核对三个页面。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
export const PAGES = ['index.html', 'collaboration.html', 'research.html'];
export const BEGIN = '<!-- BEGIN GENERATED PROJECT CARDS: node scripts/build_collaboration_pages.mjs -->';
export const END = '<!-- END GENERATED PROJECT CARDS -->';

export function renderCards() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['collaboration-data.js', 'collaboration-components.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window.CollabComponents.projectsHtml(sandbox.window.CollabData.projectCards);
}

// 标记之间换成新的卡片 HTML；结束标记前的换行与缩进保留原样。
export function rebuild(src, html, name) {
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < a || src.indexOf(BEGIN, a + 1) >= 0 || src.indexOf(END, b + 1) >= 0) {
    throw new Error(`${name}: 预渲染标记缺失、顺序不对或重复`);
  }
  const inner = src.slice(a + BEGIN.length, b);
  const nl = inner.lastIndexOf('\n');
  const tail = nl < 0 ? '\n' : inner.slice(nl);
  return src.slice(0, a + BEGIN.length) + html + tail + src.slice(b);
}

function main() {
  const check = process.argv.includes('--check');
  const html = renderCards();
  const stale = [];
  for (const name of PAGES) {
    const file = path.join(SITE, name);
    const src = fs.readFileSync(file, 'utf8');
    const out = rebuild(src, html, name);
    if (out === src) continue;
    stale.push(name);
    if (!check) fs.writeFileSync(file, out);
  }
  if (check) {
    if (stale.length) {
      console.error('PROJECT_CARDS_STALE: ' + stale.join(', '));
      process.exit(1);
    }
    console.log(`PROJECT_CARDS_OK: ${PAGES.length} pages`);
  } else {
    console.log(stale.length ? 'PROJECT_CARDS_WRITTEN: ' + stale.join(', ') : 'PROJECT_CARDS_UNCHANGED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
