#!/usr/bin/env python3
"""Deploy only KidneySphere registry signup.html; never touches DB/config/services.

Bundle: this script, manifest.json, payload/signup.html. Run check before apply.
Manifest: {"schema_version":1,"site":"kidneysphereregistry.cn","release":"...",
 "files":[{"path":"signup.html","before_sha256":"...","after_sha256":"..."}]}
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SITE = "kidneysphereregistry.cn"
DEFAULT_BACKUPS = Path("/root/kidneysphere-release-backups")


class Stop(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def real_path(path):
    """Reject symlink components so deployment cannot silently change targets."""
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        if item.is_symlink():
            raise Stop("Symlink path refused: " + str(item))
    return path


def regular_file(path):
    path = real_path(path)
    if not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
        raise Stop("Expected a regular file: " + str(path))
    return path


def nginx_site_root(config):
    """Conservative detection: exact server_name and one direct static root.

    Unsupported/ambiguous configurations require an explicit --site-dir.
    nginx -T output is parsed in memory and never printed or saved.
    """
    lex = shlex.shlex(config, posix=True, punctuation_chars="{};")
    lex.whitespace_split = True
    tokens = []
    for token in lex:
        tokens.extend(token if token and set(token) <= set("{};") else [token])
    index = 0

    def block(nested=False):
        nonlocal index
        nodes, words = [], []
        while index < len(tokens):
            token = tokens[index]
            index += 1
            if token == ";":
                if not words:
                    raise Stop("Unsupported Nginx syntax; use --site-dir")
                nodes.append((words, None))
                words = []
            elif token == "{":
                if not words:
                    raise Stop("Unsupported Nginx syntax; use --site-dir")
                nodes.append((words, block(True)))
                words = []
            elif token == "}":
                if not nested or words:
                    raise Stop("Unsupported Nginx syntax; use --site-dir")
                return nodes
            else:
                words.append(token)
        if nested or words:
            raise Stop("Incomplete Nginx configuration; use --site-dir")
        return nodes

    def walk(nodes):
        for words, children in nodes:
            yield words, children
            if children is not None:
                yield from walk(children)

    def redirect_only(children):
        redirected = False
        for words, nested in children:
            if nested is None and words[0] in {"listen", "server_name"}:
                continue
            if nested is None and words[0] == "return":
                if len(words) == 3 and words[1] in {"301", "302", "307", "308"}:
                    redirected = True
                    continue
                if words == ["return", "404"]:
                    continue
                return False
            condition = " ".join(words[1:])
            if (words[0] == "if" and nested is not None and len(nested) == 1
                    and re.fullmatch(r"\(\s*\$host\s*=\s*(?:www\.)?kidneysphereregistry\.cn\s*\)", condition)):
                statement, inner = nested[0]
                if inner is None and len(statement) == 3 and statement[0] == "return" and statement[1] in {"301", "302", "307", "308"}:
                    redirected = True
                    continue
            return False
        return redirected

    roots = set()
    for words, children in walk(block()):
        if words != ["server"] or children is None:
            continue
        if not any(w[0] == "server_name" and SITE in w[1:] for w, _ in children):
            continue
        if redirect_only(children):
            continue
        direct = [w[1:] for w, c in children if w[0] == "root" and c is None]
        all_nodes = list(walk(children))
        all_roots = [w for w, _ in all_nodes if w[0] == "root"]
        if len(direct) != 1 or len(direct[0]) != 1 or len(all_roots) != 1:
            raise Stop("No unique direct Nginx root for registry; use --site-dir")
        if any(w[0] in {"alias", "include"} for w, _ in all_nodes):
            raise Stop("Nginx alias/include needs manual root verification; use --site-dir")
        root = direct[0][0]
        if not root.startswith("/") or "$" in root:
            raise Stop("Dynamic/relative Nginx root refused; use --site-dir")
        roots.add(root)
    if len(roots) != 1:
        raise Stop("No unique Nginx root for registry; use --site-dir")
    return real_path(roots.pop())


def detect_site():
    try:
        result = subprocess.run(["nginx", "-T"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop("Cannot read Nginx configuration; provide --site-dir") from None
    if result.returncode:
        raise Stop("Nginx configuration check failed; provide --site-dir")
    return nginx_site_root(result.stdout)


def load_bundle(bundle):
    bundle = real_path(bundle)
    manifest = json.loads(regular_file(bundle / "manifest.json").read_text())
    if not isinstance(manifest, dict):
        raise Stop("Invalid manifest object")
    files = manifest.get("files", [])
    if (manifest.get("schema_version") != 1 or manifest.get("site") != SITE
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", str(manifest.get("release", "")))
            or not isinstance(files, list) or len(files) != 1
            or not isinstance(files[0], dict) or files[0].get("path") != "signup.html"):
        raise Stop("Invalid manifest; only registry signup.html is allowed")
    entry = files[0]
    if not sha(entry.get("before_sha256")) or not sha(entry.get("after_sha256")):
        raise Stop("Invalid manifest SHA256")
    if entry["before_sha256"] == entry["after_sha256"]:
        raise Stop("Manifest does not contain a change")
    payload = regular_file(bundle / "payload/signup.html").read_bytes()
    if digest(payload) != entry["after_sha256"]:
        raise Stop("Payload SHA256 mismatch; no files changed")
    return manifest, entry, payload


def inspect(site, entry):
    target = regular_file(real_path(site) / "signup.html")
    current = digest(target.read_bytes())
    if current == entry["after_sha256"]:
        return target, "installed"
    if current != entry["before_sha256"]:
        raise Stop("VERSION_CHANGED_STOP: signup.html differs from package baseline; no files changed")
    return target, "ready"


def atomic_write(target, data, mode, uid, gid):
    fd, temporary = tempfile.mkstemp(prefix=".registry-signup-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
            temporary_stat = os.fstat(output.fileno())
            if (temporary_stat.st_uid, temporary_stat.st_gid) != (uid, gid):
                os.fchown(output.fileno(), uid, gid)
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(site, bundle, backup_root=DEFAULT_BACKUPS):
    manifest, entry, payload = load_bundle(bundle)
    target, status = inspect(site, entry)
    if status == "installed":
        return {"status": "ALREADY_INSTALLED", "release": manifest["release"]}
    backup_root = real_path(backup_root)
    if backup_root == target.parent or target.parent in backup_root.parents:
        raise Stop("Backup directory must be outside the website root")
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = target.stat()
    original = target.read_bytes()
    if digest(original) != entry["before_sha256"]:
        raise Stop("VERSION_CHANGED_STOP: source changed during check")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backup_root / ("registry-signup-" + stamp)
    backup.mkdir(mode=0o700)
    (backup / "signup.html").write_bytes(original)
    (backup / "signup.html").chmod(0o600)
    state = {
        "schema_version": 1, "site": SITE, "site_dir": str(target.parent),
        "release": manifest["release"], "before_sha256": entry["before_sha256"],
        "after_sha256": entry["after_sha256"], "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid, "gid": metadata.st_gid,
    }
    (backup / "state.json").write_text(json.dumps(state, indent=2) + "\n")
    (backup / "state.json").chmod(0o600)
    for saved_file in (backup / "signup.html", backup / "state.json"):
        with saved_file.open("rb") as saved:
            os.fsync(saved.fileno())
    backup_fd = os.open(backup, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(backup_fd)
    finally:
        os.close(backup_fd)
    if digest(target.read_bytes()) != entry["before_sha256"]:
        raise Stop("VERSION_CHANGED_STOP: source changed before replacement; backup: " + str(backup))
    atomic_write(target, payload, state["mode"], state["uid"], state["gid"])
    if digest(target.read_bytes()) != entry["after_sha256"]:
        raise Stop("Post-write verification failed; backup: " + str(backup))
    return {"status": "DEPLOYMENT_OK", "release": manifest["release"], "backup": str(backup)}


def rollback(backup, site=None):
    backup = real_path(backup)
    state = json.loads(regular_file(backup / "state.json").read_text())
    if (state.get("schema_version") != 1 or state.get("site") != SITE
            or not sha(state.get("before_sha256")) or not sha(state.get("after_sha256"))
            or not isinstance(state.get("site_dir"), str)
            or any(type(state.get(k)) is not int or state[k] < 0 for k in ("mode", "uid", "gid"))
            or state["mode"] > 0o7777):
        raise Stop("Invalid backup metadata")
    original_site = real_path(state["site_dir"])
    if site is not None and real_path(site) != original_site:
        raise Stop("Backup belongs to a different site directory")
    target = regular_file(original_site / "signup.html")
    original = regular_file(backup / "signup.html").read_bytes()
    if digest(original) != state["before_sha256"]:
        raise Stop("Backup SHA256 mismatch; no files changed")
    current = digest(target.read_bytes())
    if current == state["before_sha256"]:
        return {"status": "ALREADY_ROLLED_BACK"}
    if current != state["after_sha256"]:
        raise Stop("VERSION_CHANGED_STOP: current page changed after deployment; rollback refused")
    atomic_write(target, original, state["mode"], state["uid"], state["gid"])
    if digest(target.read_bytes()) != state["before_sha256"]:
        raise Stop("Rollback verification failed")
    return {"status": "ROLLBACK_OK", "site_dir": str(original_site)}


class RegistryRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != "https" or parsed.netloc != SITE:
            raise Stop("Public verification refused a redirect outside registry HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verify(bundle):
    manifest, entry, payload = load_bundle(bundle)
    url = "https://" + SITE + "/signup?signup_fix=" + manifest["release"]
    request = Request(url, headers={"Cache-Control": "no-cache", "Accept-Encoding": "identity"})
    with build_opener(RegistryRedirectHandler()).open(request, timeout=15) as response:
        parsed = urlsplit(response.geturl())
        if parsed.scheme != "https" or parsed.netloc != SITE or response.getcode() != 200:
            raise Stop("Public verification did not return registry HTTPS status 200")
        body = response.read(len(payload) + 1)
    if digest(body) != entry["after_sha256"]:
        raise Stop("PUBLIC_PAGE_MISMATCH: public signup differs from installed payload; check served root/cache. No automatic rollback performed")
    return {"status": "PUBLIC_PAGE_OK", "release": manifest["release"], "writes_performed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "apply", "rollback", "verify"))
    parser.add_argument("--site-dir", help="Confirmed static root serving kidneysphereregistry.cn")
    parser.add_argument("--package-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--backup", type=Path, help="Exact backup directory returned by apply")
    parser.add_argument("--backup-root", type=Path, default=DEFAULT_BACKUPS)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            result = verify(args.package_dir)
        elif args.command == "rollback":
            if not args.backup:
                raise Stop("rollback requires --backup")
            result = rollback(args.backup, args.site_dir)
        else:
            site = real_path(args.site_dir) if args.site_dir else detect_site()
            if args.command == "apply":
                result = apply(site, args.package_dir, args.backup_root)
            else:
                manifest, entry, _ = load_bundle(args.package_dir)
                _, status = inspect(site, entry)
                result = {"status": "ALREADY_INSTALLED" if status == "installed" else "CHECK_OK",
                          "site_dir": str(site), "release": manifest["release"], "writes_performed": False}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (Stop, OSError, ValueError, TypeError, KeyError) as exc:
        print("STOPPED: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
