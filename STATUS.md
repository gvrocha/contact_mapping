# Status

## Current milestone: v0.9
Personal dashboard, publicly visible, reproducible from source.

- [x] Working prototype (local, deployed to S3)
- [x] Live public URL: http://www.w7gvr.com/hamradio_contacts/index.html
- [x] Under git, pushed to GitHub: https://github.com/gvrocha/contact_mapping
- [x] Deploy target parameterized (`deploy.conf`, gitignored) — no personal bucket hardcoded in tracked scripts
- [x] No secrets/personal data in the repo (LoTW/QRZ creds via OS keychain; QSO data gitignored)

**v0.9 is done as of 2026-07-03.**

## Next milestone: v1.0
MVP = "other hams can use this to publish their own contacts."

- [ ] `LICENSE` file (MIT)
- [ ] GitHub Pages deploy path (zero-AWS-account option, alongside existing S3 path)
- [ ] README section: "fork this to track your own callsign"

## After that: v1.1
Automated data refresh (GitHub Actions, scheduled `lotw_fetch`/`qrz_fetch` → commit → redeploy).
Requires an explicit decision on credential storage (OS keychain vs. GitHub Actions secrets) before implementation — not yet decided.

## Notes
- No CI/CD yet — deploys are still manual (`./aws_deploy_site`, `./aws_deploy_data`).
- `data_output/`, `.claude/`, `site/vendor/` are gitignored by design (personal data, local tooling config, vendored assets regenerated via README instructions).
