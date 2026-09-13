#!/usr/bin/env python3
"""Release exactly two reviewed registry pages; never restart or reconfigure services.

Default: check current files only. --apply downloads pinned, hash-checked HTML,
backs up both originals, then replaces each file atomically. The two replacements
are NOT a single transaction: --rollback BACKUP_DIR recovers an interrupted run.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import tempfile
import urllib.request

TARGET = Path('/var/www/kidneysphere-registry')
BACKUPS = Path('/root/registry-page-releases')
SOURCE_COMMIT = '9d8528edf00f8fe7bb2ff8fd70f9a70add1a3f52'
NAMES = ('index.html', 'collaboration.html')
OLD_HASHES = {
    'index.html': '1df317b50eb330234f05e277442e2a6ff7574f0671e539ca1d076b3a4611f381',
    'collaboration.html': '07aa6cc9ddfbf31c095646f0621c8f93b8d02b0279f6e6ac4bc285667d91e494',
}
NEW_HASHES = {
    'index.html': 'abbb6ebf61ed52c6e3200cb8606a9915a2d107f449c42d2b4e5c1585a5576864',
    'collaboration.html': 'da84f9e46a193fde9d4defb285cb03a605bee0a78258adbce464c4e238a857db',
}
MAX_BYTES = 1024 * 1024


class ReleaseError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def directory(path):
    path = Path(path).absolute()
    if path.resolve(strict=True) != path or not path.is_dir():
        raise ReleaseError(f'Refusing an indirect or invalid directory: {path}')
    return path


def read_file(path):
    path = Path(path)
    directory(path.parent)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ReleaseError(f'Refusing non-regular or hard-linked file: {path}')
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ReleaseError(f'Unexpected file size: {path}')
    return data, info


def current_state(target):
    directory(target)
    return {name: digest(read_file(target / name)[0]) for name in NAMES}


def require_hash(path, expected):
    data, info = read_file(path)
    if digest(data) != expected:
        raise ReleaseError(f'Hash mismatch; no overwrite permitted: {path}')
    return info


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data):
    with open(path, 'xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def secure_backups(parent):
    parent = Path(parent).absolute()
    directory(parent.parent)
    if not parent.exists():
        parent.mkdir(mode=0o700)
    directory(parent)
    info = parent.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ReleaseError(f'Backup directory must be private and owned by this user: {parent}')
    return parent


@contextmanager
def release_lock(parent):
    parent = secure_backups(parent)
    fd = os.open(parent / 'release.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
            raise ReleaseError('Invalid release lock file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ReleaseError('Another registry page release is in progress') from exc
        yield
    finally:
        os.close(fd)


def atomic_copy(source, destination, expected_current, metadata):
    """Copy permissions/xattrs from the saved original, with a fresh mtime."""
    directory(destination.parent)
    require_hash(destination, expected_current)
    fd, tmp_name = tempfile.mkstemp(prefix='.registry-page-', dir=destination.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(read_file(source)[0])
            stream.flush()
            os.fsync(stream.fileno())
        # copystat retains ACL/xattr metadata where supported by Python/Linux.
        shutil.copystat(Path(metadata['reference']), tmp, follow_symlinks=False)
        os.chown(tmp, metadata['uid'], metadata['gid'])
        os.chmod(tmp, metadata['mode'])
        os.utime(tmp, None)
        with open(tmp, 'rb') as stream:
            os.fsync(stream.fileno())
        require_hash(tmp, metadata['expected_source'])
        # The helper lock cannot serialize an unrelated deployment tool.
        require_hash(destination, expected_current)
        os.replace(tmp, destination)
        if metadata.get('after_replace'):
            metadata['after_replace']()
        sync_dir(destination.parent)
    finally:
        if tmp.exists():
            tmp.unlink()


def rollback_release(target, backup, names=NAMES):
    target, backup = directory(target), directory(backup)
    names = tuple(names)
    if len(set(names)) != len(names) or not set(names).issubset(NAMES):
        raise ReleaseError('Unexpected rollback file list')
    manifest = json.loads(read_file(backup / 'manifest.json')[0])
    if manifest.get('target') != str(target) or manifest.get('source_commit') != SOURCE_COMMIT:
        raise ReleaseError('Backup manifest belongs to a different release or directory')
    if manifest.get('old_hashes') != OLD_HASHES or manifest.get('new_hashes') != NEW_HASHES:
        raise ReleaseError('Unexpected backup hash manifest')
    state = {name: digest(read_file(target / name)[0]) for name in names}
    # Preflight EVERY backup/current file before restoring either.
    for name in names:
        require_hash(backup / 'old' / name, OLD_HASHES[name])
        if state[name] not in (OLD_HASHES[name], NEW_HASHES[name]):
            raise ReleaseError(f'Later/unrelated change detected; rollback stopped: {name}')
    restored = []
    for name in reversed(names):
        if state[name] == OLD_HASHES[name]:
            continue
        metadata = dict(manifest['metadata'][name], reference=str(backup / 'old' / name),
                        expected_source=OLD_HASHES[name])
        atomic_copy(backup / 'old' / name, target / name, NEW_HASHES[name], metadata)
        require_hash(target / name, OLD_HASHES[name])
        restored.append(name)
    return restored


def apply_release(target, payloads, backup_parent):
    target = directory(target)
    state = current_state(target)
    if state == NEW_HASHES:
        return None
    if state != OLD_HASHES:
        raise ReleaseError('Current pages differ from the approved baseline; update stopped')
    if set(payloads) != set(NAMES):
        raise ReleaseError('Payload must contain exactly the two approved HTML pages')
    for name in NAMES:
        if digest(payloads[name]) != NEW_HASHES[name]:
            raise ReleaseError(f'Incorrect downloaded content: {name}')
    backup_parent = secure_backups(backup_parent)
    if backup_parent == target or target in backup_parent.parents:
        raise ReleaseError('Backup location must be outside the website directory')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-')
    backup = Path(tempfile.mkdtemp(prefix=stamp, dir=backup_parent))
    (backup / 'old').mkdir(mode=0o700)
    (backup / 'new').mkdir(mode=0o700)
    metadata = {}
    for name in NAMES:
        info = require_hash(target / name, OLD_HASHES[name])
        metadata[name] = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
        shutil.copy2(target / name, backup / 'old' / name, follow_symlinks=False)
        require_hash(backup / 'old' / name, OLD_HASHES[name])
        with open(backup / 'old' / name, 'rb') as stream:
            os.fsync(stream.fileno())
        write_new(backup / 'new' / name, payloads[name])
        require_hash(backup / 'new' / name, NEW_HASHES[name])
    manifest = {'target': str(target), 'source_commit': SOURCE_COMMIT,
                'old_hashes': OLD_HASHES, 'new_hashes': NEW_HASHES, 'metadata': metadata}
    write_new(backup / 'manifest.json', json.dumps(manifest, indent=2).encode())
    for folder in (backup / 'old', backup / 'new', backup, backup_parent):
        sync_dir(folder)
    print(f'BACKUP={backup}', flush=True)
    replaced = []
    try:
        if current_state(target) != OLD_HASHES:
            raise ReleaseError('Files changed while preparing backup; update stopped')
        for name in NAMES:
            saved_metadata = dict(metadata[name], reference=str(backup / 'old' / name),
                                  expected_source=NEW_HASHES[name],
                                  after_replace=lambda name=name: replaced.append(name))
            atomic_copy(backup / 'new' / name, target / name, OLD_HASHES[name], saved_metadata)
            require_hash(target / name, NEW_HASHES[name])
        if current_state(target) != NEW_HASHES:
            raise ReleaseError('Final page verification failed')
    except BaseException as exc:
        try:
            rollback_release(target, backup, names=replaced)
            print('ROLLBACK_OK: pages written by this run restored' if replaced else
                  'UPDATE_STOPPED: this run did not replace any page', flush=True)
        except Exception as recovery_error:
            print(f'ROLLBACK_STOPPED: {recovery_error}; retain {backup}', flush=True)
        raise ReleaseError(f'Update did not complete: {exc}; backup retained at {backup}') from exc
    return backup


def download_pages():
    result = {}
    for name in NAMES:
        url = f'https://raw.githubusercontent.com/allenliu3838-ui/New-followup-/{SOURCE_COMMIT}/site/{name}'
        with urllib.request.urlopen(url, timeout=20) as response:
            if response.geturl() != url:
                raise ReleaseError('Unexpected download redirect')
            data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES or digest(data) != NEW_HASHES[name]:
            raise ReleaseError(f'Download hash check failed: {name}')
        result[name] = data
    return result


def main(*, page_loader=None, command_path=None):
    """Allow a packaged entry point to supply local pages and its recovery path."""
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--rollback', type=Path, metavar='BACKUP_DIR')
    args = parser.parse_args()
    if args.rollback:
        backup = args.rollback.absolute()
        directory(backup)
        if backup.parent != BACKUPS:
            raise ReleaseError(f'Rollback backup must be directly inside {BACKUPS}')
        with release_lock(BACKUPS):
            restored = rollback_release(TARGET, backup)
        print('ROLLBACK_OK: ' + (', '.join(restored) or 'already at original version'))
    elif args.apply:
        if os.geteuid() != 0:
            raise ReleaseError('Run this fixed-path release as root')
        with release_lock(BACKUPS):
            if current_state(TARGET) == NEW_HASHES:
                print('ALREADY_APPLIED: no files changed')
                return
            if current_state(TARGET) != OLD_HASHES:
                raise ReleaseError('Baseline mismatch; no files changed')
            loader = download_pages if page_loader is None else page_loader
            backup = apply_release(TARGET, loader(), BACKUPS)
        print('RELEASE_OK: both local page hashes verified; no services restarted')
        tool_path = Path(__file__ if command_path is None else command_path).resolve()
        print(f'ROLLBACK_COMMAND: python3 {shlex.quote(str(tool_path))} --rollback {shlex.quote(str(backup))}')
        print('Public website and other-site checks remain to be completed.')
    else:
        state = current_state(TARGET)
        for name in NAMES:
            print(f'{name}: {state[name]}')
        if state not in (OLD_HASHES, NEW_HASHES):
            raise ReleaseError('Baseline mismatch; no files changed')
        print('CHECK_OK: no files changed')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        raise SystemExit(f'STOPPED: {error}')
