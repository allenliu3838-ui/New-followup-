# Registry homepage visual release

Status: executed successfully by the user in Aliyun Workbench on 2026-09-13.
The terminal screenshot confirms package integrity and local homepage/image
verification. Independent public HTTPS hashes and desktop browser rendering have
also been verified. The visual homepage is now live.

The approved design is at content commit
`b8eb79250a4a20360f2046b4884351c6b2db2116`, under `previews/registry-tech/`.
It adds a navy hero, a generated kidney/data-network image and three decorative
cooperation illustrations. All original nine scripts, 33 link destinations and
tracking attributes, four IDs, pricing markup and footer were preserved. The
downloadable preview was delivered separately and approved before packaging.

## Exact server changes

| Action | Path |
| --- | --- |
| Replace homepage | `/var/www/kidneysphere-registry/index.html` |
| Create new image | `/var/www/kidneysphere-registry/assets/registry-tech-hero.png` |
| Retain private backup and release manifest | `/root/registry-visual-releases/<run>/` |

The helper temporarily stages the new image under a unique
`.registry-visual-*` name in the existing assets directory. It never overwrites an
existing image at the final path. Both the website directory and its assets
directory must be real directories. Existing homepage permissions, owner, group
and supported extended attributes are preserved; the new PNG is mode 0644.

Other site files, `collaboration.html`, configuration, database contents, Nginx,
certificates and services are outside this release. No service restart occurs.
The source checkout under `/opt/kidneysphere-followup` is not updated. For future
maintenance, note that the new approved content is in the preview directory;
an unrelated full deployment from older `site/` content could restore the earlier
homepage. The previous release tool remains pinned to its historical version.

## Package

- Filename: `registry-tech-offline-20260913.pyz`
- Bytes: 1,940,154
- SHA-256: `5fa419e7b06bf35d45af7d5e6e8881700991ab9cd51a8da200cf008d411f1067`
- Uses Python 3 standard library and Linux `renameat2` with `RENAME_NOREPLACE`.
- Contains exactly five members: `__main__.py`, the unchanged
  `registry_pages_release.py`, `registry_visual_release.py`, `pages/index.html`,
  and `assets/registry-tech-hero.png`.
- Runtime uses no downloads and does not extract an archive into the website.

The user previously could not fetch GitHub raw files from this server, so the
package is uploaded through Workbench into `/root`.

```sh
printf '%s  %s\n' \
  '5fa419e7b06bf35d45af7d5e6e8881700991ab9cd51a8da200cf008d411f1067' \
  '/root/registry-tech-offline-20260913.pyz' | sha256sum -c - &&
python3 /root/registry-tech-offline-20260913.pyz --apply
```

Running the package without arguments only checks current file hashes; it does
not create a backup or alter website files. `--apply` and `--rollback` require
root. There is no CLI option to choose a different website directory.

## Version checks and recovery

| File | SHA-256 |
| --- | --- |
| Current homepage baseline | `abbb6ebf61ed52c6e3200cb8606a9915a2d107f449c42d2b4e5c1585a5576864` |
| Approved new homepage | `68a3492147c3495d071d2c3b79c42dfcdb464b894042ac6b60ab3f2c99ebcd06` |
| Approved new PNG | `120433c30d6b2de5259d90935ba2a14eaf45c9537dcc5169199f1b3eb806fc11` |

## Recorded server execution

The user's terminal screenshot shows the package SHA-256 check returned `OK`,
followed by `RELEASE_OK: homepage and image verified; no services restarted`.
The screenshot also says `Public website checks remain to be completed.`
These are server-local checks reported by the release tool, not independent
verification of the public website or its browser rendering.

- Server package: `/root/registry-tech-offline-20260913.pyz`
- Actual backup: `/root/registry-visual-releases/20260913T180229Z-6n2sagiq`
- No rollback was shown or requested.

The exact recovery command printed for this release is retained here for use
only if recovery is needed:

```sh
python3 /root/registry-tech-offline-20260913.pyz --rollback /root/registry-visual-releases/20260913T180229Z-6n2sagiq
```

### Guarded recovery behavior

Before packaging, a fresh HTTPS homepage request returned HTTP 200 and exactly
the baseline hash above. The server helper checks it again before replacing any
public file. Image and homepage payload hashes are fixed in the helper and are
verified before writes. Already-applied matching homepage/image is a no-op.

A private backup and manifest are synced before image installation. The tool
prints `BACKUP` and the exact quoted `ROLLBACK_COMMAND` before publishing either
file. It installs the image first, then replaces the homepage atomically, then
verifies both files. These two operations are not a single atomic transaction.

If a caught update error occurs, it attempts guarded recovery. Manual recovery
uses the printed command and the same package. Recovery checks all original
backup/current hashes and the planned image inode/device before changing files;
it restores the homepage before removing this run's image. A changed homepage,
changed image or same-content image recreated with a different inode stops
recovery. Preserve the backup when recovery stops. A power loss or forced process
termination may require the printed manual recovery command. A pre-manifest
failure can leave an unpublished staging file; its path is reported.

The lock coordinates this release tool only; independent deployment tools must
not modify these same paths simultaneously. Rechecking hashes and identities
reduces accidental conflicts but is not a filesystem-wide transaction lock.

## Validation

18 isolated tests passed using temporary directories and the actual approved
payloads. They cover successful update/repeat/rollback, unchanged adjacent-file
sentinels, ownership/modes, wrong baseline/payload rejection, symlink/hardlink
refusal, a concurrently created asset, failures after image installation and
after homepage replacement, image disappearance, concurrent homepage changes,
image identity checks, partial recovery, archive tampering and actual packaged
CLI execution including the printed rollback command with spaces in paths.
Network access is prohibited during these tests.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tests -p 'test_registry_visual_release.py' -v
```

Post-deployment public checks on 2026-09-13:

- A fresh HTTPS response from `/` returned HTTP 200, 28,968 bytes and the exact
  approved new homepage SHA-256 above.
- `/assets/registry-tech-hero.png` returned HTTP 200, `image/png`, 2,039,989 bytes
  and the exact approved PNG SHA-256 above. Both resources report Last-Modified
  `Sun, 13 Sep 2026 18:02:29 GMT`.
- `/collaboration` still matches the prior release's unchanged SHA-256
  `da84f9e46a193fde9d4defb285cb03a605bee0a78258adbce464c4e238a857db`.
- Public `/login` and `/signup?trial=1` pages both returned HTTP 200.
- A browser loaded the actual homepage and displayed the navy hero and kidney
  illustration. The image is complete with natural dimensions 1536 × 1024;
  at the observed desktop width it displays at approximately 510 px wide.
- Desktop document width and viewport width were both 1348 px; no horizontal
  overflow was detected. The initial viewport screenshot showed readable hero
  text, working image placement and the top of the cooperation cards.
- All 10 project cards rendered. Clicking the homepage's 90-day trial-plan link
  opened `https://kidneysphereregistry.cn/collaboration#pilot-plan`, and the target
  heading was present. The browser then returned to the homepage.

Web extraction can retain an earlier cached homepage; the independent fresh
HTTPS byte comparisons and actual browser rendering above confirm this release.
Mobile device testing, complete workflows on the other sites, actual login,
payments and clinical records were not tested in this visual deployment check.
