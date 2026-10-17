#!/usr/bin/env python3
"""Offline, fixed-scope homepage and illustration update; default is check-only."""
from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import tempfile
import zipfile

import registry_pages_release as legacy

ReleaseError = legacy.ReleaseError
TARGET = Path('/var/www/kidneysphere-registry')
BACKUPS = Path('/root/registry-visual-releases')
SOURCE_COMMIT = 'b8eb79250a4a20360f2046b4884351c6b2db2116'
INDEX = 'index.html'
IMAGE = 'assets/registry-tech-hero.png'
OLD_INDEX_HASH = 'abbb6ebf61ed52c6e3200cb8606a9915a2d107f449c42d2b4e5c1585a5576864'
NEW_INDEX_HASH = '68a3492147c3495d071d2c3b79c42dfcdb464b894042ac6b60ab3f2c99ebcd06'
IMAGE_HASH = '120433c30d6b2de5259d90935ba2a14eaf45c9537dcc5169199f1b3eb806fc11'
HASHES = {INDEX: NEW_INDEX_HASH, IMAGE: IMAGE_HASH}
LIMITS = {INDEX: 128 * 1024, IMAGE: 8 * 1024 * 1024}
MEMBERS = {'__main__.py', 'registry_pages_release.py', 'registry_visual_release.py',
           'pages/index.html', IMAGE}


def read_limited(path, limit):
    path = Path(path)
    legacy.directory(path.parent)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ReleaseError(f'Refusing non-regular or hard-linked file: {path}')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ReleaseError(f'Unexpected file size: {path}')
    return data, info


def identity(info):
    return [info.st_dev, info.st_ino]


def file_state(path, name):
    try:
        data, info = read_limited(path, LIMITS[name])
    except FileNotFoundError:
        return None
    return legacy.digest(data), identity(info)


def state(target):
    target = legacy.directory(target)
    legacy.directory(target / 'assets')
    return file_state(target / INDEX, INDEX), file_state(target / IMAGE, IMAGE)


def validate_payloads(payloads):
    if set(payloads) != set(HASHES):
        raise ReleaseError('Payload must contain exactly the approved homepage and image')
    for name, data in payloads.items():
        if len(data) > LIMITS[name] or legacy.digest(data) != HASHES[name]:
            raise ReleaseError(f'Payload size or hash mismatch: {name}')


