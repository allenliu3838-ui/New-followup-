#!/usr/bin/env python3
"""境外依赖检查：列出 site/ 中浏览器可能请求的外部主机，并单独报告 config.js 里的数据库主机。

只做静态文本分析，不发出任何网络请求，不读取 site/ 以外的文件。

用法：
  python3 -I scripts/check_external_hosts.py                         # 检查仓库内 site/
  python3 -I scripts/check_external_hosts.py --site /var/www/kidneysphere-registry
  python3 -I scripts/check_external_hosts.py --require-domestic-db   # 迁移完成后使用
  python3 -I scripts/check_external_hosts.py --allow-host api.example.cn --json

分类：
  违规          浏览器会自动请求的非允许主机：<script src>、<link rel=stylesheet 等 href>、<img src>、
                CSS url()/@import、fetch/XMLHttpRequest，以及 JS 字符串中的完整网址（静态分析无法确认
                用途，一律按“可能在运行时请求”处理，除非位于 <a href> 片段或页面跳转语句中）。
  受开关保护    analytics.js 中的 plausible.io，且代码（不含注释）读取 CONFIG.FEATURES.ANALYTICS
                开关、没有把缺省值设为开启。config.js 打开该开关且仍指向境外时改判为违规。
  仅链接        只出现在 <a href>、<link rel=canonical>、<meta> 内容、注释或页面跳转中的主机，
                不会被浏览器自动请求。
  第三方库字符串 site/lib/vendor/ 内的文档链接等字符串；若出现在 fetch(、import(、.src= 等请求
                写法中则判为违规。
  数据库主机    config.js 的 SUPABASE_URL 单独报告：*.supabase.co 输出警告“数据库仍在境外”；
                加 --require-domestic-db 时，数据库主机不在允许清单内即判为违规。

退出码：0 无违规；1 有违规；2 参数或读取错误。
"""
from __future__ import annotations

import argparse
import bisect
import html.parser
import ipaddress
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

ALLOWED_SUFFIXES = ('kidneysphere.com', 'kidneysphereregistry.cn')  # 本身及全部子域
ALLOWED_EXACT = frozenset({'beian.miit.gov.cn', 'beian.mps.gov.cn', 'www.cac.gov.cn'})
# RFC 2606/6761 保留名称与本机地址：用作 URL 解析基准等，不产生外部请求。
RESERVED_EXACT = frozenset({'localhost', 'example.com', 'example.net', 'example.org'})
RESERVED_SUFFIXES = ('.invalid', '.example', '.test', '.localhost')
FOREIGN_DB_SUFFIXES = ('supabase.co', 'supabase.com', 'supabase.in')
# 仅在指定文件内、由指定开关保护时放行的主机。
GATED = {'analytics.js': {'flag': 'ANALYTICS', 'hosts': frozenset({'plausible.io'})}}

SCAN_SUFFIXES = ('.html', '.htm', '.js', '.mjs', '.css')
VENDOR_DIR = ('lib', 'vendor')

URL_RE = re.compile(r'(?i)(?<![\w.+-])(?:https?|wss?|ftp)://[^\s"\'<>()\\`,;{}]+')
PROTOCOL_RELATIVE_RE = re.compile(r'^\s*(//[^\s"\'<>()\\`,;{}]+)')
CSS_URL_RE = re.compile(r'(?i)url\(\s*(["\']?)([^"\')]+)\1\s*\)|@import\s+(["\'])([^"\']+)\3')
HTML_ATTR_BEFORE_RE = re.compile(r'(?is)<\s*([a-z][\w:-]*)\b[^<>]*?\b([a-z][\w:.-]*)\s*=\s*["\']?\s*$')
NAVIGATION_BEFORE_RE = re.compile(
    r'(?:\blocation(?:\.href)?\s*=|\blocation\.(?:assign|replace)\s*\(|\bwindow\.open\s*\()\s*$')
VENDOR_REQUEST_BEFORE_RE = re.compile(
    r'(?:\b(?:fetch|import|importScripts|sendBeacon|EventSource|WebSocket|Worker|SharedWorker)\s*\(\s*'
    r'|\bfrom\s*|\.src\s*=\s*|\bsetAttribute\(\s*["\'](?:src|href)["\']\s*,\s*'
    r'|\.open\(\s*["\'][A-Za-z]+["\']\s*,\s*|\burl\(\s*|@import\s+)["\'`]?$')

