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
# 1. Clone the repo
git clone <repo-url>
cd contact_mapping

# 2. Create a virtual environment and install dependencies
python3 -m venv .venv
pip install -r code/requirements.txt

# 3. Build the DXCC entity reference (one-time; downloads CTY.DAT)
python code/build_dxcc_reference.py

# 4. Configure your callsign and home grid square
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

## Project structure

```
contact_mapping/
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
