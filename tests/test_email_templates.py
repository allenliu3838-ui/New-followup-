"""认证邮件模板（site/assets/mail-*.html）：由认证服务按网址读取，渲染后发送给用户。"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ['mail-confirm.html', 'mail-recovery.html', 'mail-magic-link.html']
ALLOWED_FIELDS = {'.ConfirmationURL', '.Email'}


class EmailTemplateTest(unittest.TestCase):
    def test_templates(self):
        release = (ROOT / 'scripts/registry_integrated_release.py').read_text()
        for name in TEMPLATES:
            with self.subTest(name=name):
                html = (ROOT / 'site/assets' / name).read_text()
                self.assertIn(f'assets/{name}', release, '模板必须在发布白名单中')
                fields = set(re.findall(r'\{\{\s*([^}]*?)\s*\}\}', html))
                self.assertLessEqual(fields, ALLOWED_FIELDS, f'只能使用认证服务提供的字段：{fields}')
                self.assertIn('href="{{ .ConfirmationURL }}"', html, '按钮必须指向确认链接')
                self.assertEqual(html.count('{{') , html.count('}}'))
                # 不加载任何外部资源：新发信域名的邮件里带图片或外链样式更容易被判为垃圾邮件。
                self.assertNotRegex(html, r'(?i)<img|<link|<script|src=|url\(')
                self.assertIn('lang="zh-CN"', html)
                self.assertIn('china@kidneysphere.com', html)


if __name__ == '__main__':
    unittest.main()
