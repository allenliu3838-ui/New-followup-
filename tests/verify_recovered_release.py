"""Verify recovered production bytes and syntax without any network or deployment."""
from pathlib import Path
import hashlib
import json
import py_compile
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'releases/registry-integrated-pg17-v3-20260914'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def verify():
    manifest = json.loads((EVIDENCE / 'registry-integrated-pg17-v3-20260914.manifest.json').read_text())
    contract_bytes = (ROOT / 'supabase/database-contract-pg17.json').read_bytes()
    contract = json.loads(contract_bytes)
    assert manifest['database_contract_reference_sha256'] == sha(contract_bytes)
    assert contract['database_server_major'] == manifest['database_server_major'] == 17
    assert contract['contract_protocol'] == manifest['database_contract_protocol'] == 'registry-contract-v3-pg17'
    assert manifest['database_contract_profiles'] == contract['database_contract_profiles']
    assert sha((ROOT / 'scripts/database_contract.sql').read_bytes()) == contract['database_contract_sha256'] == manifest['database_contract_sha256']
    for name, spec in manifest['files'].items():
        path = ROOT / 'site' / name
        assert sha(path.read_bytes()) == spec['new_sha256'], name
    assert sha((ROOT / 'site/config.js').read_bytes()) == manifest['config_sha256']
    migration_bytes = (ROOT / 'supabase/migration-manifest.json').read_bytes()
    assert sha(migration_bytes) == manifest['migration_manifest_sha256']
    assert sha(migration_bytes) == contract['migration_manifest_sha256']
    migration_manifest = json.loads(migration_bytes)
    migrations = migration_manifest['migrations']
    assert sha((ROOT / 'all_migrations_combined.sql').read_bytes()) == migration_manifest['bundle_sha256']
    expected_bundle = '-- GENERATED from supabase/migrations in canonical filename order.\n-- Fresh/isolated databases only; use reviewed increments for production.\n\n'
    expected_bundle += ''.join(f'-- MIGRATION {m["ordinal"]:03d}: {m["file"]}\n' + (ROOT / 'supabase/migrations' / m['file']).read_text() + '\n' for m in migrations)
    assert (ROOT / 'all_migrations_combined.sql').read_text() == expected_bundle.rstrip() + '\n'
    for migration in migrations:
        assert sha((ROOT / 'supabase/migrations' / migration['file']).read_bytes()) == migration['sha256'], migration['file']
    for name, digest in json.loads((EVIDENCE / 'recovered-tools-sha256.json').read_text()).items():
        assert sha((ROOT / 'scripts' / name).read_bytes()) == digest, name
    for path in [*ROOT.glob('scripts/*.py'), *ROOT.glob('scripts/db/*.py'), *ROOT.glob('site/assets/template/*.py')]:
        py_compile.compile(str(path), doraise=True)
    scripts = [*ROOT.glob('site/*.js'), *ROOT.glob('site/lib/*.js'), *ROOT.glob('site/lib/vendor/*.js')]
    for path in scripts:
        subprocess.run(['node', '--input-type=module', '--check'], input=path.read_bytes(), check=True, capture_output=True)
    for path in ROOT.glob('site/*.html'):
        for attrs, body in re.findall(r'<script\b([^>]*)>(.*?)</script\s*>', path.read_text(), re.S | re.I):
            if not body.strip() or 'application/ld+json' in attrs:
                continue
            subprocess.run(['node', '--input-type=module', '--check'], input=body.encode(), check=True, capture_output=True)
    print(f'RELEASE_BYTES_OK: {len(manifest["files"])} frontend files, {len(migrations)} migrations, PG17 reference and reviewed tools; JavaScript/Python syntax.')
    return manifest

if __name__ == '__main__':
    verify()
