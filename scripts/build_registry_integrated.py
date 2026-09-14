#!/usr/bin/env python3
"""Build the reviewed PG17 v2 frontend package. Refuse changed/unreviewed bytes."""
from pathlib import Path
import argparse
import hashlib
import json
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from verify_recovered_release import verify
from capture_registry_database import approved_preflight_sql

def build(output):
    manifest = verify()
    entries = {'__main__.py': (ROOT / 'scripts/registry_integrated_entry.py').read_bytes()}
    for name in ['registry_integrated_release.py', 'registry_pages_release.py', 'registry_visual_release.py']:
        entries[name] = (ROOT / 'scripts' / name).read_bytes()
    entries['database-preflight.sql'] = approved_preflight_sql(ROOT).encode()
    entries['release-manifest.json'] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    for name in manifest['files']:
        entries['payload/' + name] = (ROOT / 'site' / name).read_bytes()
    with output.open('xb') as stream, zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (2026, 9, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    print(hashlib.sha256(output.read_bytes()).hexdigest() + '  ' + str(output))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