FETCH_RELS = frozenset({'stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed',
                        'mask-icon', 'preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch',
                        'manifest', 'prerender', 'fluid-icon'})
LINK_RELS = frozenset({'canonical', 'alternate', 'author', 'license', 'help', 'next', 'prev', 'bookmark',
                       'external', 'me', 'nofollow', 'noopener', 'noreferrer', 'search', 'tag', 'privacy-policy',
                       'terms-of-service'})
RESOURCE_ATTRS = {
    'script': {'src'}, 'img': {'src', 'srcset'}, 'source': {'src', 'srcset'}, 'iframe': {'src'},
    'frame': {'src'}, 'embed': {'src'}, 'object': {'data'}, 'video': {'src', 'poster'}, 'audio': {'src'},
    'track': {'src'}, 'input': {'src', 'formaction'}, 'image': {'href', 'xlink:href'}, 'use': {'href', 'xlink:href'},
    'form': {'action'}, 'button': {'formaction'}, 'base': {'href'}, 'feimage': {'href', 'xlink:href'},
}
LINK_ONLY_ATTRS = {'a': {'href', 'ping'}, 'area': {'href'}, 'blockquote': {'cite'}, 'q': {'cite'},
                   'del': {'cite'}, 'ins': {'cite'}, 'img': {'longdesc'}}
NAMESPACE_ATTRS = frozenset({'xmlns', 'itemtype', 'itemid', 'itemprop', 'profile', 'version'})
JS_SCRIPT_TYPES = frozenset({'', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript',
                             'application/ecmascript'})
DATA_SCRIPT_TYPES = frozenset({'application/ld+json', 'application/json'})

GATE_DIRECT_RE = re.compile(
    r'FEATURES\s*(?:\?\.\s*|\.\s*)(?:ANALYTICS\b|\[\s*["\']ANALYTICS["\']\s*\])|FEATURES\s*\[\s*["\']ANALYTICS["\']\s*\]')
GATE_INDIRECT_RE = re.compile(r'(?:\?\.|\.)\s*ANALYTICS\b|\[\s*["\']ANALYTICS["\']\s*\]')
GATE_DEFAULT_ON_RE = re.compile(
    r'ANALYTICS["\']?\s*\]?\s*(?:\?\?|\|\|)\s*(?:true|1|!0)\b|ANALYTICS["\']?\s*\]?\s*!==?\s*false\b')

RUNTIME, LINK, VENDOR_STRING, IGNORED = 'runtime', 'link', 'vendor_string', 'ignored'


class Finding(dict):
    """host, file, line, context, kind（runtime/link/vendor_string/ignored）。"""


def normalise_host(raw: str) -> str | None:
    try:
        parts = urlsplit(raw if '://' in raw else 'https:' + raw)
        host = parts.hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.rstrip('.').lower()
    if not re.fullmatch(r'[a-z0-9.\-:\[\]]+', host) or '.' not in host and host != 'localhost' and ':' not in host:
        return None
    return host


def is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip('[]'))
        return True
    except ValueError:
        return False


def is_reserved(host: str) -> bool:
    if host in RESERVED_EXACT or host.endswith(RESERVED_SUFFIXES):
        return True
    if is_ip(host):
        address = ipaddress.ip_address(host.strip('[]'))
        return address.is_loopback or address.is_unspecified
    return False


def is_allowed(host: str, extra: frozenset[str] = frozenset()) -> bool:
    if host in ALLOWED_EXACT or host in extra:
        return True
    return any(host == s or host.endswith('.' + s) for s in ALLOWED_SUFFIXES)


def is_foreign_db(host: str) -> bool:
    return any(host == s or host.endswith('.' + s) for s in FOREIGN_DB_SUFFIXES)


class LineIndex:
    def __init__(self, text: str):
        self.starts = [0] + [m.end() for m in re.finditer('\n', text)]

    def line(self, offset: int) -> int:
        return bisect.bisect_right(self.starts, offset)


