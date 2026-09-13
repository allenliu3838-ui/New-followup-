# Registry homepage visual preview

Status: user approved this preview; offline release prepared, **not yet deployed**.
The user asked for a stronger technology aesthetic and kidney-themed images.
The current production files under `site/` remain unchanged by this visual draft.

The draft adds a navy hero with cyan accents, a generated kidney/data-network
illustration and three original decorative SVG illustrations for university
collaboration. At widths below 840 px the hero becomes a single column. Original
authentication/project scripts, links, tracking attributes, pricing markup and
footer are preserved. The generated image is conceptual branding, not a clinical
diagram or a claim of implemented AI functionality.

Files to use in a future separately checked release:

- `index.html` → `/var/www/kidneysphere-registry/index.html`
- `assets/registry-tech-hero.png` → `/var/www/kidneysphere-registry/assets/registry-tech-hero.png`

Do not use the previous two-page university release tool for this visual update;
that tool is pinned to the already deployed first release. The new
`scripts/registry_visual_release.py` and `scripts/build_registry_visual_offline.py`
provide the separate guarded release. See `docs/REGISTRY_VISUAL_RELEASE.md`.
No server access, service restart, database change or Nginx change was performed
while preparing this preview.

Current deployed homepage SHA-256:
`abbb6ebf61ed52c6e3200cb8606a9915a2d107f449c42d2b4e5c1585a5576864`

Draft homepage SHA-256:
`68a3492147c3495d071d2c3b79c42dfcdb464b894042ac6b60ab3f2c99ebcd06`

Hero PNG SHA-256:
`120433c30d6b2de5259d90935ba2a14eaf45c9537dcc5169199f1b3eb806fc11`

The PNG is 1536 × 1024 and 2,039,989 bytes. It is copied unchanged from the
built-in image generation output. Prompt: a premium scientific 3D editorial
illustration of a translucent cyan kidney, centered on a deep navy background,
surrounded by sparse connected research-data nodes and subtle orbital arcs;
landscape 3:2, soft volumetric lighting, no text, numbers, logos, people or gore.

The standalone preview embeds CSS and images, includes only local project-card
and pricing rendering, and omits authentication redirects, analytics and live
configuration. Its banner identifies it as a preview. Links open the current
production site. To rebuild it, supply a directory containing copies of the
public shared `ks-topbar.css` and `ks-brand.css`:

```sh
python3 scripts/build_registry_visual_preview.py \
  --shared-css-dir /path/to/shared-css \
  --output /path/to/registry-tech-preview.html
```

Validation: static HTML/asset checks and comparison of preserved functionality
against the current homepage. Browser rendering and mobile device testing remain
to be completed; responsive CSS alone is not a device test.
