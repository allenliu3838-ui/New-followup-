"""Verify the offline archive against temporary targets and prohibit networking."""
from contextlib import contextmanager, redirect_stdout
import importlib.util
import io
import itertools
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.request
import zipfile
import zipimport


ROOT = Path(__file__).resolve().parents[1]
MEMBERS = {"__main__.py", "registry_pages_release.py", "pages/index.html", "pages/collaboration.html"}


class RegistryOfflineBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="registry-offline-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.target = self.root / "registry"
        self.target.mkdir()
        self.backups = self.root / "release backups"
        self.old = {name: ("synthetic old " + name + "\n").encode() for name in ("index.html", "collaboration.html")}
        self.modes = {"index.html": 0o640, "collaboration.html": 0o604}
        for name, data in self.old.items():
            path = self.target / name
            path.write_bytes(data)
            path.chmod(self.modes[name])
        self.config = self.target / "config.js"
        self.config.write_bytes(b"unrelated registry configuration\n")
        self.other_site = self.root / "other-site"
        self.other_site.mkdir()
        (self.other_site / "index.html").write_bytes(b"unrelated website\n")
        self.sentinel_state = self.snapshot([self.config, self.other_site / "index.html"])
        spec = importlib.util.spec_from_file_location("registry_offline_builder_under_test", ROOT / "scripts" / "build_registry_offline.py")
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.archive = self.root / "registry reviewed pages.pyz"
        with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Offline build must not use the network")) as network:
            result = self.builder.build_bundle(self.archive)
        network.assert_not_called()
        self.assertEqual(result, self.archive)
        self.assertTrue(self.archive.is_file())

    @staticmethod
    def snapshot(paths):
        result = {}
        for path in paths:
            info = path.stat()
            result[str(path)] = (path.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        return result

    def target_snapshot(self):
        return self.snapshot(self.target / name for name in self.old)

    def assert_sentinels_unchanged(self):
        self.assertEqual(self.snapshot([self.config, self.other_site / "index.html"]), self.sentinel_state)

    @contextmanager
    def loaded_bundle(self, archive):
        """Load the archive's real entry and helper without executing its CLI guard."""
        importer = zipimport.zipimporter(str(archive))
        helper = types.ModuleType("registry_pages_release")
        helper.__file__ = importer.get_filename("registry_pages_release")
        helper.__loader__ = importer
        exec(importer.get_code("registry_pages_release"), helper.__dict__)
        entry = types.ModuleType("offline_entry_under_test")
        entry.__file__ = importer.get_filename("__main__")
        entry.__loader__ = importer
        with patch.dict(sys.modules, {"registry_pages_release": helper}):
            with patch.object(sys, "argv", [str(archive)]):
                exec(importer.get_code("__main__"), entry.__dict__)
            with patch.object(helper, "TARGET", self.target), patch.object(helper, "BACKUPS", self.backups):
                with patch.object(helper, "OLD_HASHES", {name: helper.digest(data) for name, data in self.old.items()}):
                    yield entry, helper

    def invoke(self, entry, helper, archive, arguments):
        stdout = io.StringIO()
        real_uid = os.geteuid()
        # Only the CLI root guard is simulated. Ownership checks continue to
        # see the real owner of the temporary files, including for nonroot CI.
        uid_values = itertools.chain([0], itertools.repeat(real_uid)) if arguments == ["--apply"] else itertools.repeat(real_uid)
        with patch.object(sys, "argv", [str(archive), *arguments]):
            with patch.object(helper.os, "geteuid", side_effect=uid_values):
                with redirect_stdout(stdout):
                    entry.main()
        return stdout.getvalue()

    def rewritten_archive(self, *, omit=None, replace=None):
        rewritten = self.root / "modified-registry-pages.pyz"
        with zipfile.ZipFile(self.archive) as source, zipfile.ZipFile(rewritten, "w") as target:
            for name in source.namelist():
                if name == omit:
                    continue
                data = replace[1] if replace is not None and name == replace[0] else source.read(name)
                target.writestr(name, data)
        return rewritten

    def test_bundle_contains_exact_reviewed_pages_and_helper(self):
        with zipfile.ZipFile(self.archive) as bundle:
            self.assertEqual(set(bundle.namelist()), MEMBERS)
            self.assertEqual(len(bundle.namelist()), len(MEMBERS), "Archive must not contain duplicate members")
            self.assertEqual(bundle.read("registry_pages_release.py"), (ROOT / "scripts" / "registry_pages_release.py").read_bytes())
            for name in self.old:
                self.assertEqual(bundle.read("pages/" + name), (ROOT / "site" / name).read_bytes())
        with self.loaded_bundle(self.archive) as (entry, helper):
            with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Offline loader must not use the network")) as network:
                pages = entry.load_bundled_pages()
            network.assert_not_called()
            self.assertEqual(set(pages), set(self.old))
            self.assertEqual({name: helper.digest(data) for name, data in pages.items()}, helper.NEW_HASHES)

    def test_offline_main_applies_prints_archive_rollback_and_restores(self):
        original = self.target_snapshot()
        with self.loaded_bundle(self.archive) as (entry, helper):
            with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Offline release must not use the network")) as network:
                output = self.invoke(entry, helper, self.archive, ["--apply"])
                self.assertIn("RELEASE_OK", output)
                backup_dirs = [path for path in self.backups.iterdir() if path.is_dir()]
                self.assertEqual(len(backup_dirs), 1)
                backup = backup_dirs[0]
                rollback_command = shlex.join(["python3", str(self.archive), "--rollback", str(backup)])
                self.assertIn("ROLLBACK_COMMAND: " + rollback_command, output)
                self.assertNotIn(str(self.archive) + "/registry_pages_release.py --rollback", output)
                for name in self.old:
                    self.assertEqual(helper.digest((self.target / name).read_bytes()), helper.NEW_HASHES[name])
                    self.assertEqual(stat.S_IMODE((self.target / name).stat().st_mode), self.modes[name])
                self.assert_sentinels_unchanged()
                rollback_output = self.invoke(entry, helper, self.archive, ["--rollback", str(backup)])
                self.assertIn("ROLLBACK_OK", rollback_output)
            network.assert_not_called()
        self.assertEqual(self.target_snapshot(), original)
        self.assert_sentinels_unchanged()

    def assert_bad_payload_cannot_write_target(self, archive):
        original = self.target_snapshot()
        with self.loaded_bundle(archive) as (entry, helper):
            with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Payload rejection must not use the network")) as network:
                with patch.object(helper, "atomic_copy", wraps=helper.atomic_copy) as atomic_copy:
                    with self.assertRaises(helper.ReleaseError):
                        self.invoke(entry, helper, archive, ["--apply"])
            network.assert_not_called()
            atomic_copy.assert_not_called()
        self.assertEqual(self.target_snapshot(), original)
        self.assert_sentinels_unchanged()

    def test_tampered_payload_is_rejected_before_any_target_write(self):
        archive = self.rewritten_archive(replace=("pages/collaboration.html", b"unreviewed replacement\n"))
        self.assert_bad_payload_cannot_write_target(archive)

    def test_missing_payload_is_rejected_before_any_target_write(self):
        archive = self.rewritten_archive(omit="pages/collaboration.html")
        self.assert_bad_payload_cannot_write_target(archive)


if __name__ == "__main__":
    unittest.main()