def scan_js(text: str):
    """切分 JS：返回 (字符串片段[(start,end)], 注释[(start,end)], 去掉注释后的代码文本)。

    处理单/双引号、模板字符串（含 ${} 嵌套）、行/块注释和常见正则字面量；够用于静态检查，
    不是完整的 JS 解析器。
    """
    strings, comments = [], []
    n = len(text)
    i = 0
    stack = []          # 模板字符串 ${ 的花括号深度
    last = ''           # 上一个有效记号的末字符或关键字，用于判断 / 是否开始正则
    word_before_regex = {'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
                         'throw', 'instanceof', 'yield', 'await'}

    def read_template(pos: int) -> int:
        """pos 指向模板内容起点；返回结束反引号后的位置，或遇到 ${ 时返回 -(位置)。"""
        start = pos
        while pos < n:
            ch = text[pos]
            if ch == '\\':
                pos += 2
                continue
            if ch == '`':
                strings.append((start, pos))
                return pos + 1
            if ch == '$' and pos + 1 < n and text[pos + 1] == '{':
                strings.append((start, pos))
                return -(pos + 2)
            pos += 1
        strings.append((start, n))
        return n

    while i < n:
        c = text[i]
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            j = n if j < 0 else j
            comments.append((i, j))
            i = j
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            j = n if j < 0 else j + 2
            comments.append((i, j))
            i = j
            continue
        if c in '\'"':
            j = i + 1
            while j < n and text[j] != c and text[j] != '\n':
                j += 2 if text[j] == '\\' else 1
            strings.append((i + 1, min(j, n)))
            i = j + 1
            last = '"'
            continue
        if c == '`':
            r = read_template(i + 1)
            if r < 0:
                stack.append(0)
                i = -r
                last = '('
            else:
                i = r
                last = '"'
            continue
        if stack and c == '{':
            stack[-1] += 1
        elif stack and c == '}':
            if stack[-1] == 0:
                stack.pop()
                r = read_template(i + 1)
                if r < 0:
                    stack.append(0)
                    i = -r
                    last = '('
                else:
                    i = r
                    last = '"'
                continue
            stack[-1] -= 1
        if c == '/':
            m = re.search(r'([A-Za-z_$][\w$]*)\s*$', text[max(0, i - 20):i])
            if last == '' or last in '(,=:[!&|?{};+-*%<>~^' or (m and m.group(1) in word_before_regex):
                j = i + 1
                in_class = False
                while j < n and text[j] != '\n':
                    d = text[j]
                    if d == '\\':
                        j += 2
                        continue
                    if in_class:
                        in_class = d != ']'
                    elif d == '[':
                        in_class = True
                    elif d == '/':
                        break
                    j += 1
                j += 1
                while j < n and (text[j].isalnum() or text[j] in '_$'):
                    j += 1
                i = j
                last = 'a'
                continue
        if not c.isspace():
            last = c if not (c.isalnum() or c in '_$') else 'a'
        i += 1
    code = list(text)
    for start, end in comments:
        for k in range(start, end):
            if code[k] != '\n':
                code[k] = ' '
    return strings, comments, ''.join(code)


def classify_html_attr(tag: str, attr: str, rels: set[str] | None = None):
    tag, attr = tag.lower(), attr.lower()
    if attr in NAMESPACE_ATTRS or attr.startswith('xmlns:'):
        return IGNORED, f'<{tag} {attr}>（命名空间）'
    if attr.startswith('on'):
        return None, None  # 由调用方按 JS 处理
    if tag == 'link' and attr in ('href', 'imagesrcset'):
        if rels is not None and rels and not (rels & FETCH_RELS) and (rels & LINK_RELS):
            return LINK, f'<link rel={"/".join(sorted(rels))} href>'
        return RUNTIME, f'<link rel={"/".join(sorted(rels)) if rels else "?"} href>'
    if tag == 'meta':
        return LINK, '<meta content>'
    if attr in RESOURCE_ATTRS.get(tag, ()):
        return RUNTIME, f'<{tag} {attr}>'
    if attr in LINK_ONLY_ATTRS.get(tag, ()):
        return LINK, f'<{tag} {attr}>'
    if attr == 'style':
        return RUNTIME, f'<{tag} style>'
    # 其他属性（如 data-src）可能被脚本取用：按会请求处理。
    return RUNTIME, f'<{tag} {attr}>'


