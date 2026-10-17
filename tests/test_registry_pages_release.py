"""Exercise page releases exclusively against synthetic temporary files.

No test uses the production TARGET, invokes the CLI, or accesses the network.
"""
from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import signal
import stat
import tempfile
import unittest
from unittest.mock import patch


_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "registry_pages_release.py"
_SPEC = importlib.util.spec_from_file_location("registry_pages_release_under_test", _SCRIPT)
release = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release)


class RegistryPageReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="registry-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.target = self.root / "registry"
        self.target.mkdir()
        self.backups = self.root / "backups"
        self.old = {name: ("old synthetic " + name + "\n").encode() for name in release.NAMES}
        self.new = {name: ("new synthetic " + name + "\n").encode() for name in release.NAMES}
        self.modes = dict(zip(release.NAMES, (0o640, 0o604)))
        self.old_hashes = {name: release.digest(data) for name, data in self.old.items()}
        self.new_hashes = {name: release.digest(data) for name, data in self.new.items()}
        self.addCleanup(patch.stopall)
        patch.object(release, "OLD_HASHES", self.old_hashes).start()
        patch.object(release, "NEW_HASHES", self.new_hashes).start()
        # A network attempt is a test failure even if a future implementation
        # accidentally introduces one into an otherwise local helper.
        patch.object(release.urllib.request, "urlopen", side_effect=AssertionError("Network access forbidden in filesystem tests")).start()
        self.stdout = io.StringIO()
        self._stdout_redirect = redirect_stdout(self.stdout)
        self._stdout_redirect.__enter__()
        self.addCleanup(self._stdout_redirect.__exit__, None, None, None)
        for name in release.NAMES:
            path = self.target / name
            path.write_bytes(self.old[name])
            path.chmod(self.modes[name])
        self.sentinels = [self.target / "config.js"]
        for site in ("portal", "doctor", "followup", "remote"):
            directory = self.root / site
            directory.mkdir()
            self.sentinels.append(directory / "index.html")
        for index, path in enumerate(self.sentinels):
            path.write_bytes(("untouched synthetic sentinel %d\n" % index).encode())
            path.chmod(0o600)
        self.sentinel_state = self.snapshot(self.sentinels)

    def snapshot(self, paths):
        """Capture content, permissions, ownership, and link state without following links."""
        result = {}
        for path in paths:
            path = Path(path)
            if not path.exists() and not path.is_symlink():
                result[str(path)] = None
                continue
            info = path.lstat()
            content = os.readlink(path) if stat.S_ISLNK(info.st_mode) else path.read_bytes()
            result[str(path)] = (content, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, info.st_nlink)
        return result

    def target_snapshot(self):
        return self.snapshot(self.target / name for name in release.NAMES)

    def assert_sentinels_unchanged(self):
        self.assertEqual(self.snapshot(self.sentinels), self.sentinel_state)

    def assert_pages(self, expected):
        for name in release.NAMES:
            with self.subTest(page=name):
                path = self.target / name
                self.assertFalse(path.is_symlink())
                self.assertEqual(path.read_bytes(), expected[name])
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), self.modes[name])
                self.assertEqual(path.stat().st_uid, os.geteuid())
                self.assertEqual(path.stat().st_gid, os.getegid())
        self.assert_sentinels_unchanged()

    def apply(self, payloads=None):
        return release.apply_release(self.target, self.new if payloads is None else payloads, self.backups)

    def assert_rejected_apply_unchanged(self, payloads=None, extra_paths=()):
        before = self.target_snapshot()
        extra_before = self.snapshot(extra_paths)
        with self.assertRaises((release.ReleaseError, OSError)):
            self.apply(payloads)
        self.assertEqual(self.target_snapshot(), before)
        self.assertEqual(self.snapshot(extra_paths), extra_before)
        self.assert_sentinels_unchanged()
        self.assertFalse(self.backups.exists(), "Preflight rejection should not create a release backup")

    def test_success_rerun_and_rollback_preserve_modes_and_unrelated_sites(self):
        original = self.target_snapshot()
        backup = self.apply()
        self.assertIsInstance(backup, Path)
        self.assertEqual(backup.parent, self.backups)
        self.assertTrue((backup / "manifest.json").is_file())
        self.assert_pages(self.new)
        self.assertEqual(stat.S_IMODE(self.backups.stat().st_mode), 0o700)
        for name in release.NAMES:
            self.assertEqual((backup / "old" / name).read_bytes(), self.old[name])
            self.assertEqual((backup / "new" / name).read_bytes(), self.new[name])
        before_rerun = self.target_snapshot()
        backup_entries = set(self.backups.iterdir())
        self.assertIsNone(self.apply())
        self.assertEqual(self.target_snapshot(), before_rerun)
        self.assertEqual(set(self.backups.iterdir()), backup_entries)
        self.assertEqual(release.rollback_release(self.target, backup), list(reversed(release.NAMES)))
        self.assertEqual(self.target_snapshot(), original)
        self.assert_pages(self.old)
        self.assertEqual(release.rollback_release(self.target, backup), [])
        self.assertEqual(self.target_snapshot(), original)

    def test_wrong_existing_hash_rejects_before_either_page_is_replaced(self):
        (self.target / release.NAMES[1]).write_bytes(b"unrelated later edit\n")
        self.assert_rejected_apply_unchanged()

    def test_wrong_payload_rejects_before_either_page_is_replaced(self):
        wrong = dict(self.new)
        wrong[release.NAMES[1]] = b"unapproved payload\n"
        self.assert_rejected_apply_unchanged(wrong)

    def test_missing_payload_rejects_before_either_page_is_replaced(self):
        self.assert_rejected_apply_unchanged({release.NAMES[0]: self.new[release.NAMES[0]]})

    def test_extra_payload_rejects_before_either_page_is_replaced(self):
        extra = dict(self.new, **{"config.js": b"unapproved configuration\n"})
        self.assert_rejected_apply_unchanged(extra)

    def test_missing_target_rejects_before_other_page_is_replaced(self):
        (self.target / release.NAMES[1]).unlink()
        self.assert_rejected_apply_unchanged()

    def test_symlink_target_rejects_and_leaves_link_destination_untouched(self):
        page = self.target / release.NAMES[1]
        outside = self.root / "external-page.html"
        outside.write_bytes(self.old[release.NAMES[1]])
        page.unlink()
        page.symlink_to(outside)
        self.assert_rejected_apply_unchanged(extra_paths=[outside])

    def test_hardlink_target_rejects_and_leaves_other_link_untouched(self):
        outside = self.root / "external-hardlink.html"
        os.link(self.target / release.NAMES[1], outside)
        self.assert_rejected_apply_unchanged(extra_paths=[outside])

    def test_second_replacement_failure_rolls_back_first_and_keeps_backup(self):
        original = self.target_snapshot()
        real_atomic_copy = release.atomic_copy
        calls = []

        def fail_second_copy(source, destination, expected_current, metadata):
            calls.append((Path(source), Path(destination)))
            if len(calls) == 2:
                self.assertEqual((self.target / release.NAMES[0]).read_bytes(), self.new[release.NAMES[0]])
                self.assertEqual((self.target / release.NAMES[1]).read_bytes(), self.old[release.NAMES[1]])
                raise OSError("injected failure on second replacement")
            return real_atomic_copy(source, destination, expected_current, metadata)

        with patch.object(release, "atomic_copy", side_effect=fail_second_copy):
            with self.assertRaises(release.ReleaseError):
                self.apply()
        self.assertEqual(len(calls), 3, "Two attempted release copies plus one restoring copy")
        self.assertEqual(self.target_snapshot(), original)
        self.assert_pages(self.old)
        backups = list(self.backups.iterdir())
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / "manifest.json").is_file())
        self.assertIn("ROLLBACK_OK", self.stdout.getvalue())

    def test_interrupted_one_new_one_old_release_can_be_recovered(self):
        backup = self.apply()
        # Reconstruct the on-disk state of a hard stop between the two replaces;
        # the recovery API must work without the original Python process.
        (self.target / release.NAMES[1]).write_bytes(self.old[release.NAMES[1]])
        mixed = self.target_snapshot()
        with self.assertRaises(release.ReleaseError):
            self.apply()
        self.assertEqual(self.target_snapshot(), mixed)
        self.assertEqual(release.rollback_release(self.target, backup), [release.NAMES[0]])
        self.assert_pages(self.old)

    def test_third_hash_blocks_all_rollback_writes(self):
        backup = self.apply()
        (self.target / release.NAMES[0]).write_bytes(b"later independent edit\n")
        before = self.target_snapshot()
        with self.assertRaises(release.ReleaseError):
            release.rollback_release(self.target, backup)
        self.assertEqual(self.target_snapshot(), before)
        self.assert_sentinels_unchanged()

    def test_corrupt_backup_blocks_all_rollback_writes(self):
        backup = self.apply()
        # First page is deliberately corrupt: a restore loop that checked each
        # file only when replacing it would overwrite the second page first.
        (backup / "old" / release.NAMES[0]).write_bytes(b"corrupt saved original\n")
        before = self.target_snapshot()
        with self.assertRaises(release.ReleaseError):
            release.rollback_release(self.target, backup)
        self.assertEqual(self.target_snapshot(), before)
        self.assert_sentinels_unchanged()

    def test_preflight_concurrent_new_page_is_not_rolled_back_by_this_run(self):
        real_current_state = release.current_state
        state_calls = 0

        def concurrent_change_after_backup(target):
            nonlocal state_calls
            state_calls += 1
            if state_calls == 2:
                self.assertTrue(any(self.backups.glob("*/manifest.json")))
                (self.target / release.NAMES[0]).write_bytes(self.new[release.NAMES[0]])
            return real_current_state(target)

        with patch.object(release, "current_state", side_effect=concurrent_change_after_backup):
            with patch.object(release, "atomic_copy", wraps=release.atomic_copy) as copy:
                with self.assertRaises(release.ReleaseError):
                    self.apply()
        copy.assert_not_called()
        self.assertEqual((self.target / release.NAMES[0]).read_bytes(), self.new[release.NAMES[0]])
        self.assertEqual((self.target / release.NAMES[1]).read_bytes(), self.old[release.NAMES[1]])
        self.assert_sentinels_unchanged()

    def _assert_other_second_page_change_does_not_block_own_first_page_recovery(self, delete_second):
        real_atomic_copy = release.atomic_copy
        calls = []
        independent_content = b"independent editor's later content\n"
        first, second = (self.target / name for name in release.NAMES)

        def change_second_page_during_update(source, destination, expected_current, metadata):
            calls.append(Path(destination))
            if len(calls) == 2:
                self.assertEqual(first.read_bytes(), self.new[release.NAMES[0]])
                if delete_second:
                    second.unlink()
                else:
                    second.write_bytes(independent_content)
            return real_atomic_copy(source, destination, expected_current, metadata)

        with patch.object(release, "atomic_copy", side_effect=change_second_page_during_update):
            with self.assertRaises(release.ReleaseError):
                self.apply()
        self.assertEqual(first.read_bytes(), self.old[release.NAMES[0]])
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), self.modes[release.NAMES[0]])
        if delete_second:
            self.assertFalse(second.exists(), "Recovery must not recreate an independently deleted page")
        else:
            self.assertEqual(second.read_bytes(), independent_content)
        self.assertEqual(calls, [first, second, first])
        self.assertIn("ROLLBACK_OK", self.stdout.getvalue())
        self.assert_sentinels_unchanged()

    def test_concurrent_third_hash_on_second_page_allows_own_first_page_recovery(self):
        self._assert_other_second_page_change_does_not_block_own_first_page_recovery(False)

    def test_concurrent_second_page_deletion_allows_own_first_page_recovery(self):
        self._assert_other_second_page_change_does_not_block_own_first_page_recovery(True)

    def test_directory_fsync_failure_after_replace_still_restores_replaced_page(self):
        original = self.target_snapshot()
        real_sync_dir = release.sync_dir
        destination_syncs = 0
        state_at_failed_sync = {}

        def fail_first_destination_sync(path):
            nonlocal destination_syncs
            if Path(path) == self.target:
                destination_syncs += 1
                if destination_syncs == 1:
                    state_at_failed_sync.update({name: (self.target / name).read_bytes() for name in release.NAMES})
                    raise OSError("injected directory fsync failure after os.replace")
            return real_sync_dir(path)

        with patch.object(release, "sync_dir", side_effect=fail_first_destination_sync):
            with self.assertRaises(release.ReleaseError):
                self.apply()
        self.assertEqual(destination_syncs, 2, "The replaced page must trigger a restoring copy and directory sync")
        self.assertEqual(state_at_failed_sync, {release.NAMES[0]: self.new[release.NAMES[0]], release.NAMES[1]: self.old[release.NAMES[1]]})
        self.assertEqual(self.target_snapshot(), original)
        self.assert_pages(self.old)
        self.assertIn("ROLLBACK_OK", self.stdout.getvalue())

    def test_corrupted_prepared_new_file_is_rejected_before_os_replace(self):
        original = self.target_snapshot()
        real_atomic_copy = release.atomic_copy
        copies = 0
        supplied_source_hashes = []

        def corrupt_prepared_source(source, destination, expected_current, metadata):
            nonlocal copies
            copies += 1
            if copies == 1:
                supplied_source_hashes.append(metadata.get("expected_source"))
                Path(source).write_bytes(b"tampered prepared payload\n")
            return real_atomic_copy(source, destination, expected_current, metadata)

        with patch.object(release, "atomic_copy", side_effect=corrupt_prepared_source):
            with patch.object(release.os, "replace", wraps=release.os.replace) as replace:
                with self.assertRaises(release.ReleaseError):
                    self.apply()
        replace.assert_not_called()
        self.assertEqual(supplied_source_hashes, [self.new_hashes[release.NAMES[0]]])
        self.assertEqual(copies, 1, "No restoring copy should be needed when source validation rejects before replacement")
        self.assertEqual(self.target_snapshot(), original)
        self.assert_pages(self.old)

    @unittest.skipUnless(hasattr(signal, "setitimer") and hasattr(os, "mkfifo"), "Requires POSIX FIFO and interval timer")
    def test_fifo_target_is_rejected_without_blocking_or_replacing_other_page(self):
        first, fifo = (self.target / name for name in release.NAMES)
        first_before = self.snapshot([first])
        fifo.unlink()
        os.mkfifo(fifo, mode=0o600)

        def fail_on_blocked_fifo(signum, frame):
            raise AssertionError("Opening a FIFO target blocked instead of rejecting it immediately")

        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        signal.signal(signal.SIGALRM, fail_on_blocked_fifo)
        signal.setitimer(signal.ITIMER_REAL, 0.5)
        try:
            with self.assertRaises(release.ReleaseError):
                self.apply()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            if previous_timer != (0.0, 0.0):
                signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        self.assertTrue(stat.S_ISFIFO(fifo.lstat().st_mode))
        self.assertEqual(self.snapshot([first]), first_before)
        self.assert_sentinels_unchanged()
        self.assertFalse(self.backups.exists())


if __name__ == "__main__":
    unittest.main()
