# LoTW DXCC Dashboard

A personal static-website dashboard that visualises QSO and QSL data from [ARRL Logbook of the World (LoTW)](https://lotw.arrl.org).

Features:
- World map with a marker per worked DXCC entity (amber = worked, green = confirmed)
- Scoreboard table of all worked entities, with per-band worked/confirmed status
- Fully static — no server required; deployable to S3 + CloudFront for ~$0/month

## Requirements

- Python 3.8+
- An ARRL LoTW account with uploaded QSOs
- A web browser (for local preview) or an S3 bucket (for deployment)

## Setup

```bash
# 1. Clone your fork
git clone <your-fork-url>
cd contact_mapping

# 2. Install dependencies and build the DXCC reference (downloads CTY.DAT)
./setup

# 3. Configure your callsign and home grid square
#    Edit site/config.js — change callsign and homeGrid to your values.
```

## Fetching your LoTW data

```bash
# First run — prompts for LoTW credentials (stored in OS keychain, never on disk)
./lotw_fetch --full

# Subsequent runs — incremental, only fetches new QSOs since last run
./lotw_fetch
```

The output is written to `data_output/lotw_contacts.json`.

## Viewing the dashboard

```bash
# Serve from the project root
python3 -m http.server 8000

# Then open:
# http://localhost:8000/site/index.html
```

## Publishing your own dashboard

Two deploy paths — pick whichever fits, or use both.

### GitHub Pages (no AWS account needed)

```bash
./gh_pages_deploy
```

Pushes `site/` plus your generated `data_output/`/`data_reference/` JSON to a `gh-pages`
branch. First time: enable it in your fork's **Settings → Pages → Source: Deploy from
branch → `gh-pages` / (root)**. Your dashboard will be live at
`https://<your-username>.github.io/<repo-name>/`.

Re-run `./gh_pages_deploy` any time you refresh your data (after `./lotw_fetch`) or change
the site.

### S3 (if you already have an AWS account)

```bash
cp deploy.conf.example deploy.conf
# edit deploy.conf: set BUCKET, REGION, PUBLIC_URL to your own

./aws_deploy_site   # full deploy: site code + data
./aws_deploy_data   # data-only refresh, after re-running ./lotw_fetch
```

`deploy.conf` is gitignored — it holds your personal bucket, not something to share.

## Forking this to track your own callsign

1. Fork the repo, clone it, run `./setup`.
2. Edit `site/config.js` with your callsign and home grid.
3. Run `./lotw_fetch --full` (prompts for LoTW credentials once, stored in your OS keychain).
4. Optionally run `./qrz_fetch` for coordinate enrichment on unconfirmed QSOs.
5. Deploy with `./gh_pages_deploy` (easiest, no AWS account) or the S3 scripts above.

## Project structure

```
contact_mapping/
├── setup                          # One-time: venv + deps + DXCC reference build
├── gh_pages_deploy                # Deploy to GitHub Pages (no AWS account needed)
├── aws_deploy_site / aws_deploy_data  # Deploy to S3 (needs deploy.conf)
├── deploy.conf.example            # Copy to deploy.conf and fill in your S3 bucket
├── LICENSE
├── code/
│   ├── lotw_fetch.py              # LoTW → JSON data pipeline
│   ├── build_dxcc_reference.py    # Builds DXCC entity reference from CTY.DAT
│   └── requirements.txt
├── data_output/                   # Generated data (gitignored — personal QSO logs)
│   ├── lotw_contacts.json
│   └── lotw_state.json
├── data_reference/
│   └── dxcc_entities.json         # DXCC entity list with coordinates (from CTY.DAT)
├── documentation/
│   ├── feature_backlog.md
│   └── claude/                    # AI-assisted planning notes
├── site/
│   ├── index.html
│   ├── config.js                  # ← edit this: your callsign and home grid
│   └── app.js
└── lotw_fetch                     # Convenience wrapper: activates venv and runs script
```

## Configuration

Edit `site/config.js`:

```javascript
const CONFIG = {
    callsign: 'W1ABC',   // your callsign
    homeGrid: 'FN31',    // your Maidenhead grid square
};
```

## Optional: QRZ coordinate enrichment

If you have a [QRZ XML subscription](https://www.qrz.com/page/xml_data.html), you can enrich
map marker placement for contacts that LoTW didn't supply a gridsquare for (typically unconfirmed QSOs).

```bash
# First run — prompts for QRZ credentials (stored in OS keychain, never on disk)
./qrz_fetch

# Subsequent runs — only fetches callsigns not already in the cache
./qrz_fetch

# Re-fetch all callsigns (e.g. after operators update their QRZ location)
./qrz_fetch --full
```

The output is written to `data_output/qrz_cache.json` (gitignored). The dashboard loads it
automatically when present; if absent, it falls back to CTY.DAT country centroids — the map
works identically either way.

**Coordinate priority:** LoTW gridsquare → QRZ lat/lon → QRZ grid → CTY centroid.

## Notes

- LoTW credentials are stored in your OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service via the `keyring` library).
- Confirmed QSL status reflects LoTW's matching at the time of the last fetch. Run `./lotw_fetch --full` periodically to pick up newly confirmed QSOs.
- `data_reference/dxcc_entities.json` is derived from the [AD1C CTY.DAT](https://www.country-files.com/cty/) file and can be regenerated at any time.