class Scanner:
    def __init__(self, site: Path, extra_allowed: frozenset[str] = frozenset()):
        self.site = site
        self.extra = extra_allowed
        self.findings: list[Finding] = []
        self.gate_status: dict[str, dict] = {}
        self.files_scanned = 0

    # -- helpers -----------------------------------------------------------
    def rel(self, path: Path) -> str:
        return f'{self.site.name}/{path.relative_to(self.site).as_posix()}'

    def add(self, url: str, path: Path, line: int, context: str, kind: str):
        host = normalise_host(url)
        if host is None:
            return
        self.findings.append(Finding(host=host, file=self.rel(path), line=line, context=context, kind=kind,
                                     url=url[:160]))

    def urls_in(self, fragment: str):
        for m in URL_RE.finditer(fragment):
            yield m.start(), m.group(0)
        m = PROTOCOL_RELATIVE_RE.match(fragment)
        if m:
            yield m.start(1), m.group(1)

    # -- CSS ---------------------------------------------------------------
    def scan_css(self, text: str, path: Path, base_line: int, context: str):
        lines = LineIndex(text)
        for m in re.finditer(r'/\*.*?\*/', text, flags=re.S):
            for offset, url in self.urls_in(m.group(0)):
                if not url.startswith('//'):
                    self.add(url, path, base_line + lines.line(m.start() + offset) - 1, f'{context} 注释', IGNORED)
        clean = re.sub(r'/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), text, flags=re.S)
        for m in CSS_URL_RE.finditer(clean):
            value = (m.group(2) or m.group(4) or '').strip()
            if re.match(r'(?i)(?:https?:|wss?:|ftp:)?//', value):
                self.add(value, path, base_line + lines.line(m.start()) - 1, f'{context} url()/@import', RUNTIME)

    # -- JS ----------------------------------------------------------------
    def scan_vendor(self, text: str, path: Path):
        """第三方库：静态 grep 全部网址，只看紧邻的写法是否为请求（fetch(、import(、.src= 等）。"""
        lines = LineIndex(text)
        for m in URL_RE.finditer(text):
            before = text[max(0, m.start() - 80):m.start()]
            if VENDOR_REQUEST_BEFORE_RE.search(before):
                self.add(m.group(0), path, lines.line(m.start()), '第三方库中的请求写法', RUNTIME)
            else:
                self.add(m.group(0), path, lines.line(m.start()), '第三方库字符串', VENDOR_STRING)

    def scan_js_text(self, text: str, path: Path, base_line: int, context: str):
        strings, comments, code = scan_js(text)
        lines = LineIndex(text)
        covered = []
        for start, end in comments:
            covered.append((start, end))
            for offset, url in self.urls_in(text[start:end]):
                if url.startswith('//'):
                    continue
                self.add(url, path, base_line + lines.line(start + offset) - 1, f'{context} 注释', IGNORED)
        for start, end in strings:
            covered.append((start, end))
            body = text[start:end]
            for offset, url in self.urls_in(body):
                line = base_line + lines.line(start + offset) - 1
                before_in_string = body[:offset]
                code_before = code[max(0, start - 120):max(0, start - 1)]
                attr = HTML_ATTR_BEFORE_RE.search(before_in_string)
                if attr:
                    kind, label = classify_html_attr(attr.group(1), attr.group(2))
                    if kind is None:
                        kind, label = RUNTIME, f'<{attr.group(1)} {attr.group(2)}>'
                    self.add(url, path, line, f'{context} 字符串中的 {label}', kind)
                elif re.search(r'(?i)url\(\s*["\']?$', before_in_string):
                    self.add(url, path, line, f'{context} 字符串中的 CSS url()', RUNTIME)
                elif '<' in body or '>' in body:
                    self.add(url, path, line, f'{context} 字符串中的 HTML 文字', LINK)
                elif NAVIGATION_BEFORE_RE.search(code_before):
                    self.add(url, path, line, f'{context} 页面跳转', LINK)
                else:
                    self.add(url, path, line, f'{context} 字符串（按运行时请求处理）', RUNTIME)
        # 兜底：切分失败时落在代码区的网址同样按运行时请求处理，宁可多报。
        covered.sort()
        starts = [a for a, _ in covered]
        for m in URL_RE.finditer(text):
            k = bisect.bisect_right(starts, m.start()) - 1
            if k >= 0 and covered[k][0] <= m.start() < covered[k][1]:
                continue
            self.add(m.group(0), path, base_line + lines.line(m.start()) - 1, f'{context} 代码（未能归类）', RUNTIME)
        return code

    # -- HTML --------------------------------------------------------------
    def scan_html(self, text: str, path: Path):
        scanner = self

        class Parser(html.parser.HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=False)
                self.mode = None
                self.mode_line = 0
                self.buffer = []

            def handle_starttag(self, tag, attrs):
                line = self.getpos()[0]
                values = {k.lower(): (v or '') for k, v in attrs}
                rels = set(values.get('rel', '').lower().split()) if tag == 'link' else None
                for name, value in attrs:
                    if value is None:
                        continue
                    name = name.lower()
                    if name.startswith('on'):
                        scanner.scan_js_text(value, path, line, f'<{tag} {name}>')
                        continue
                    if name == 'style':
                        scanner.scan_css(value, path, line, f'<{tag} style>')
                        continue
                    kind, label = classify_html_attr(tag, name, rels)
                    if name in ('srcset', 'imagesrcset'):
                        candidates = [c.strip().split()[0] for c in value.split(',') if c.strip()]
                    elif tag == 'meta' and values.get('http-equiv', '').lower() == 'refresh':
                        candidates = re.findall(r'(?i)url\s*=\s*([^\s;]+)', value)
                        label = '<meta refresh>（页面跳转）'
                    else:
                        candidates = [value]
                    for candidate in candidates:
                        stripped = candidate.strip()
                        if re.match(r'(?i)(?:https?:|wss?:|ftp:)?//', stripped):
                            scanner.add(stripped, path, line, label, kind)
                        elif tag == 'meta':
                            for _, url in scanner.urls_in(stripped):
                                scanner.add(url, path, line, label, kind)
                if tag in ('script', 'style'):
                    script_type = values.get('type', '').strip().lower()
                    if tag == 'style':
                        self.mode = 'css'
                    elif script_type in JS_SCRIPT_TYPES:
                        self.mode = 'js'
                    elif script_type not in DATA_SCRIPT_TYPES and script_type in ('importmap', 'speculationrules'):
                        self.mode = 'requests'  # 导入映射/预取规则中的网址会被浏览器请求
                    else:
                        self.mode = 'data'  # JSON-LD、模板等数据块，浏览器不会据此发请求
                    self.mode_line = line
                    self.buffer = []

            def handle_startendtag(self, tag, attrs):
                self.handle_starttag(tag, attrs)
                if tag in ('script', 'style'):
                    self.mode = None

            def handle_data(self, data):
                if self.mode:
                    self.buffer.append(data)
                    return
                for offset, url in scanner.urls_in(data):
                    if not url.startswith('//'):
                        scanner.add(url, path, self.getpos()[0] + data[:offset].count('\n'), 'HTML 文字', LINK)

            def handle_endtag(self, tag):
                if tag in ('script', 'style') and self.mode:
                    body = ''.join(self.buffer)
                    if self.mode == 'css':
                        scanner.scan_css(body, path, self.mode_line, '<style>')
                    elif self.mode == 'js':
                        scanner.scan_js_text(body, path, self.mode_line, '<script>')
                    elif self.mode == 'requests':
                        for offset, url in scanner.urls_in(body):
                            scanner.add(url, path, self.mode_line + body[:offset].count('\n'),
                                        '<script> 导入映射/预取规则', RUNTIME)
                    else:
                        for offset, url in scanner.urls_in(body):
                            scanner.add(url, path, self.mode_line + body[:offset].count('\n'),
                                        '<script> 数据块（JSON-LD 等）', LINK)
                    self.mode = None
                    self.buffer = []

            def handle_comment(self, data):
                for _, url in scanner.urls_in(data):
                    scanner.add(url, path, self.getpos()[0], 'HTML 注释', IGNORED)

        parser = Parser()
        parser.feed(text)
        parser.close()

    # -- gates -------------------------------------------------------------
    def evaluate_gate(self, name: str, code_without_comments: str):
        rule = GATED[name]
        flag = rule['flag']
        direct = bool(GATE_DIRECT_RE.search(code_without_comments))
        indirect = ('FEATURES' in code_without_comments and 'CONFIG' in code_without_comments
                    and bool(GATE_INDIRECT_RE.search(code_without_comments)))
        default_on = bool(GATE_DEFAULT_ON_RE.search(code_without_comments))
        self.gate_status[name] = {'flag': f'CONFIG.FEATURES.{flag}', 'detected': direct or indirect,
                                  'default_on': default_on, 'protected': (direct or indirect) and not default_on}

    # -- main --------------------------------------------------------------
    def scan(self):
        root = self.site.resolve()
        for path in sorted(self.site.rglob('*')):
            if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES:
                continue
            if not path.resolve().is_relative_to(root):
                continue  # 指向站点目录以外的符号链接不读取
            relative = path.relative_to(self.site)
            if relative.as_posix() == 'config.js':
                continue
            text = path.read_text(encoding='utf-8', errors='replace')
            self.files_scanned += 1
            vendor = relative.parts[:2] == VENDOR_DIR
            suffix = path.suffix.lower()
            if suffix in ('.html', '.htm'):
                self.scan_html(text, path)
            elif suffix == '.css':
                self.scan_css(text, path, 1, 'CSS')
            elif vendor:
                self.scan_vendor(text, path)
            else:
                code = self.scan_js_text(text, path, 1, 'JS')
                if relative.as_posix() in GATED:
                    self.evaluate_gate(relative.as_posix(), code)
        return self


def analyse_config(site: Path, extra: frozenset[str], domestic_db_hosts: frozenset[str]):
    path = site / 'config.js'
    report = {'file': f'{site.name}/config.js', 'present': path.is_file(), 'database_host': None,
              'database_status': 'missing', 'other_hosts': [], 'features': {}}
    if not path.is_file():
        return report
    text = path.read_text(encoding='utf-8', errors='replace')
    strings, _, code = scan_js(text)
    lines = LineIndex(text)
    m = re.search(r'SUPABASE_URL\s*:\s*(["\'`])(.*?)\1', code)
    db_host = normalise_host(m.group(2)) if m and re.match(r'(?i)https?://', m.group(2)) else None
    report['database_host'] = db_host
    if db_host is None:
        report['database_status'] = 'missing'
    elif is_foreign_db(db_host):
        report['database_status'] = 'foreign'
    elif is_allowed(db_host, extra | domestic_db_hosts) or is_reserved(db_host):
        report['database_status'] = 'allowed'
    else:
        report['database_status'] = 'unknown'
    for start, end in strings:
        body = text[start:end]
        keys = re.findall(r'([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$', code[max(0, start - 80):max(0, start - 1)])
        key = keys[-1] if keys else '?'
        if key == 'SUPABASE_URL':
            continue
        for m2 in URL_RE.finditer(body):
            host = normalise_host(m2.group(0))
            if host is not None:
                report['other_hosts'].append({'host': host, 'key': key, 'line': lines.line(start + m2.start())})
    for flag in ('ANALYTICS', 'GENETICS'):
        fm = re.search(r'\b' + flag + r'\s*:\s*(true|false)\b', code)
        report['features'][flag] = None if fm is None else fm.group(1) == 'true'
    sm = re.search(r'\bANALYTICS_SRC\s*:\s*(["\'`])(.*?)\1', code)
    report['features']['ANALYTICS_SRC'] = sm.group(2) if sm else None
    return report


def build_report(site: Path, extra: frozenset[str] = frozenset(), require_domestic_db: bool = False,
                 domestic_db_hosts: frozenset[str] = frozenset()):
    scanner = Scanner(site, extra).scan()
    config = analyse_config(site, extra, domestic_db_hosts)
    violations, gated, link_only, vendor_strings, allowed, ignored, warnings = [], [], [], [], [], [], []
    for f in scanner.findings:
        host = f['host']
        if f['kind'] == IGNORED or is_reserved(host):
            ignored.append(f)
        elif is_allowed(host, extra):
            allowed.append(f)
        elif f['kind'] == RUNTIME:
            local = f['file'].split('/', 1)[1]
            rule = GATED.get(local)
            gate = scanner.gate_status.get(local)
            if rule and host in rule['hosts'] and gate and gate['protected'] and f['context'].startswith('JS'):
                gated.append(f)
            else:
                if is_foreign_db(host):
                    f = Finding(f, note='页面代码中写死了境外数据库/存储地址')
                violations.append(f)
        elif f['kind'] == VENDOR_STRING:
            vendor_strings.append(f)
        else:
            link_only.append(f)
    for name, gate in scanner.gate_status.items():
        if gate['default_on']:
            warnings.append(f'{scanner.site.name}/{name}：开关 {gate["flag"]} 的缺省值看起来是开启，不能视为受保护')
    features = config['features']
    if gated and features.get('ANALYTICS'):
        src_host = normalise_host(features['ANALYTICS_SRC']) if features.get('ANALYTICS_SRC') else None
        if src_host is None or not (is_allowed(src_host, extra) or is_reserved(src_host)):
            target = src_host or ', '.join(sorted({g['host'] for g in gated}))
            violations.append(Finding(host=target, file=config['file'], line=0, kind=RUNTIME,
                                      context='config.js 打开了 FEATURES.ANALYTICS，统计脚本将请求境外主机',
                                      url=features.get('ANALYTICS_SRC') or ''))
    db = config['database_host']
    status = config['database_status']
    if status == 'foreign':
        warnings.append(f'数据库仍在境外：{db}（config.js SUPABASE_URL）')
    elif status == 'unknown':
        warnings.append(f'数据库主机 {db} 不在允许清单内，无法确认位于境内，请人工核实')
    elif status == 'missing':
        warnings.append('config.js 中未找到 SUPABASE_URL 数据库地址')
    if require_domestic_db and status != 'allowed':
        violations.append(Finding(host=db or '（缺失）', file=config['file'], line=0, kind=RUNTIME,
                                  context='--require-domestic-db：数据库主机不在境内允许清单内', url=''))
    for item in config['other_hosts']:
        host, key = item['host'], item['key']
        if key == 'ANALYTICS_SRC':
            continue  # 已在统计开关处单独判断
        entry = Finding(host=host, file=config['file'], line=item['line'], kind=RUNTIME,
                        context=f'config.js {key}', url='')
        if is_foreign_db(host):
            if require_domestic_db:
                violations.append(Finding(entry, note='存储地址仍在境外'))
            else:
                warnings.append(f'config.js {key} 仍指向境外存储：{host}（第 {item["line"]} 行）')
        elif host == db or is_reserved(host) or is_allowed(host, extra):
            continue  # 与数据库同主机（已单独报告）或允许的主机
        else:
            violations.append(entry)
    if features.get('GENETICS'):
        warnings.append('config.js 打开了 FEATURES.GENETICS：人类遗传资源评估完成前应保持关闭')
    return {
        'site': str(site), 'files_scanned': scanner.files_scanned,
        'violations': violations, 'gated': gated, 'link_only': link_only, 'vendor_strings': vendor_strings,
        'allowed': allowed, 'ignored': ignored, 'warnings': warnings, 'config': config,
        'gates': scanner.gate_status, 'exit_code': 1 if violations else 0,
    }


def group(findings):
    hosts = {}
    for f in findings:
        hosts.setdefault(f['host'], []).append(f)
    return dict(sorted(hosts.items()))


def render_text(report) -> str:
    out = [f'境外依赖检查：{report["site"]}（扫描 {report["files_scanned"]} 个 html/js/css 文件；不含 config.js）', '']

    def section(title, findings, limit=4):
        out.append(f'{title}：{"无" if not findings else ""}')
        for host, items in group(findings).items():
            places = '；'.join(f'{i["file"]}:{i["line"]} {i["context"]}' + (f'（{i["note"]}）' if i.get('note') else '')
                              for i in items[:limit])
            more = f'；另有 {len(items) - limit} 处' if len(items) > limit else ''
            out.append(f'  {host}  [{len(items)} 处] {places}{more}')
        out.append('')

    section('[违规] 浏览器会自动请求的非允许主机', report['violations'])
    section('[受开关保护] 默认不加载，仅在 config.js 打开开关后请求', report['gated'])
    section('[仅链接/文字] 不会被浏览器自动请求', report['link_only'], limit=2)
    section('[第三方库字符串] site/lib/vendor 中的文档链接等，未发现请求写法', report['vendor_strings'], limit=1)
    allowed = group(report['allowed'])
    out.append('[允许的主机]：' + ('无' if not allowed else '，'.join(f'{h}（{len(v)} 处）' for h, v in allowed.items())))
    ignored = group(report['ignored'])
    if ignored:
        out.append('[忽略] 保留域名/本机地址/注释/命名空间：' + '，'.join(f'{h}（{len(v)}）' for h, v in ignored.items()))
    out.append('')
    cfg = report['config']
    out.append('[数据库与存储主机（config.js，单独报告）]')
    if not cfg['present']:
        out.append('  未找到 config.js')
    else:
        label = {'foreign': '境外（Supabase 云服务）', 'allowed': '在允许清单内（境内域名；实际机房位置仍以云控制台为准）',
                 'unknown': '不在允许清单内，需人工核实', 'missing': '未找到'}[cfg['database_status']]
        out.append(f'  数据库主机：{cfg["database_host"] or "（无）"} —— {label}')
        for item in cfg['other_hosts']:
            out.append(f'  其他地址：{item["key"]} → {item["host"]}（第 {item["line"]} 行）')
        feats = cfg['features']
        show = lambda v: '未设置（使用代码缺省值）' if v is None else ('开启' if v else '关闭')  # noqa: E731
        out.append(f'  FEATURES.ANALYTICS：{show(feats.get("ANALYTICS"))}；FEATURES.GENETICS：{show(feats.get("GENETICS"))}')
    for name, gate in report['gates'].items():
        state = '已识别' if gate['detected'] else '未识别'
        out.append(f'  {name} 开关 {gate["flag"]}：{state}' + ('，但缺省为开启' if gate['default_on'] else ''))
    out.append('')
    for warning in report['warnings']:
        out.append(f'警告：{warning}')
    count = len(report['violations'])
    out.append(f'结论：{"发现 " + str(count) + " 处违规" if count else "未发现违规"}（退出码 {report["exit_code"]}）')
    return '\n'.join(out) + '\n'


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='检查 site/ 中的境外主机依赖（静态分析，不联网）')
    parser.add_argument('--site', type=Path, default=Path(__file__).resolve().parents[1] / 'site',
                        help='要检查的站点目录（默认：仓库内 site/）')
    parser.add_argument('--allow-host', action='append', default=[], metavar='HOST',
                        help='额外允许的主机（精确匹配，可重复），例如迁移后的境内数据库域名')
    parser.add_argument('--domestic-db-host', action='append', default=[], metavar='HOST',
                        help='确认位于境内的数据库主机（精确匹配，可重复）')
    parser.add_argument('--require-domestic-db', action='store_true',
                        help='迁移完成后使用：数据库主机不在允许清单内即判为违规')
    parser.add_argument('--json', action='store_true', help='输出 JSON')
    args = parser.parse_args(argv)
    site = args.site.resolve()
    if not site.is_dir():
        print(f'错误：站点目录不存在：{site}', file=sys.stderr)
        return 2
    extra = frozenset(h.strip().lower().rstrip('.') for h in args.allow_host if h.strip())
    domestic = frozenset(h.strip().lower().rstrip('.') for h in args.domestic_db_host if h.strip())
    try:
        report = build_report(site, extra, args.require_domestic_db, domestic)
    except OSError as exc:
        print(f'错误：读取失败：{exc}', file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, default=dict))
    else:
        sys.stdout.write(render_text(report))
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
