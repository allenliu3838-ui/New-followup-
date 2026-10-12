"""境外依赖检查器（scripts/check_external_hosts.py）的规则测试，以及迁移手册配套文件
（docs/cn-migration/config.example.js、compare_snapshots.py）的基本检查。

全部使用临时目录中构造的小型 site 夹具，不联网。运行：
  python3 -I -m unittest discover -s tests -p test_external_hosts.py
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'check_external_hosts.py'
_spec = importlib.util.spec_from_file_location('check_external_hosts', SCRIPT)
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

DOMESTIC_CONFIG = 'window.CONFIG = { SUPABASE_URL: "https://api.kidneysphereregistry.cn", SUPABASE_ANON_KEY: "x" };\n'
FOREIGN_CONFIG = textwrap.dedent('''\
    // 注释里的 https://old.supabase.co 不算
    window.CONFIG = {
      SUPABASE_URL: "https://abcdefgh.supabase.co",
      SUPABASE_ANON_KEY: "sb_publishable_x",
      BILLING: {
        WECHAT_QR_IMG: "https://abcdefgh.supabase.co/storage/v1/object/public/billing/wechat.jpg",
      },
    };
    ''')


class SiteCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='ext-hosts-')
        self.site = Path(self._tmp.name) / 'site'
        self.site.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, files):
        for name, body in files.items():
            path = self.site / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(body), encoding='utf-8')

    def report(self, files, config=DOMESTIC_CONFIG, **kwargs):
        if config is not None:
            files = {'config.js': config, **files}
        self.write(files)
        return checker.build_report(self.site, **kwargs)

    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = checker.main(['--site', str(self.site), *args])
        return code, out.getvalue()

    @staticmethod
    def hosts(findings):
        return {f['host'] for f in findings}


class AllowedAndLinkOnly(SiteCase):
    def test_allowed_hosts_link_only_and_ignored(self):
        report = self.report({'index.html': '''\
            <!doctype html><html><head>
            <link rel="canonical" href="https://kidneysphereregistry.cn/"/>
            <meta property="og:url" content="https://kidneysphereregistry.cn/"/>
            <link rel="stylesheet" href="https://kidneysphere.com/shared/ks-topbar.css">
            <link rel="alternate" href="https://mirror.foreign-ref.org/feed">
            <script src="https://cdn.kidneysphere.com/shared/ks-topbar.js" defer></script>
            <script type="application/ld+json">{"@context":"https://schema.org","url":"https://ld.foreign-ref.org/"}</script>
            </head><body>
            <!-- 旧地址 https://comment.foreign-ref.org/ -->
            <svg xmlns="http://www.w3.org/2000/svg"></svg>
            <p>文献：https://text.foreign-ref.org/paper</p>
            <a href="https://escholarship.org/uc/item/x" target="_blank">CKD-EPI</a>
            <a href="https://beian.miit.gov.cn/">沪ICP备</a>
            <a href="https://beian.mps.gov.cn/#/query">公安备案</a>
            <a href="https://www.cac.gov.cn/2021-08/20/c_1.htm">个人信息保护法</a>
            </body></html>
            '''})
        self.assertEqual(report['violations'], [])
        self.assertEqual(report['exit_code'], 0)
        self.assertEqual(self.hosts(report['link_only']),
                         {'mirror.foreign-ref.org', 'schema.org', 'ld.foreign-ref.org', 'text.foreign-ref.org',
                          'escholarship.org'})
        self.assertTrue({'kidneysphere.com', 'cdn.kidneysphere.com', 'kidneysphereregistry.cn', 'beian.miit.gov.cn',
                         'beian.mps.gov.cn', 'www.cac.gov.cn'} <= self.hosts(report['allowed']))
        self.assertTrue({'comment.foreign-ref.org', 'www.w3.org'} <= self.hosts(report['ignored']))
        self.assertEqual(report['warnings'], [])

    def test_allowlist_matches_whole_labels_only(self):
        self.assertTrue(checker.is_allowed('kidneysphere.com'))
        self.assertTrue(checker.is_allowed('a.b.kidneysphere.com'))
        self.assertFalse(checker.is_allowed('evilkidneysphere.com'))
        self.assertFalse(checker.is_allowed('kidneysphere.com.attacker.net'))
        self.assertFalse(checker.is_allowed('cac.gov.cn'))
        self.assertTrue(checker.is_allowed('api.partner.cn', frozenset({'api.partner.cn'})))


class AutomaticRequests(SiteCase):
    def test_html_and_css_resources_are_violations(self):
        report = self.report({
            'page.html': '''\
                <html><head>
                <script src="https://cdn.jsdelivr.net/npm/lib@1.0.0/x.js"></script>
                <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">
                <link href="https://norel.foreign-cdn.com/a.css">
                <style>@import url("https://style-import.foreign-cdn.com/a.css"); body{background:url(https://style-bg.foreign-cdn.com/b.png)}</style>
                <script>fetch('https://inline-fetch.foreign-api.com/v1').then(r => r.json());</script>
                </head><body>
                <img src="//protocol-relative.foreign-cdn.com/x.png">
                <img srcset="https://srcset.foreign-cdn.com/a.png 1x, https://srcset2.foreign-cdn.com/a.png 2x">
                <iframe src="https://frame.foreign-video.com/embed"></iframe>
                <div style="background-image:url('https://inline-style.foreign-cdn.com/c.png')"></div>
                <form action="https://form.foreign-collect.com/submit"></form>
                <button onclick="fetch('https://onclick.foreign-api.com/x')">x</button>
                </body></html>
                ''',
            'app.css': '''\
                /* https://css-comment.foreign-ref.org/ 不算 */
                .hero { background: url("https://css-bg.foreign-cdn.com/hero.png"); }
                @import "https://css-import.foreign-cdn.com/theme.css";
                ''',
        })
        expected = {'cdn.jsdelivr.net', 'fonts.googleapis.com', 'norel.foreign-cdn.com', 'style-import.foreign-cdn.com',
                    'style-bg.foreign-cdn.com', 'inline-fetch.foreign-api.com', 'protocol-relative.foreign-cdn.com',
                    'srcset.foreign-cdn.com', 'srcset2.foreign-cdn.com', 'frame.foreign-video.com',
                    'inline-style.foreign-cdn.com', 'form.foreign-collect.com', 'onclick.foreign-api.com',
                    'css-bg.foreign-cdn.com', 'css-import.foreign-cdn.com'}
        self.assertEqual(self.hosts(report['violations']), expected)
        self.assertIn('css-comment.foreign-ref.org', self.hosts(report['ignored']))
        self.assertEqual(report['exit_code'], 1)
        code, text = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn('[违规]', text)
        self.assertIn('cdn.jsdelivr.net', text)

    def test_javascript_contexts(self):
        report = self.report({'app.js': '''\
            // 文档：https://js-comment.foreign-ref.org/ 只是注释
            /* 块注释 https://block-comment.foreign-ref.org/ */
            const re = /["'`]/g, ratio = total / count, other = 'x';
            fetch("https://fetch.foreign-api.com/data");
            const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://xhr.foreign-api.com/a');
            const s = document.createElement('script'); s.src = 'https://dynamic-script.foreign-cdn.com/a.js';
            const BASE = `https://template.foreign-api.com/${path}`;
            el.innerHTML = `<p>${n}</p><a href="https://template-link.foreign-ref.org/x">文献</a>`;
            el.innerHTML = `<img src="https://template-img.foreign-cdn.com/${name}.png">`;
            el.innerHTML = `${cond ? `<b>${x}</b>` : ''}<img src="https://nested-img.foreign-cdn.com/a.png">`;
            location.href = 'https://navigate.foreign-ref.org/';
            window.open("https://open.foreign-ref.org/", "_blank");
            new URL(value, 'https://registry.invalid');
            '''})
        self.assertEqual(self.hosts(report['violations']),
                         {'fetch.foreign-api.com', 'xhr.foreign-api.com', 'dynamic-script.foreign-cdn.com',
                          'template.foreign-api.com', 'template-img.foreign-cdn.com', 'nested-img.foreign-cdn.com'})
        self.assertEqual(self.hosts(report['link_only']),
                         {'template-link.foreign-ref.org', 'navigate.foreign-ref.org', 'open.foreign-ref.org'})
        self.assertTrue({'js-comment.foreign-ref.org', 'block-comment.foreign-ref.org', 'registry.invalid'}
                        <= self.hosts(report['ignored']))


class VendorLibraries(SiteCase):
    def test_vendor_strings_are_listed_but_requests_fail(self):
        report = self.report({'lib/vendor/lib.min.js': (
            'var e="See https://github.com/org/lib/blob/main/MIGRATION.md";'
            'function t(){return fetch("https://telemetry.foreign-vendor.io/collect")}'
            'var u="http://localhost";')})
        self.assertEqual(self.hosts(report['vendor_strings']), {'github.com'})
        self.assertEqual(self.hosts(report['violations']), {'telemetry.foreign-vendor.io'})
        self.assertIn('localhost', self.hosts(report['ignored']))


class GatedAnalytics(SiteCase):
    PAGE = {'index.html': '<script src="/analytics.js"></script>'}

    def analytics(self, body, config=DOMESTIC_CONFIG, extra=None):
        files = dict(self.PAGE, **{'analytics.js': body}, **(extra or {}))
        return self.report(files, config=config)

    def assert_gated(self, report):
        self.assertEqual(report['violations'], [])
        self.assertEqual(self.hosts(report['gated']), {'plausible.io'})
        self.assertEqual(report['exit_code'], 0)

    def test_optional_chaining_switch_is_accepted(self):
        self.assert_gated(self.analytics('''\
            (function(){
              if (window.CONFIG?.FEATURES?.ANALYTICS !== true) return;
              var s = document.createElement('script');
              s.src = 'https://plausible.io/js/script.tagged-events.js';
              document.head.appendChild(s);
            })();
            '''))

    def test_equivalent_switch_through_helper_is_accepted(self):
        self.assert_gated(self.analytics('''\
            (function(){
              var DEFAULT_SRC = 'https://plausible.io/js/script.tagged-events.js';
              function features(){ var c = window.CONFIG; return (c && c.FEATURES) || {}; }
              function enabled(){ return features().ANALYTICS === true; }
              if (enabled()) { var s = document.createElement('script'); s.src = DEFAULT_SRC; document.head.appendChild(s); }
            })();
            '''))

    def test_classic_and_bracket_switches_are_accepted(self):
        self.assert_gated(self.analytics(
            "if (window.CONFIG && window.CONFIG.FEATURES && window.CONFIG.FEATURES['ANALYTICS']) {"
            " load('https://plausible.io/js/script.js'); }"))

    def test_unprotected_analytics_is_violation(self):
        report = self.analytics('''\
            var ENABLED = true;
            if (ENABLED) { var s = document.createElement('script'); s.src = 'https://plausible.io/js/script.js'; }
            ''')
        self.assertEqual(self.hosts(report['violations']), {'plausible.io'})
        self.assertEqual(report['exit_code'], 1)

    def test_switch_mentioned_only_in_comment_is_not_protection(self):
        report = self.analytics('''\
            // 仅当 window.CONFIG.FEATURES.ANALYTICS === true 时启用（但代码没有判断）
            var s = document.createElement('script'); s.src = 'https://plausible.io/js/script.js';
            ''')
        self.assertEqual(self.hosts(report['violations']), {'plausible.io'})

    def test_switch_defaulting_to_on_is_not_protection(self):
        report = self.analytics(
            "if (window.CONFIG?.FEATURES?.ANALYTICS ?? true) { s.src = 'https://plausible.io/js/script.js'; }")
        self.assertEqual(self.hosts(report['violations']), {'plausible.io'})
        self.assertTrue(any('缺省值' in w for w in report['warnings']))

    def test_plausible_outside_analytics_js_is_violation(self):
        gated = "if (window.CONFIG?.FEATURES?.ANALYTICS === true) { s.src = 'https://plausible.io/js/script.js'; }"
        report = self.analytics(gated, extra={
            'other.html': '<script defer src="https://plausible.io/js/script.js"></script>',
            'tracker.js': gated,
        })
        self.assertEqual(self.hosts(report['violations']), {'plausible.io'})
        self.assertEqual({f['file'] for f in report['violations']}, {'site/other.html', 'site/tracker.js'})
        self.assertEqual({f['file'] for f in report['gated']}, {'site/analytics.js'})

    def test_config_turning_on_foreign_analytics_is_violation(self):
        gated = "if (window.CONFIG?.FEATURES?.ANALYTICS === true) { s.src = 'https://plausible.io/js/script.js'; }"
        on = DOMESTIC_CONFIG.replace('};', 'FEATURES: { ANALYTICS: true } };')
        report = self.analytics(gated, config=on)
        self.assertEqual(report['exit_code'], 1)
        self.assertTrue(any('ANALYTICS' in f['context'] for f in report['violations']))
        domestic_src = DOMESTIC_CONFIG.replace(
            '};', 'FEATURES: { ANALYTICS: true, ANALYTICS_SRC: "https://stats.kidneysphereregistry.cn/js/s.js" } };')
        self.assertEqual(self.analytics(gated, config=domestic_src)['exit_code'], 0)


class ConfigDatabaseHost(SiteCase):
    def test_supabase_database_is_reported_as_foreign_warning(self):
        report = self.report({'index.html': '<p>x</p>'}, config=FOREIGN_CONFIG)
        self.assertEqual(report['config']['database_host'], 'abcdefgh.supabase.co')
        self.assertEqual(report['config']['database_status'], 'foreign')
        self.assertIn('数据库仍在境外：abcdefgh.supabase.co（config.js SUPABASE_URL）', report['warnings'])
        self.assertTrue(any('WECHAT_QR_IMG' in w and '境外存储' in w for w in report['warnings']))
        self.assertEqual(report['violations'], [])
        self.assertEqual(report['exit_code'], 0)
        code, text = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn('警告：数据库仍在境外', text)

    def test_require_domestic_db_fails_while_database_is_foreign(self):
        self.write({'config.js': FOREIGN_CONFIG, 'index.html': '<p>x</p>'})
        code, text = self.run_main('--require-domestic-db')
        self.assertEqual(code, 1)
        self.assertIn('--require-domestic-db', text)

    def test_domestic_database_host_passes(self):
        report = self.report({'index.html': '<p>x</p>'}, require_domestic_db=True)
        self.assertEqual(report['config']['database_status'], 'allowed')
        self.assertEqual(report['warnings'], [])
        self.assertEqual(report['exit_code'], 0)

    def test_unknown_database_host_needs_manual_confirmation(self):
        config = 'window.CONFIG={SUPABASE_URL:"https://db.other-cloud.cn",SUPABASE_ANON_KEY:"x"};'
        report = self.report({}, config=config)
        self.assertEqual(report['config']['database_status'], 'unknown')
        self.assertTrue(any('无法确认位于境内' in w for w in report['warnings']))
        self.assertEqual(report['exit_code'], 0)
        self.assertEqual(checker.build_report(self.site, require_domestic_db=True)['exit_code'], 1)
        confirmed = checker.build_report(self.site, require_domestic_db=True,
                                         domestic_db_hosts=frozenset({'db.other-cloud.cn'}))
        self.assertEqual(confirmed['config']['database_status'], 'allowed')
        self.assertEqual(confirmed['exit_code'], 0)

    def test_foreign_image_host_in_config_is_violation(self):
        config = DOMESTIC_CONFIG.replace(
            '};', 'BILLING: { ALIPAY_QR_IMG: "https://cdn.foreign-images.com/alipay.jpg" } };')
        report = self.report({}, config=config)
        self.assertEqual(self.hosts(report['violations']), {'cdn.foreign-images.com'})
        self.assertIn('ALIPAY_QR_IMG', report['violations'][0]['context'])

    def test_genetics_switch_on_is_warned_and_missing_config_reported(self):
        on = DOMESTIC_CONFIG.replace('};', 'FEATURES: { GENETICS: true, ANALYTICS: false } };')
        report = self.report({}, config=on)
        self.assertTrue(report['config']['features']['GENETICS'])
        self.assertFalse(report['config']['features']['ANALYTICS'])
        self.assertTrue(any('GENETICS' in w for w in report['warnings']))
        (self.site / 'config.js').unlink()
        missing = checker.build_report(self.site)
        self.assertEqual(missing['config']['database_status'], 'missing')
        self.assertTrue(any('未找到 SUPABASE_URL' in w for w in missing['warnings']))


class CommandLine(SiteCase):
    def test_isolated_mode_cli_and_json_output(self):
        self.write({'config.js': FOREIGN_CONFIG, 'index.html': '<script src="https://cdn.jsdelivr.net/x.js"></script>'})
        done = subprocess.run([sys.executable, '-I', str(SCRIPT), '--site', str(self.site), '--json'],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 1, done.stderr)
        data = json.loads(done.stdout)
        self.assertEqual([v['host'] for v in data['violations']], ['cdn.jsdelivr.net'])
        self.assertEqual(data['config']['database_status'], 'foreign')

    def test_missing_site_directory_is_usage_error(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = checker.main(['--site', str(self.site / 'nope')])
        self.assertEqual(code, 2)


class MigrationCompanionFiles(SiteCase):
    def test_config_example_is_domestic_and_keeps_switches_off(self):
        example = (ROOT / 'docs' / 'cn-migration' / 'config.example.js').read_text(encoding='utf-8')
        report = self.report({'index.html': '<p>x</p>'}, config=example, require_domestic_db=True)
        self.assertEqual(report['violations'], [], checker.render_text(report))
        self.assertEqual(report['config']['database_status'], 'allowed')
        self.assertEqual(report['config']['features']['GENETICS'], False)
        self.assertEqual(report['config']['features']['ANALYTICS'], False)
        self.assertEqual(report['warnings'], [])

    def test_snapshot_comparison_phases(self):
        spec = importlib.util.spec_from_file_location(
            'compare_snapshots', ROOT / 'docs' / 'cn-migration' / 'compare_snapshots.py')
        compare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compare)
        old = {'snapshot_version': 'cn-migration-snapshot-v1', 'checked_at': 't0',
               'key_counts': {'public.patients_baseline': 24, 'public.patient_tokens': 56, 'storage.objects': 3},
               'tables': {'public.patients_baseline': {'rows': 24, 'md5': 'a'}},
               'auth_users_login_md5': 'u', 'patient_token_digest_md5': 't', 'storage_objects_md5': 's',
               'registry_schema_versions': None, 'auth_migrations': '1,2', 'storage_migrations': 'x',
               'patient_tokens_plaintext_rows': 56}
        self.assertEqual(compare.compare('freeze', old, dict(old, checked_at='t1')), ([], []))
        self.assertTrue(compare.compare('freeze', old, dict(old, auth_users_login_md5='changed'))[0])
        restored = dict(old, key_counts=dict(old['key_counts'], **{'storage.objects': 0}), storage_objects_md5='e',
                        auth_migrations='1,2,3')
        self.assertEqual(compare.compare('restore', old, restored)[0], [])
        self.assertTrue(compare.compare('restore', old, dict(restored, auth_migrations='1'))[0])
        self.assertTrue(compare.compare('restore', old, dict(restored, tables={
            'public.patients_baseline': {'rows': 24, 'md5': 'b'}}))[0])
        upgraded = dict(old, tables={'public.patients_baseline': {'rows': 24, 'md5': 'z'}},
                        patient_tokens_plaintext_rows=0,
                        registry_schema_versions=','.join(compare.UPGRADE_VERSIONS))
        self.assertEqual(compare.compare('upgrade', old, upgraded)[0], [])
        self.assertTrue(compare.compare('upgrade', old, dict(upgraded, patient_tokens_plaintext_rows=1))[0])
        self.assertTrue(compare.compare('upgrade', old, dict(upgraded, patient_token_digest_md5='x'))[0])


class RepositorySite(unittest.TestCase):
    def test_repository_site_adds_no_new_external_runtime_hosts(self):
        """仓库 site/ 只允许已知的 plausible.io 一处（待统计开关合入后应变为“受开关保护”）。"""
        report = checker.build_report(ROOT / 'site')
        unexpected = [v for v in report['violations']
                      if not (v['host'] == 'plausible.io' and v['file'] == 'site/analytics.js')]
        self.assertEqual(unexpected, [], checker.render_text(report))
        self.assertIn('kidneysphere.com', self.hosts_of(report['allowed']))
        self.assertIn(report['config']['database_status'], {'foreign', 'allowed'})

    @staticmethod
    def hosts_of(findings):
        return {f['host'] for f in findings}


if __name__ == '__main__':
    unittest.main()
