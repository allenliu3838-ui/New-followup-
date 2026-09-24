"""Deployment tests use only disposable local directories, never production."""
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).parents[1] / "tools/deploy_signup_fix.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.site = self.root / "site"
        self.bundle = self.root / "bundle"
        self.backups = self.root / "backups"
        self.site.mkdir()
        (self.bundle / "payload").mkdir(parents=True)
        self.old, self.new = b"old signup html\n", b"fixed signup html\n"
        (self.site / "signup.html").write_bytes(self.old)
        (self.site / "signup.html").chmod(0o640)
        (self.site / "config.js").write_text("MUST NOT CHANGE")
        (self.bundle / "payload/signup.html").write_bytes(self.new)
        self.manifest = {"schema_version": 1, "site": deploy.SITE, "release": "test-1", "files": [{
            "path": "signup.html", "before_sha256": deploy.digest(self.old), "after_sha256": deploy.digest(self.new)}]}
        self.save_manifest()

    def save_manifest(self):
        (self.bundle / "manifest.json").write_text(json.dumps(self.manifest))

    def tearDown(self):
        self.temporary.cleanup()

    def test_check_is_read_only(self):
        _, entry, _ = deploy.load_bundle(self.bundle)
        self.assertEqual(deploy.inspect(self.site, entry)[1], "ready")
        self.assertEqual((self.site / "signup.html").read_bytes(), self.old)
        self.assertFalse(self.backups.exists())

    def test_apply_idempotent_and_rollback_preserve_other_files_and_mode(self):
        result = deploy.apply(self.site, self.bundle, self.backups)
        self.assertEqual(result["status"], "DEPLOYMENT_OK")
        backup = Path(result["backup"])
        self.assertEqual((self.site / "signup.html").read_bytes(), self.new)
        self.assertEqual(stat.S_IMODE((self.site / "signup.html").stat().st_mode), 0o640)
        self.assertEqual((backup / "signup.html").read_bytes(), self.old)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual(deploy.apply(self.site, self.bundle, self.backups)["status"], "ALREADY_INSTALLED")
        self.assertEqual(len(list(self.backups.iterdir())), 1)
        self.assertEqual(deploy.rollback(backup)["status"], "ROLLBACK_OK")
        self.assertEqual((self.site / "signup.html").read_bytes(), self.old)
        self.assertEqual(deploy.rollback(backup)["status"], "ALREADY_ROLLED_BACK")
        self.assertEqual((self.site / "config.js").read_text(), "MUST NOT CHANGE")

    def test_baseline_mismatch_refuses_all_writes(self):
        (self.site / "signup.html").write_text("a newer legitimate release")
        with self.assertRaisesRegex(deploy.Stop, "VERSION_CHANGED_STOP"):
            deploy.apply(self.site, self.bundle, self.backups)
        self.assertFalse(self.backups.exists())
        self.assertEqual((self.site / "signup.html").read_text(), "a newer legitimate release")

    def test_corrupt_payload_refused(self):
        (self.bundle / "payload/signup.html").write_bytes(b"corrupt")
        with self.assertRaisesRegex(deploy.Stop, "Payload SHA256"):
            deploy.apply(self.site, self.bundle, self.backups)
        self.assertEqual((self.site / "signup.html").read_bytes(), self.old)

    def test_allowlist_refuses_other_pages(self):
        self.manifest["files"][0]["path"] = "config.js"
        self.save_manifest()
        with self.assertRaisesRegex(deploy.Stop, "only registry signup.html"):
            deploy.load_bundle(self.bundle)

    def test_rollback_refuses_newer_edits_and_corrupt_backup(self):
        backup = Path(deploy.apply(self.site, self.bundle, self.backups)["backup"])
        (self.site / "signup.html").write_bytes(b"newer change")
        with self.assertRaisesRegex(deploy.Stop, "changed after deployment"):
            deploy.rollback(backup)
        self.assertEqual((self.site / "signup.html").read_bytes(), b"newer change")
        (self.site / "signup.html").write_bytes(self.new)
        (backup / "signup.html").write_bytes(b"broken")
        with self.assertRaisesRegex(deploy.Stop, "Backup SHA256"):
            deploy.rollback(backup)

    def test_rollback_refuses_other_site(self):
        backup = deploy.apply(self.site, self.bundle, self.backups)["backup"]
        with self.assertRaisesRegex(deploy.Stop, "different site"):
            deploy.rollback(backup, self.root / "other")

    def test_backup_inside_website_refused(self):
        with self.assertRaisesRegex(deploy.Stop, "outside the website"):
            deploy.apply(self.site, self.bundle, self.site / "backups")

    def test_public_verification_matches_fixed_https_payload(self):
        response = MagicMock()
        response.geturl.return_value = "https://kidneysphereregistry.cn/signup?signup_fix=test-1"
        response.getcode.return_value = 200
        response.read.return_value = self.new
        with patch.object(deploy, "build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value = response
            self.assertEqual(deploy.verify(self.bundle)["status"], "PUBLIC_PAGE_OK")
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, response.geturl.return_value)
            self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 15)
        self.assertEqual((self.site / "signup.html").read_bytes(), self.old)
        self.assertFalse(self.backups.exists())

    def test_public_verification_rejects_old_content_or_other_host(self):
        response = MagicMock()
        response.geturl.return_value = "https://kidneysphereregistry.cn/signup"
        response.getcode.return_value = 200
        response.read.return_value = self.old
        with patch.object(deploy, "build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value = response
            with self.assertRaisesRegex(deploy.Stop, "PUBLIC_PAGE_MISMATCH"):
                deploy.verify(self.bundle)
            response.read.return_value = self.new
            response.geturl.return_value = "https://other.example/signup"
            with self.assertRaisesRegex(deploy.Stop, "registry HTTPS"):
                deploy.verify(self.bundle)
        self.assertEqual((self.site / "signup.html").read_bytes(), self.old)

    def test_cross_host_and_http_redirects_blocked_before_following(self):
        handler = deploy.RegistryRedirectHandler()
        for url in ("https://other.example/signup", "http://kidneysphereregistry.cn/signup"):
            with self.subTest(url=url), self.assertRaisesRegex(deploy.Stop, "redirect outside"):
                handler.redirect_request(None, None, 302, "Found", {}, url)

    def test_symlink_refused(self):
        alias = self.root / "alias"
        alias.symlink_to(self.site, target_is_directory=True)
        with self.assertRaisesRegex(deploy.Stop, "Symlink"):
            deploy.apply(alias, self.bundle, self.backups)


class NginxTests(unittest.TestCase):
    def test_only_exact_site_and_direct_root(self):
        text = '''# configuration file /etc/nginx/nginx.conf:
http { include /etc/nginx/conf.d/*.conf; }
# configuration file /etc/nginx/conf.d/site.conf:
server { server_name other.example; root /var/www/other; }
server { listen 443 ssl; server_name kidneysphereregistry.cn www.kidneysphereregistry.cn;
root "/var/www/registry/site"; location / { try_files $uri $uri.html =404; } }
'''
        self.assertEqual(deploy.nginx_site_root(text), Path("/var/www/registry/site"))

    def test_ambiguous_roots_refused(self):
        config = "server { server_name kidneysphereregistry.cn; root /one; } server { server_name kidneysphereregistry.cn; root /two; }"
        with self.assertRaises(deploy.Stop):
            deploy.nginx_site_root(config)

    def test_dynamic_alias_include_and_nested_root_refused(self):
        for suffix in ("root $document_root;", "root /one; location / { alias /two; }",
                       "root /one; include locations.conf;", "root /one; location / { root /two; }"):
            with self.subTest(suffix=suffix), self.assertRaises(deploy.Stop):
                deploy.nginx_site_root("server { server_name kidneysphereregistry.cn; " + suffix + " }")

    def test_missing_or_wildcard_domain_not_guessed(self):
        with self.assertRaises(deploy.Stop):
            deploy.nginx_site_root("server { server_name *.cn; root /one; }")

    def test_redirect_only_http_server_is_skipped(self):
        for redirect in (
            "return 301 https://$host$request_uri;",
            "if ($host = kidneysphereregistry.cn) { return 301 https://$host$request_uri; } return 404;",
        ):
            with self.subTest(redirect=redirect):
                config = "server { listen 80; server_name kidneysphereregistry.cn; " + redirect + " } server { listen 443 ssl; server_name kidneysphereregistry.cn; root /one; }"
                self.assertEqual(deploy.nginx_site_root(config), Path("/one"))

    def test_missing_root_with_location_is_not_assumed_redirect(self):
        config = "server { server_name kidneysphereregistry.cn; return 301 https://$host$request_uri; location / { proxy_pass http://backend; } } server { server_name kidneysphereregistry.cn; root /one; }"
        with self.assertRaises(deploy.Stop):
            deploy.nginx_site_root(config)

    def test_http_and_https_same_explicit_root_accepted(self):
        config = "server { listen 80; server_name kidneysphereregistry.cn; root /one; } server { listen 443 ssl; server_name kidneysphereregistry.cn; root /one; }"
        self.assertEqual(deploy.nginx_site_root(config), Path("/one"))


if __name__ == "__main__":
    unittest.main()
