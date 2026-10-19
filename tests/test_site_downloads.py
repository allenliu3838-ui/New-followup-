"""网站上的 PDF 资料：页面链接、文件和发布白名单三者一致。"""
from pathlib import Path
import re
import unittest
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]


class SiteDownloadsTest(unittest.TestCase):
    def test_pdf_links(self):
        release = (ROOT / 'scripts/registry_integrated_release.py').read_text()
        linked = set()
        for page in ['guide.html', 'demo.html']:
            html = (ROOT / 'site' / page).read_text()
            linked |= {unquote(h) for h in re.findall(r'href="/(assets/[^"]+\.pdf)"', html)}
        self.assertEqual(len(linked), 4, linked)
        for rel in linked:
            with self.subTest(rel=rel):
                path = ROOT / 'site' / rel
                self.assertTrue(path.is_file(), '链接的文件必须存在')
                self.assertTrue(path.read_bytes().startswith(b'%PDF-'))
                self.assertLess(path.stat().st_size, 16 * 1024 * 1024, '发布工具单个文件上限 16 MB')
                self.assertIn(rel, release.split(), '文件必须在发布白名单中')
        on_disk = {f'assets/{p.name}' for p in (ROOT / 'site/assets').glob('*.pdf')}
        self.assertEqual(on_disk, linked, '不放没有页面链接的 PDF')


if __name__ == '__main__':
    unittest.main()
