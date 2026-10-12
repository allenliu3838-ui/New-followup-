#!/usr/bin/env python3
"""Pin a new reviewed release identity from the current source tree.

Run only after the source changes have been reviewed. It recomputes, never relaxes:
  1. supabase/migration-manifest.json and the generated all_migrations_combined.sql
  2. supabase/database-contract-pg17.json (native PG17 rebuild; skip with --no-contract)
  3. the release manifest and reviewed-tool hashes under releases/<release dir>/

Production baselines (old_sha256) are inherited from the previous reviewed manifest, because
that release was never deployed and production still serves the same bytes. Files new to the
release get old_sha256 = None, exactly as the previous manifest records new files.
CI must only verify (npm test); it must never run this script.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import registry_integrated_release as release  # noqa: E402

RELEASE_DIR = ROOT / 'releases/registry-adoption-v4-20261012'
MANIFEST_NAME = 'registry-adoption-v4-20261012.manifest.json'
PREVIOUS = ROOT / 'releases/registry-integrated-pg17-v3-20260914/registry-integrated-pg17-v3-20260914.manifest.json'
TOOLS = ['build_database_contract_pg17.mjs', 'registry_integrated_release.py', 'registry_pages_release.py', 'registry_visual_release.py']
BUNDLE_HEADER = '-- GENERATED from supabase/migrations in canonical filename order.\n-- Fresh/isolated databases only; use reviewed increments for production.\n\n'
ORDER = 'lexicographic filenames; historical duplicate prefixes retained, unique full filenames'
FIRST_INCREMENT = 32


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def migration_manifest() -> dict:
    files = sorted(p.name for p in (ROOT / 'supabase/migrations').glob('*.sql'))
    if len(files) != len(set(files)):
        raise SystemExit('duplicate migration filenames')
    entries = [{'ordinal': i + 1, 'file': f, 'sha256': sha((ROOT / 'supabase/migrations' / f).read_bytes())} for i, f in enumerate(files)]
    bundle = BUNDLE_HEADER + ''.join(
        f'-- MIGRATION {m["ordinal"]:03d}: {m["file"]}\n' + (ROOT / 'supabase/migrations' / m['file']).read_text() + '\n' for m in entries)
    bundle = bundle.rstrip() + '\n'
    (ROOT / 'all_migrations_combined.sql').write_text(bundle)
    increments = [f[:-4] for f in files if int(f[:4]) >= FIRST_INCREMENT]
    for version in increments:
        text = (ROOT / 'supabase/migrations' / f'{version}.sql').read_text()
        if f"'{version}'" not in text:
            raise SystemExit(f'{version}.sql does not register its schema version')
    manifest = {'format': 1, 'release': release.VERSION, 'required_versions': increments, 'order': ORDER,
                'bundle_sha256': sha(bundle.encode()), 'migrations': entries}
    write_json(ROOT / 'supabase/migration-manifest.json', manifest)
    return manifest


def preflight_check_names() -> list:
    text = (ROOT / 'scripts/database_preflight.sql.in').read_text()
    if f"'release','{release.VERSION}'" not in text:
        raise SystemExit('preflight release literal does not match registry_integrated_release.VERSION')
    block = text.split('WITH checks AS (', 1)[1].split(') AS value', 1)[0]
    names = re.findall(r"^\s*'([a-z0-9_]+)',", block, re.MULTILINE)
    if len(names) != len(set(names)):
        raise SystemExit('duplicate preflight check names')
    return names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--no-contract', action='store_true', help='skip the PG17 contract rebuild (iteration only; never for a release)')
    args = parser.parse_args()

    mm = migration_manifest()
    missing = [v for v in mm['required_versions'] if v not in preflight_check_names()]
    if missing:
        raise SystemExit('preflight lacks schema-version checks for: ' + ', '.join(missing))
    if not args.no_contract:
        subprocess.run(['node', 'scripts/build_database_contract_pg17.mjs', '--write'], cwd=ROOT, check=True)
    contract_bytes = (ROOT / 'supabase/database-contract-pg17.json').read_bytes()
    contract = json.loads(contract_bytes)

    previous = json.loads(PREVIOUS.read_text())
    files = {}
    for name in sorted(release.ALLOWED):
        path = ROOT / 'site' / name
        if not path.is_file():
            raise SystemExit(f'ALLOWED file missing from site/: {name}')
        old = previous['files'].get(name, {}).get('old_sha256') if name in previous['files'] else None
        files[name] = {'new_sha256': sha(path.read_bytes()), 'old_sha256': old}

    manifest = dict(previous)
    manifest.update({
        'release': release.VERSION,
        'files': files,
        'config_sha256': sha((ROOT / 'site/config.js').read_bytes()),
        'migration_manifest_sha256': sha((ROOT / 'supabase/migration-manifest.json').read_bytes()),
        'database_contract_reference_sha256': sha(contract_bytes),
        'database_contract_sha256': contract['database_contract_sha256'],
        'database_contract_profiles': contract['database_contract_profiles'],
        'required_schema_versions': mm['required_versions'],
        'required_db_checks': preflight_check_names(),
    })
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    write_json(RELEASE_DIR / MANIFEST_NAME, manifest)
    write_json(RELEASE_DIR / 'recovered-tools-sha256.json', {t: sha((ROOT / 'scripts' / t).read_bytes()) for t in TOOLS})
    print(f'PINNED {release.VERSION}: {len(files)} frontend files, {len(mm["migrations"])} migrations'
          + ('' if not args.no_contract else ' (contract NOT rebuilt)'))


if __name__ == '__main__':
    main()
