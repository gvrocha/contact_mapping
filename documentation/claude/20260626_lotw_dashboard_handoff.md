# LoTW Dashboard — Conversation Summary
**Date:** 2026-06-26
**Project:** W7GVR personal DXCC tracking dashboard
**Context:** Planning session, no code written yet

---

## What we discussed

### LoTW API
- ARRL has a documented (if unofficial) HTTPS query API at `https://lotw.arrl.org/lotwuser/lotwreport.adi`
- Credentials: plain login/password in query params
- Returns ADIF format; HTML response = error
- Key params: `qso_query=1`, `qso_qsl=yes`, `qso_qslsince` (for incremental polling using `APP_LoTW_LASTQSL` from previous response)
- Separate DXCC credits endpoint: `https://lotw.arrl.org/lotwuser/logbook/qslcards.php`
- DXCC credit ≠ QSL confirmation — credit requires ARRL validation of the confirmed QSO

### DXCC concepts clarified
- DXCC = DX Century Club; award for confirming contacts with 100+ distinct entities
- 340 total DXCC entities (not 1:1 with political countries)
- QSO → QSL (confirmation) → DXCC credit (ARRL-validated) — three distinct steps

### Project definition
A personal web dashboard to visualize W7GVR's QSO/QSL data from LoTW.

**Features agreed:**
- World map with markers for worked entities
- Geodesic (great circle) path on hover between Fishers IN (EM69) and contact
- Scoreboard table: all 340 DXCC entities, columns per band (any, 20m, 10m, ...)
- Confirmed vs unconfirmed shown distinctly
- Row ordering TBD (options: alpha, by continent, confirmed-first, by slot count)

### Architecture decisions
- **Hosting:** AWS S3 + CloudFront (static site, ~$0–$1/month, no server needed)
- **Data pipeline:** local script (`lotw_fetch.py`) downloads from LoTW, converts ADIF → JSON, pushes to S3 via `aws s3 sync`; password never leaves local machine
- **Refresh:** manual trigger (not cron, not live)
- **Stack:** static site (HTML + JS), no backend

### Map library
- PSKReporter uses Google Maps (custom, old implementation) — not worth copying
- Candidates discussed: MapLibre GL, D3+topojson, Cesium
- Built a live Cesium demo in chat — 3D globe with geodesic glow paths on hover
- Geodesic lines in Cesium: `arcType: Cesium.ArcType.GEODESIC` — trivial
- Cesium caveats: ~10MB bundle, wants Cesium Ion token for good tiles
- **Tentative lean:** MapLibre GL for better size/simplicity tradeoff, but Cesium viable if 3D globe aesthetic is desired

### Demo notes
- Demo used EM69 → Fishers IN as home (real)
- Contact callsigns were fabricated
- Countries partially drawn from memory (Algeria, Spain, Ukraine, Brazil = real recent contacts); others invented for globe coverage
- Finland included — coincidentally Guilherme was chasing OH last night (no contact made)

---

## Open decisions
- Map library final choice (MapLibre vs Cesium)
- Row ordering for entity scoreboard
- Whether to continue in this project or move to Claude Code

---

## Next steps
- Set up AWS S3 bucket + CloudFront distribution
- Write `lotw_fetch.py`: LoTW API → ADIF parse → JSON output → S3 push
- Build static page skeleton with map + scoreboard table
- Wire up hover geodesic path

---

*Note: this summary covers only this conversation. Prior LoTW/DXCC context (52 QSOs, 27 QSLs, recent unconfirmed contacts) is in Claude's memory from earlier sessions.*