def load_bundled_payloads(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(MEMBERS) or set(names) != MEMBERS:
            raise ReleaseError('Unexpected or missing offline package members')
        payloads = {}
        for name in HASHES:
            item = archive.getinfo('pages/' + name if name == INDEX else name)
            if item.file_size > LIMITS[name]:
                raise ReleaseError(f'Oversized bundled file: {name}')
            payloads[name] = archive.read(item)
    validate_payloads(payloads)
    return payloads


def install_image(stage, destination):
    """Atomic creation only: an existing asset is never overwritten."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise ReleaseError('Atomic no-clobber rename unavailable; update stopped')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(stage), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            raise ReleaseError('Atomic no-clobber rename unsupported; update stopped')
        raise OSError(error, os.strerror(error), str(destination))
    legacy.sync_dir(destination.parent)


def owned_asset(path, manifest):
    actual = file_state(path, IMAGE)
    if actual is not None and actual != (IMAGE_HASH, manifest['image_identity']):
        raise ReleaseError(f'Unrelated or modified asset; recovery stopped: {path}')
    return actual


def rollback_release(target, backup, *, _automatic=False, _owned_index=None):
    target, backup = legacy.directory(target), legacy.directory(backup)
    legacy.directory(target / 'assets')
    info = backup.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ReleaseError('Recovery backup must be private and owned by this user')
    manifest = json.loads(legacy.read_file(backup / 'manifest.json')[0])
    if (manifest.get('target') != str(target) or manifest.get('source_commit') != SOURCE_COMMIT
            or manifest.get('old_index_hash') != OLD_INDEX_HASH or manifest.get('hashes') != HASHES):
        raise ReleaseError('Backup manifest belongs to a different target or release')
    stage_name = manifest.get('image_stage', '')
    planned = manifest.get('image_identity')
    if (not isinstance(stage_name, str) or not stage_name.startswith('.registry-visual-')
            or Path(stage_name).name != stage_name or not isinstance(planned, list)
            or len(planned) != 2 or not all(type(value) is int and value >= 0 for value in planned)):
        raise ReleaseError('Invalid planned image identity in backup')
    old = backup / 'old' / INDEX
    legacy.require_hash(old, OLD_INDEX_HASH)
    current, _ = state(target)
    if current is None or current[0] not in (OLD_INDEX_HASH, NEW_INDEX_HASH):
        raise ReleaseError('Later/unrelated homepage change; recovery stopped')
    if _automatic and ((_owned_index is None and current[0] != OLD_INDEX_HASH)
                       or (_owned_index is not None and current[1] != _owned_index)):
        raise ReleaseError('Homepage was changed by another writer; automatic recovery stopped')
    image_path, stage = target / IMAGE, target / 'assets' / stage_name
    owned_asset(image_path, manifest)
    owned_asset(stage, manifest)
    restored = []
    if current[0] == NEW_INDEX_HASH:
        metadata = dict(manifest['metadata'], reference=str(old), expected_source=OLD_INDEX_HASH)
        legacy.atomic_copy(old, target / INDEX, NEW_INDEX_HASH, metadata)
        restored.append(INDEX)
    legacy.require_hash(target / INDEX, OLD_INDEX_HASH)
    # Check again immediately before deletion; never remove another writer's file.
    for path in (image_path, stage):
        if owned_asset(path, manifest) is not None:
            legacy.require_hash(target / INDEX, OLD_INDEX_HASH)
            path.unlink()
            legacy.sync_dir(path.parent)
            restored.append(str(path.relative_to(target)))
    return restored


def apply_release(target, payloads, backup_parent, *, command_path=None):
    validate_payloads(payloads)
    target = legacy.directory(target)
    current, asset = state(target)
    if current is not None and current[0] == NEW_INDEX_HASH and asset is not None and asset[0] == IMAGE_HASH:
        return None
    if current is None or current[0] != OLD_INDEX_HASH or asset is not None:
        raise ReleaseError('Homepage baseline or image absence check failed; update stopped')
    backup_parent = Path(backup_parent).absolute()
    if backup_parent == target or target in backup_parent.parents:
        raise ReleaseError('Backup must be outside the website directory')
    backup_parent = legacy.secure_backups(backup_parent)
    backup = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=backup_parent))
    (backup / 'old').mkdir(mode=0o700)
    (backup / 'new').mkdir(mode=0o700)
    info = legacy.require_hash(target / INDEX, OLD_INDEX_HASH)
    metadata = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
    old = backup / 'old' / INDEX
    shutil.copy2(target / INDEX, old, follow_symlinks=False)
    legacy.require_hash(old, OLD_INDEX_HASH)
    with open(old, 'rb') as stream:
        os.fsync(stream.fileno())
    legacy.write_new(backup / 'new' / INDEX, payloads[INDEX])
    legacy.write_new(backup / 'new' / 'registry-tech-hero.png', payloads[IMAGE])
    for folder in (backup / 'old', backup / 'new', backup, backup_parent):
        legacy.sync_dir(folder)
    stage, manifest_written, own_index = None, False, None
    try:
        fd, stage_name = tempfile.mkstemp(prefix='.registry-visual-', dir=target / 'assets')
        stage = Path(stage_name)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payloads[IMAGE])
            os.fchmod(stream.fileno(), 0o644)
            stream.flush()
            os.fsync(stream.fileno())
        image_data, image_info = read_limited(stage, LIMITS[IMAGE])
        if legacy.digest(image_data) != IMAGE_HASH:
            raise ReleaseError('Staged illustration hash mismatch')
        manifest = {'target': str(target), 'source_commit': SOURCE_COMMIT,
                    'old_index_hash': OLD_INDEX_HASH, 'hashes': HASHES, 'metadata': metadata,
                    'image_stage': stage.name, 'image_identity': identity(image_info)}
        legacy.write_new(backup / 'manifest.json', json.dumps(manifest, indent=2).encode())
        for folder in (backup, backup_parent, stage.parent):
            legacy.sync_dir(folder)
        manifest_written = True
        print(f'BACKUP={backup}', flush=True)
        tool = Path(command_path or '/root/registry-tech-offline-20260913.pyz').resolve()
        print(f'ROLLBACK_COMMAND: python3 {shlex.quote(str(tool))} --rollback {shlex.quote(str(backup))}', flush=True)
        if state(target) != (current, None):
            raise ReleaseError('Website changed while preparing backup; update stopped')
        if owned_asset(stage, manifest) is None:
            raise ReleaseError('Staged image is missing')
        install_image(stage, target / IMAGE)
        if owned_asset(target / IMAGE, manifest) is None:
            raise ReleaseError('Installed image is missing')

        def remember_index():
            nonlocal own_index
            own_index = identity((target / INDEX).stat(follow_symlinks=False))

        legacy.atomic_copy(backup / 'new' / INDEX, target / INDEX, OLD_INDEX_HASH,
                           dict(metadata, reference=str(old), expected_source=NEW_INDEX_HASH,
                                after_replace=remember_index))
        legacy.require_hash(target / INDEX, NEW_INDEX_HASH)
        if owned_asset(target / IMAGE, manifest) is None:
            raise ReleaseError('Installed image is missing')
    except BaseException as exc:
        if manifest_written:
            try:
                rollback_release(target, backup, _automatic=True, _owned_index=own_index)
                print('ROLLBACK_OK: this run restored the original homepage and removed its image', flush=True)
            except Exception as recovery_error:
                print(f'ROLLBACK_STOPPED: {recovery_error}; retain {backup}', flush=True)
        elif stage is not None:
            # A pre-manifest failure cannot have published the asset or homepage.
            print(f'UPDATE_STOPPED: unpublished staging file retained at {stage}', flush=True)
        raise ReleaseError(f'Update did not complete: {exc}; backup retained at {backup}') from exc
    return backup


def main(*, payload_loader=None, command_path=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--apply', action='store_true')
    actions.add_argument('--rollback', type=Path, metavar='BACKUP_DIR')
    args = parser.parse_args()
    if args.apply or args.rollback:
        if os.geteuid() != 0:
            raise ReleaseError('Run this fixed-path release as root')
    if args.rollback:
        backup = args.rollback.absolute()
        legacy.directory(backup)
        if backup.parent != BACKUPS:
            raise ReleaseError(f'Rollback backup must be directly inside {BACKUPS}')
        with legacy.release_lock(BACKUPS):
            restored = rollback_release(TARGET, backup)
        print('ROLLBACK_OK: ' + (', '.join(restored) or 'already at original version'))
    elif args.apply:
        if payload_loader is None:
            raise ReleaseError('Run the complete offline .pyz package; no online fallback exists')
        payloads = payload_loader()
        with legacy.release_lock(BACKUPS):
            backup = apply_release(TARGET, payloads, BACKUPS, command_path=command_path)
        if backup is None:
            print('ALREADY_APPLIED: no website files changed')
            return
        print('RELEASE_OK: homepage and image verified; no services restarted')
        tool = Path(command_path or __file__).resolve()
        print(f'ROLLBACK_COMMAND: python3 {shlex.quote(str(tool))} --rollback {shlex.quote(str(backup))}')
        print('Public website checks remain to be completed.')
    else:
        current, asset = state(TARGET)
        if not (current and ((current[0] == OLD_INDEX_HASH and asset is None)
                             or (current[0] == NEW_INDEX_HASH and asset and asset[0] == IMAGE_HASH))):
            raise ReleaseError('Homepage/image state differs from the reviewed release')
        print(f'{INDEX}: {current[0]}')
        print(f'{IMAGE}: {asset[0] if asset else "absent"}')
        print('CHECK_OK: no files changed')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        raise SystemExit(f'STOPPED: {error}')
