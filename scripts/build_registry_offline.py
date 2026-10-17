#!/usr/bin/env python3
"""Build a single offline zipapp from the reviewed helper and pinned HTML.

The resulting .pyz requires only Python 3. It neither extracts an archive into
the website nor downloads content. Keep the artifact outside the web root.
"""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts' / 'registry_pages_release.py'
ENTRY_POINT = '''"""Offline entry point; reuses the guarded two-page release implementation."""
import sys
from pathlib import Path
import zipfile
import registry_pages_release as release

archive_path = Path(sys.argv[0]).resolve()


def load_bundled_pages():
    expected_members = {'__main__.py', 'registry_pages_release.py',
                        'pages/index.html', 'pages/collaboration.html'}
    result = {}
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.namelist()
        if len(members) != len(expected_members) or set(members) != expected_members:
            raise release.ReleaseError('Unexpected or missing offline package members')
        for name in release.NAMES:
            member = archive.getinfo('pages/' + name)
            if member.file_size > release.MAX_BYTES:
                raise release.ReleaseError('Oversized offline page: ' + name)
            data = archive.read(member)
            if release.digest(data) != release.NEW_HASHES[name]:
                raise release.ReleaseError('Offline page hash mismatch: ' + name)
            result[name] = data
    return result


def main():
    release.main(page_loader=load_bundled_pages, command_path=archive_path)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        raise SystemExit(f'STOPPED: {error}')
'''


def build_bundle(output: Path) -> Path:
    output = Path(output)
    spec = importlib.util.spec_from_file_location('reviewed_registry_release', HELPER)
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    entries = {'__main__.py': ENTRY_POINT.encode(),
               'registry_pages_release.py': HELPER.read_bytes()}
    for name in release.NAMES:
        data = (ROOT / 'site' / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != release.NEW_HASHES[name]:
            raise ValueError('Local HTML differs from pinned release: ' + name)
        entries['pages/' + name] = data
    # Fixed ZIP timestamps make the same source produce the same artifact hash.
    with open(output, 'xb') as stream:
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, data in entries.items():
                info = zipfile.ZipInfo(name, date_time=(2026, 9, 13, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    artifact = build_bundle(args.output)
    print(f'{hashlib.sha256(artifact.read_bytes()).hexdigest()}  {artifact}')
