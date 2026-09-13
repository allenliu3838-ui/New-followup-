#!/usr/bin/env python3
"""Build a standalone visual preview; never modifies or contacts production."""
import argparse
import base64
import pathlib
import re


def build(output: pathlib.Path, shared: pathlib.Path) -> None:
    root = pathlib.Path(__file__).resolve().parents[1]
    site = root / 'site'
    draft = root / 'previews' / 'registry-tech'
    page = (draft / 'index.html').read_text()
    # Keep the original project rendering code but omit authentication, logging,
    # analytics and live configuration in this downloadable design preview.
    render = re.findall(r'<script>([\s\S]*?)</script>', page)[-1]
    page = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', page)
    page = re.sub(r'\s*<link\b[^>]*>', '', page)
    styles = '\n'.join((shared / n).read_text() for n in ['ks-topbar.css', 'ks-brand.css'])
    styles += '\n' + (site / 'app.css').read_text()
    page = page.replace('<style>', '<style>\n' + styles + '\n', 1)
    page = page.replace('</title>', ' · 视觉预览</title>', 1)
    page = page.replace('<head>', '<head>\n<base href="https://kidneysphereregistry.cn/" target="_blank">', 1)
    for name in ['kidneysphere-ai.png', 'registry-tech-hero.png']:
        asset_root = draft if name == 'registry-tech-hero.png' else site
        data = base64.b64encode((asset_root / 'assets' / name).read_bytes()).decode('ascii')
        page = page.replace('/assets/' + name, 'data:image/png;base64,' + data)
    nav = '''<div id="ks-topbar"><a class="ks-tb-brand" href="https://kidneysphere.com/">肾域</a><span class="ks-tb-sep"></span>
<a class="ks-tb-link" href="https://kidneysphere.com/">💬 学院</a>
<a class="ks-tb-link" data-active="true" href="https://kidneysphereregistry.cn/">🔬 科研</a>
<a class="ks-tb-link" href="https://kidneysphereremote.cn/">👨‍⚕️ 随诊</a>
<a class="ks-tb-link" href="https://kidneyspherefollowup.cn/">📋 记录</a>
<a class="ks-tb-link" href="https://kidneyspheredoctorapp.cn/">📱 医生</a></div>
<div style="text-align:center;padding:10px 14px;background:#deedf6;color:#19465f;font-size:12px;line-height:1.6">新版首页视觉预览 · 尚未上线 · 链接会打开当前正式网站</div>'''
    page = page.replace('<body class="registry-home">', '<body class="registry-home">' + nav, 1)
    scripts = '\n'.join((site / n).read_text() for n in ['pricing-config.js', 'collaboration-data.js', 'collaboration-components.js'])
    page = page.replace('</body>', '<script>\n' + scripts + '\n' + render + '\n</script>\n</body>')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as f:
        f.write(page)
    print(f'PREVIEW={output.resolve()}')
    print(f'SIZE={output.stat().st_size}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=pathlib.Path, required=True)
    p.add_argument('--shared-css-dir', type=pathlib.Path, required=True)
    args = p.parse_args()
    build(args.output, args.shared_css_dir)
