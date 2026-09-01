# Status

## Current milestone: v0.9
Personal dashboard, publicly visible, reproducible from source.

- [x] Working prototype (local, deployed to S3)
- [x] Live public URL: http://www.w7gvr.com/hamradio_contacts/index.html
- [x] Under git, pushed to GitHub: https://github.com/gvrocha/contact_mapping
- [x] Deploy target parameterized (`deploy.conf`, gitignored) — no personal bucket hardcoded in tracked scripts
- [x] No secrets/personal data in the repo (LoTW/QRZ creds via OS keychain; QSO data gitignored)

**v0.9 is done as of 2026-07-03.**

## Current milestone: v1.0
MVP = "other hams can use this to publish their own contacts."

- [x] `setup` script (venv + deps + DXCC reference build in one command)
- [x] `LICENSE` file (MIT)
- [x] GitHub Pages deploy path: `gh_pages_deploy` pushes to a `gh-pages` branch; GitHub auto-enabled Pages on push
- [x] README: documents both deploy paths (Pages + S3) and a "forking this for your own callsign" walkthrough
- [x] Pages build verified live: https://gvrocha.github.io/contact_mapping/ (first build silently errored — GitHub's default Jekyll processing choking on a non-Jekyll site; fixed by adding `.nojekyll` to the `gh-pages` branch)

**v1.0 is done as of 2026-07-03.**

## Current milestone: v1.1
Automated data refresh: GitHub Actions fetches LoTW/QRZ data on a schedule and deploys to
both GitHub Pages and S3, no manual step required.

- [x] Credential model decided: GitHub Actions Secrets (not keychain, not a self-hosted runner)
- [x] `lotw_fetch.py`/`qrz_fetch.py` accept credentials via env vars (`LOTW_USERNAME`/`LOTW_PASSWORD`,
      `QRZ_USERNAME`/`QRZ_PASSWORD`); keychain remains the local-dev default
- [x] Fixed a latent bug affecting every fresh clone (not just CI): neither script created
      `data_output/` if missing, and it's gitignored — first run on any fresh checkout crashed
- [x] Scoped IAM user `contact-mapping-ci-deploy` created (policy limited to the `hamradio_contacts/*`
      prefix in the `www.w7gvr.com` bucket — not the whole bucket, and not the account root key)
- [x] GitHub Secrets set: `LOTW_USERNAME`, `LOTW_PASSWORD`, `QRZ_USERNAME`, `QRZ_PASSWORD`,
      `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Repo variable `USE_QRZ=true` toggles the
      QRZ step (a fork without QRZ can set it to `false`).
- [x] Workflow `.github/workflows/refresh-data.yml`: daily schedule + manual `workflow_dispatch`,
      full LoTW/QRZ refetch (ephemeral runner has no incremental state across runs), then deploys
      to both `gh-pages` and S3.
- [x] Verified end-to-end: manually triggered run succeeded, both https://gvrocha.github.io/contact_mapping/
      and http://www.w7gvr.com/hamradio_contacts/index.html serve the freshly-fetched data.

**v1.1 is done as of 2026-07-04.**

## Current milestone: v1.2 (in progress)
Dashboard UI improvements. See `documentation/claude/20260901_altmap_and_grids_handoff.md` for full
detail on what's below.

- [x] Call sign table: new "Grids" column (unique Maidenhead locators per call sign)
- [x] `BAND_COLORS` harmonized with pskreporter's own band palette
- [ ] "Alt Map" tab — pskreporter-style QSL map (per-band pins, Maidenhead grid overlay, draggable
      time-range brush shared with the Activity tab). **Built but currently disabled** (commented
      out in both `site/index.html` and `site/app.js`) pending two open design questions — see the
      handoff doc: replacing the time-range dropdown with explicit from/to fields, and supporting
      multi-band selection (not just one-or-all).

## Notes
- `data_output/` and `.claude/` are gitignored by design (personal QSO data; local tooling config).
  `site/vendor/` (MapLibre GL JS, globe.gl, and the globe texture) is **committed directly** —
  earlier revisions gitignored it with a promise to "regenerate via README instructions" that never
  actually got written, which would have left a fresh clone with a silently broken map/globe.
  Committing the built assets (~3.3MB, pinned at MapLibre GL JS v4.7.1 / globe.gl v2.46.1) avoids
  that trap entirely — no CDN dependency, no drift, works immediately after `git clone`.
- CI does a full refetch (`--full`) every run rather than incremental, since the GitHub-hosted
  runner has no state persisted between runs. Fine at personal scale; revisit if LoTW history
  grows large enough that this gets slow or hits rate limits.
