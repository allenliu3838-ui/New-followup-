#!/usr/bin/env python3
"""Build the guarded homepage/illustration offline zipapp from reviewed sources."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'
PREVIEW = ROOT / 'previews' / 'registry-tech'
ENTRY_POINT = '''"""Offline homepage release: fixed destination, no downloads or extraction."""
from pathlib import Path
import sys
import registry_visual_release as release

archive_path = Path(sys.argv[0]).resolve()


def main():
    release.main(payload_loader=lambda: release.load_bundled_payloads(archive_path),
                 command_path=archive_path)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        raise SystemExit(f'STOPPED: {error}')
'''


def build_bundle(output: Path) -> Path:
    output = Path(output)
    # Match runtime imports without changing the already-vetted legacy helper.
    added_path = str(SCRIPTS) not in sys.path
    if added_path:
        sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location('reviewed_visual_release', SCRIPTS / 'registry_visual_release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
    finally:
        if added_path:
            sys.path.remove(str(SCRIPTS))
    payloads = {name: (PREVIEW / name).read_bytes() for name in release.HASHES}
    release.validate_payloads(payloads)
    entries = {'__main__.py': ENTRY_POINT.encode(),
               'registry_pages_release.py': (SCRIPTS / 'registry_pages_release.py').read_bytes(),
               'registry_visual_release.py': (SCRIPTS / 'registry_visual_release.py').read_bytes(),
               'pages/index.html': payloads[release.INDEX], release.IMAGE: payloads[release.IMAGE]}
    if set(entries) != release.MEMBERS:
        raise ValueError('Unexpected offline package members')
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
    artifact = build_bundle(parser.parse_args().output)
    print(f'{hashlib.sha256(artifact.read_bytes()).hexdigest()}  {artifact}')
