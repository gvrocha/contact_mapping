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
- [ ] **Pending verification:** first Pages build still shows 404 as of 2026-07-03 ~15:20Z (build status was "building" with no error — likely just needs more time). Re-check `https://gvrocha.github.io/contact_mapping/` before calling v1.0 fully done.

## After that: v1.1

## After that: v1.1
Automated data refresh (GitHub Actions, scheduled `lotw_fetch`/`qrz_fetch` → commit → redeploy).
Requires an explicit decision on credential storage (OS keychain vs. GitHub Actions secrets) before implementation — not yet decided.

## Notes
- No CI/CD yet — deploys are still manual (`./aws_deploy_site`, `./aws_deploy_data`).
- `data_output/`, `.claude/`, `site/vendor/` are gitignored by design (personal data, local tooling config, vendored assets regenerated via README instructions).
