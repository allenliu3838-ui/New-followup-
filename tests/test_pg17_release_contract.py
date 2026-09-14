"""Release-gate regression tests using invented metadata, never production reports."""
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import registry_integrated_release as release

NOW = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)


def fixture():
    canonical = {
        'functions': [
            {'signature': 'example_read(uuid)', 'definition_md5': '1' * 32, 'anon_execute': False, 'authenticated_execute': True, 'security_definer': True},
            {'signature': 'example_write(uuid)', 'definition_md5': '2' * 32, 'anon_execute': False, 'authenticated_execute': True, 'security_definer': True},
        ],
        'triggers': [{'schema': 'public', 'table': 'example_records', 'trigger': 'guard_record', 'definition_md5': '3' * 32, 'enabled': 'O'}],
        'policies': [{'schema': 'public', 'table': 'example_records', 'policy': 'members_only', 'roles': ['authenticated'], 'command': 'SELECT', 'qual': 'example_permission(project_id)', 'with_check': None}],
        'tables': [{'schema': 'public', 'table': 'example_records', 'rls': True, 'anon_select': False, 'auth_select': True, 'constraints': [{'name': 'example_records_pkey', 'type': 'p', 'validated': True, 'definition_md5': '4' * 32}]}],
        'columns': [
            {'schema': 'public', 'table': 'example_records', 'name': 'id', 'type': 'uuid', 'not_null': True, 'default_md5': None, 'anon_insert': False, 'auth_insert': True},
            {'schema': 'public', 'table': 'example_records', 'name': 'project_id', 'type': 'uuid', 'not_null': True, 'default_md5': None, 'anon_insert': False, 'auth_insert': True},
        ],
        'indexes': [{'schema': 'public', 'table': 'example_records', 'name': 'example_records_pkey', 'valid': True, 'ready': True, 'unique': True, 'nulls_not_distinct': False, 'columns': [{'position': 1, 'column': 'id', 'included': False, 'expression': False}]}],
        'schema_privileges': [{'schema': 'registry_private', 'anon_usage': False, 'anon_create': False, 'auth_usage': False, 'auth_create': False}],
        'buckets': [{'id': 'payment-proofs', 'public': False, 'file_size_limit': 10485760, 'allowed_mime_types': ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']}],
        'views': [{'schema': 'public', 'name': 'example_view', 'owner': 'postgres', 'definition_md5': '9' * 32, 'options': ['security_invoker=true'], 'anon_select': True, 'auth_select': True, 'anon_insert': False, 'auth_insert': False}],
    }
    historical = copy.deepcopy(canonical)
    historical['functions'][0]['definition_md5'] = 'a' * 32
    historical['functions'][1]['definition_md5'] = 'b' * 32
    versions = ['0032_security_integrity', '0033_billing_registration', '0034_import_corrections', '0035_frozen_exports', '0036_project_members']
    manifest = {
        'release': release.VERSION,
        'project_ref': release.PROJECT_REF,
        'database_contract_protocol': release.CONTRACT_PROTOCOL,
        'database_server_major': 17,
        'database_contract_sha256': 'c' * 64,
        'database_contract_profiles': {'canonical': canonical, 'historical_crlf': historical},
        'migration_manifest_sha256': 'd' * 64,
        'required_schema_versions': versions,
        'required_db_checks': ['clinical_rls', 'export_guard'],
    }
    report = {
        'release': release.VERSION,
        'database': 'postgres',
        'project_ref': release.PROJECT_REF,
        'contract_protocol': release.CONTRACT_PROTOCOL,
        'database_server_major': 17,
        'server_version_num': 170006,
        'database_contract_sha256': manifest['database_contract_sha256'],
        'migration_manifest_sha256': manifest['migration_manifest_sha256'],
        'identity_source': 'verified_connection_host',
        'checked_at': NOW.isoformat(),
        'transaction_read_only': 'on',
        'render_timezone': 'UTC',
        'render_search_path': 'pg_catalog, public',
        'schema_versions': versions[:],
        'checks': {'clinical_rls': True, 'export_guard': True},
        **copy.deepcopy(canonical),
    }
    return manifest, report


class Pg17ContractGate(unittest.TestCase):
    def test_view_privilege_or_definition_changes_are_rejected(self):
        for field, value in [('options', []), ('owner', 'other_owner'), ('definition_md5', '8' * 32), ('anon_insert', True), ('auth_insert', True)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report['views'][0][field] = value
                self.deny()

    def setUp(self):
        self.manifest, self.report = fixture()

    def verify(self):
        return release.verify_db(self.report, self.manifest, now=NOW)

    def deny(self):
        with self.assertRaises(release.Error):
            self.verify()

    def test_each_complete_reviewed_profile_is_accepted(self):
        self.assertEqual(self.verify(), 'canonical')
        self.report.update(copy.deepcopy(self.manifest['database_contract_profiles']['historical_crlf']))
        self.assertEqual(self.verify(), 'historical_crlf')

    def test_unreviewed_hybrid_of_reviewed_function_hashes_is_rejected(self):
        self.report['functions'][0] = copy.deepcopy(self.manifest['database_contract_profiles']['historical_crlf']['functions'][0])
        self.deny()

    def test_top_level_row_order_has_no_authorization_meaning(self):
        self.report['columns'].reverse()
        self.report['functions'].reverse()
        self.assertEqual(self.verify(), 'canonical')

    def test_unsupported_or_falsely_declared_database_version(self):
        for version, major in [(180000, 18), (180000, 17), (160010, 17), (170006, 18), ('170006', 17), (True, 17), (None, 17)]:
            with self.subTest(version=version, major=major):
                self.report['server_version_num'], self.report['database_server_major'] = version, major
                self.deny()

    def test_protocol_release_query_and_migration_are_bound(self):
        for field, value in [('release', 'registry-20260914-integrated-v1'), ('contract_protocol', 'registry-contract-v1'), ('database_contract_sha256', 'e' * 64), ('migration_manifest_sha256', 'e' * 64)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report[field] = value
                self.deny()

    def test_query_hash_cannot_be_absent_on_both_sides(self):
        self.report.pop('database_contract_sha256')
        self.manifest.pop('database_contract_sha256')
        self.deny()

    def test_unknown_or_incomplete_manifest_profile_rejected(self):
        cases = [('extra', 'future'), ('missing', 'historical_crlf'), ('empty', 'columns')]
        for action, key in cases:
            with self.subTest(action=action):
                self.manifest, self.report = fixture()
                profiles = self.manifest['database_contract_profiles']
                if action == 'extra': profiles[key] = copy.deepcopy(profiles['canonical'])
                elif action == 'missing': profiles.pop(key)
                else: profiles['canonical'][key] = []
                self.deny()

    def test_report_must_be_captured_with_reviewed_read_only_settings(self):
        for field, value in [('transaction_read_only', 'off'), ('render_timezone', 'America/Los_Angeles'), ('render_search_path', 'public, registry_private')]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report[field] = value
                self.deny()

    def test_project_identity_and_freshness_remain_required(self):
        for field, value in [('project_ref', 'other-project'), ('database', 'other-database'), ('identity_source', 'manual'), ('checked_at', (NOW-timedelta(days=2)).isoformat()), ('checked_at', (NOW+timedelta(minutes=10)).isoformat())]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report[field] = value
                self.deny()

    def test_all_required_schema_versions_and_checks_remain_required(self):
        for change in ['missing_version', 'extra_version', 'false_check', 'missing_check', 'integer_check']:
            with self.subTest(change=change):
                self.manifest, self.report = fixture()
                if change == 'missing_version': self.report['schema_versions'].pop()
                elif change == 'extra_version': self.report['schema_versions'].append('unreviewed')
                elif change == 'false_check': self.report['checks']['clinical_rls'] = False
                elif change == 'integer_check': self.report['checks']['clinical_rls'] = 1
                else: self.report['checks'].pop('clinical_rls')
                self.deny()

    def test_every_contract_category_is_required(self):
        for category in release.CONTRACT_CATEGORIES:
            with self.subTest(category=category):
                self.manifest, self.report = fixture()
                self.report.pop(category)
                self.deny()

    def test_column_removal_is_rejected(self):
        self.report['columns'].pop()
        self.deny()

    def test_not_null_removal_is_rejected_without_pg18_n_constraint(self):
        self.assertFalse(any(c['type'] == 'n' for t in self.report['tables'] for c in t['constraints']))
        self.report['columns'][1]['not_null'] = False
        self.deny()

    def test_column_type_default_and_grants_are_enforced(self):
        for field, value in [('type', 'text'), ('default_md5', 'f'*32), ('anon_insert', True), ('auth_insert', False)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report['columns'][1][field] = value
                self.deny()

    def test_function_definition_and_execute_acl_are_enforced(self):
        for field, value in [('definition_md5', 'f'*32), ('anon_execute', True), ('security_definer', False), ('authenticated_execute', False)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report['functions'][0][field] = value
                self.deny()

    def test_additional_function_overload_is_rejected(self):
        extra = copy.deepcopy(self.report['functions'][0])
        extra['signature'] = 'example_read(uuid,text)'
        self.report['functions'].append(extra)
        self.deny()

    def test_additional_permissive_policy_is_rejected(self):
        self.report['policies'].append({'schema': 'public', 'table': 'example_records', 'policy': 'allow_all', 'qual': 'true'})
        self.deny()

    def test_policy_expression_and_table_rls_are_enforced(self):
        self.report['policies'][0]['qual'] = 'true'
        self.deny()
        self.manifest, self.report = fixture()
        self.report['tables'][0]['rls'] = False
        self.deny()

    def test_trigger_enablement_and_constraints_are_enforced(self):
        self.report['triggers'][0]['enabled'] = 'D'
        self.deny()
        self.manifest, self.report = fixture()
        self.report['tables'][0]['constraints'] = []
        self.deny()

    def test_table_grants_are_enforced(self):
        self.report['tables'][0]['anon_select'] = True
        self.deny()

    def test_unique_index_validity_and_key_identity_are_enforced(self):
        for field, value in [('valid', False), ('ready', False), ('unique', False), ('nulls_not_distinct', True)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report['indexes'][0][field] = value
                self.deny()
        self.manifest, self.report = fixture()
        self.report['indexes'][0]['columns'][0]['column'] = 'project_id'
        self.deny()

    def test_private_schema_and_payment_bucket_are_enforced(self):
        self.report['schema_privileges'][0]['auth_usage'] = True
        self.deny()
        for field, value in [('public', True), ('file_size_limit', None), ('allowed_mime_types', None)]:
            with self.subTest(field=field):
                self.manifest, self.report = fixture()
                self.report['buckets'][0][field] = value
                self.deny()

    def test_no_profile_claim_can_override_observed_catalog(self):
        self.report['contract_profile'] = 'canonical'
        self.report['functions'][0]['definition_md5'] = 'f'*32
        self.deny()


if __name__ == '__main__':
    unittest.main()
