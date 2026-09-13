"""Exercise the homepage/image release only in temporary directories."""
from contextlib import redirect_stdout
import importlib.util
import io
import itertools
import os
from pathlib import Path
import stat
import shlex
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.request
import zipfile
import zipimport

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import registry_visual_release as release
import registry_pages_release as legacy
import build_registry_visual_offline as builder


class VisualReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='registry-visual-test-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.target = self.root / 'registry'
        (self.target / 'assets').mkdir(parents=True)
        self.index = self.target / 'index.html'
        self.image = self.target / 'assets/registry-tech-hero.png'
        self.old = (ROOT / 'site/index.html').read_bytes()
        self.index.write_bytes(self.old)
        self.index.chmod(0o640)
        self.before_info = self.index.stat()
        self.backups = self.root / 'private backups'
        self.payloads = {
            'index.html': (ROOT / 'previews/registry-tech/index.html').read_bytes(),
            'assets/registry-tech-hero.png': (ROOT / 'previews/registry-tech/assets/registry-tech-hero.png').read_bytes(),
        }
        self.untouched = [self.target / 'config.js', self.target / 'collaboration.html',
                          self.target / 'assets/existing.png', self.root / 'other-site.html']
        for p in self.untouched:
            p.write_bytes(b'unrelated file ' + p.name.encode())
        self.sentinels = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.untouched}
        self.addCleanup(self.assert_untouched)
        self.stdout = io.StringIO()
        self.addCleanup(patch.stopall)
        patch.object(urllib.request, 'urlopen', side_effect=AssertionError('No network permitted')).start()

    def assert_untouched(self):
        self.assertEqual(self.sentinels, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.untouched})

    def apply(self, payloads=None):
        with redirect_stdout(self.stdout):
            return release.apply_release(self.target, self.payloads if payloads is None else payloads, self.backups)

    def rollback(self, backup):
        with redirect_stdout(self.stdout):
            return release.rollback_release(self.target, backup)

    def test_apply_rerun_rollback_preserve_unrelated_files_and_modes(self):
        backup = self.apply()
        self.assertEqual(self.index.read_bytes(), self.payloads['index.html'])
        self.assertEqual(self.image.read_bytes(), self.payloads['assets/registry-tech-hero.png'])
        info = self.index.stat()
        self.assertEqual((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid),
                         (0o640, self.before_info.st_uid, self.before_info.st_gid))
        self.assertEqual(stat.S_IMODE(self.image.stat().st_mode), 0o644)
        self.assertIsNone(self.apply())
        self.rollback(backup)
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())
        self.assertEqual(stat.S_IMODE(self.index.stat().st_mode), 0o640)
        self.rollback(backup)

    def test_unknown_homepage_refuses_before_public_writes(self):
        self.index.write_bytes(b'someone updated this page')
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), b'someone updated this page')
        self.assertFalse(self.image.exists())

    def test_existing_asset_refused_even_if_content_matches(self):
        self.image.write_bytes(self.payloads['assets/registry-tech-hero.png'])
        inode = self.image.stat().st_ino
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertEqual(self.image.stat().st_ino, inode)

    def test_wrong_payloads_refused_before_public_writes(self):
        for key in self.payloads:
            with self.subTest(key=key):
                bad = dict(self.payloads); bad[key] += b'corrupt'
                with self.assertRaises(Exception): self.apply(bad)
                self.assertEqual(self.index.read_bytes(), self.old)
                self.assertFalse(self.image.exists())

    def test_symlink_assets_directory_refused(self):
        original = self.target / 'assets'
        moved = self.root / 'outside-assets'
        original.rename(moved)
        original.symlink_to(moved, target_is_directory=True)
        try:
            with self.assertRaises(Exception): self.apply()
            self.assertEqual(self.index.read_bytes(), self.old)
            self.assertFalse((moved / self.image.name).exists())
        finally:
            original.unlink(); moved.rename(original)

    def test_index_hardlink_refused(self):
        os.link(self.index, self.root / 'index-link')
        with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_dangling_image_symlink_refused(self):
        self.image.symlink_to(self.root / 'missing-file')
        with self.assertRaises(Exception): self.apply()
        self.assertTrue(self.image.is_symlink())
        self.assertEqual(self.index.read_bytes(), self.old)

    def test_image_created_concurrently_is_not_overwritten(self):
        original = release.install_image
        def race(stage, destination):
            destination.write_bytes(b'another deploy image')
            return original(stage, destination)
        with patch.object(release, 'install_image', side_effect=race):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.image.read_bytes(), b'another deploy image')
        self.assertEqual(self.index.read_bytes(), self.old)

    def test_html_failure_restores_old_page_and_removes_owned_image(self):
        with patch.object(legacy, 'atomic_copy', side_effect=OSError('Injected HTML write failure')):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_post_image_install_failure_can_recover(self):
        original = release.install_image
        def fail_after_rename(stage, destination):
            original(stage, destination)
            raise OSError('Injected post-image fsync failure')
        with patch.object(release, 'install_image', side_effect=fail_after_rename):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_concurrent_html_change_is_retained_with_image(self):
        def concurrent_change(*args, **kwargs):
            self.index.write_bytes(b'another deployment after image installation')
            raise OSError('Concurrent deployment')
        with patch.object(legacy, 'atomic_copy', side_effect=concurrent_change):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), b'another deployment after image installation')
        self.assertEqual(self.image.read_bytes(), self.payloads['assets/registry-tech-hero.png'])

    def test_missing_image_after_install_stops_before_homepage_change(self):
        original = release.install_image
        def disappear(stage, destination):
            original(stage, destination)
            destination.unlink()
        with patch.object(release, 'install_image', side_effect=disappear):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_missing_image_after_homepage_change_triggers_recovery(self):
        original = legacy.atomic_copy
        changed = False
        def disappear(*args, **kwargs):
            nonlocal changed
            original(*args, **kwargs)
            if not changed:
                changed = True
                self.image.unlink()
        with patch.object(legacy, 'atomic_copy', side_effect=disappear):
            with self.assertRaises(Exception): self.apply()
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_post_html_replace_sync_failure_recovers_both_files(self):
        original = legacy.sync_dir
        failed = False
        def fail_once(path):
            nonlocal failed
            if Path(path) == self.target and not failed:
                failed = True
                raise OSError('Injected directory sync failure after HTML replacement')
            return original(path)
        with patch.object(legacy, 'sync_dir', side_effect=fail_once):
            with self.assertRaises(Exception): self.apply()
        self.assertTrue(failed)
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_rollback_refuses_same_content_image_with_different_inode(self):
        backup = self.apply()
        replacement = self.root / 'replacement.png'
        replacement.write_bytes(self.image.read_bytes())
        os.replace(replacement, self.image)
        with self.assertRaises(Exception): self.rollback(backup)
        self.assertEqual(self.index.read_bytes(), self.payloads['index.html'])
        self.assertTrue(self.image.exists())

    def test_manual_rollback_recovers_old_html_with_owned_image_left(self):
        backup = self.apply()
        self.index.write_bytes(self.old)
        self.rollback(backup)
        self.assertFalse(self.image.exists())
        self.assertEqual(self.index.read_bytes(), self.old)

    def test_bundle_hashes_members_corruption_and_no_network(self):
        archive = self.root / 'release package.pyz'
        builder.build_bundle(archive)
        self.assertEqual(release.load_bundled_payloads(archive), self.payloads)
        for kind in ('extra', 'corrupt', 'missing'):
            bad = self.root / (kind + '.pyz')
            with zipfile.ZipFile(archive) as src, zipfile.ZipFile(bad, 'w') as out:
                for n in src.namelist():
                    if kind == 'missing' and n == 'pages/index.html': continue
                    data = src.read(n)
                    if kind == 'corrupt' and n == 'pages/index.html': data += b'bad'
                    out.writestr(n, data)
                if kind == 'extra': out.writestr('../outside.txt', b'bad')
            with self.subTest(kind=kind):
                with self.assertRaises(Exception): release.load_bundled_payloads(bad)
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())

    def test_actual_zip_entry_check_apply_and_printed_rollback(self):
        archive = self.root / 'reviewed visual release.pyz'
        builder.build_bundle(archive)
        importer = zipimport.zipimporter(str(archive))
        loaded = {}
        with patch.dict(sys.modules):
            for name in ('registry_pages_release', 'registry_visual_release', '__main__'):
                module = types.ModuleType('zip_entry_test' if name == '__main__' else name)
                module.__file__ = importer.get_filename(name)
                module.__loader__ = importer
                exec(importer.get_code(name), module.__dict__)
                if name != '__main__': sys.modules[name] = module
                loaded[name] = module
            zip_release, entry = loaded['registry_visual_release'], loaded['__main__']
            entry.archive_path = archive
            with patch.object(zip_release, 'TARGET', self.target), patch.object(zip_release, 'BACKUPS', self.backups):
                def invoke(arguments):
                    output = io.StringIO()
                    uid = os.geteuid()
                    uids = itertools.chain([0], itertools.repeat(uid)) if arguments else itertools.repeat(uid)
                    with patch.object(sys, 'argv', [str(archive), *arguments]), patch.object(zip_release.os, 'geteuid', side_effect=uids), redirect_stdout(output):
                        entry.main()
                    return output.getvalue()
                self.assertIn('CHECK_OK', invoke([]))
                self.assertFalse(self.backups.exists())
                applied = invoke(['--apply'])
                self.assertIn('RELEASE_OK', applied)
                command = next(line.split(': ', 1)[1] for line in applied.splitlines() if line.startswith('ROLLBACK_COMMAND:'))
                parts = shlex.split(command)
                self.assertEqual(parts[:3], ['python3', str(archive), '--rollback'])
                self.assertLess(applied.index('ROLLBACK_COMMAND:'), applied.index('RELEASE_OK'))
                self.assertIn('ROLLBACK_OK', invoke(parts[2:]))
        self.assertEqual(self.index.read_bytes(), self.old)
        self.assertFalse(self.image.exists())


if __name__ == '__main__':
    unittest.main()
