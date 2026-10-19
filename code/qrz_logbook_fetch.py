#!/usr/bin/env python3
"""
Download the QRZ Logbook and write a QSO-level table (data_output/qrz_qso_table.tsv).

Only columns that describe the QSO itself are kept (time, band/mode/frequency,
confirmation status per channel, and where the other station was). Operator
attributes (name, QTH, email, QSL route) belong in the call-sign table, and
own-station / sync-bookkeeping columns are dropped.

Requires the logbook's API key (QRZ -> Logbook -> Settings -> API Access Key).
It is read from QRZ_LOGBOOK_KEY or the OS keychain (service "qrz_logbook").

Incremental by default: only QSOs added or changed (e.g. newly confirmed) since
the last run are fetched and merged in by log id. Afterwards the table's row
count is checked against the logbook's own QSO count; on a mismatch (deleted
QSOs, or a failed incremental fetch) the whole logbook is re-fetched.

Note: QRZ marks every fetched QSO as downloaded (qrzcom_qso_download_*).
Downloading does not count as a modification for the incremental fetch.

Usage:
  python qrz_logbook_fetch.py           # fetch QSOs changed since the last run
  python qrz_logbook_fetch.py --full    # re-fetch the whole logbook
"""

import argparse
import csv
import getpass
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import keyring
import requests

LOGBOOK_URL     = "https://logbook.qrz.com/api"
KEYRING_SERVICE = "qrz_logbook"
DATA_DIR        = Path(__file__).parent.parent / "data_output"
OUT_FILE        = DATA_DIR / "qrz_qso_table.tsv"
STATE_FILE      = DATA_DIR / "qrz_logbook_state.json"

PAGE_SIZE = 250

COLUMNS = [
    "app_qrzlog_logid", "call", "qso_datetime", "band", "mode", "freq",
    "tx_pwr", "rst_sent", "rst_rcvd", "comment",
    "app_qrzlog_status", "app_qrzlog_qsldate",
    "lotw_qsl_sent", "lotw_qsl_rcvd", "lotw_qslrdate",
    "eqsl_qsl_sent", "eqsl_qsl_rcvd",
    "qsl_sent", "qsl_rcvd", "qslrdate",
    "dxcc", "gridsquare", "state", "cnty", "cqz", "ituz", "iota",
]

ADIF_FIELD = re.compile(r"<([A-Za-z0-9_]+):(\d+)(?::[A-Za-z])?>")


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def get_api_key():
    key = os.environ.get("QRZ_LOGBOOK_KEY") or keyring.get_password(KEYRING_SERVICE, "api_key")
    if key:
        return key

    if not sys.stdin.isatty():
        print("QRZ Logbook API key not found (set QRZ_LOGBOOK_KEY or store it in the keychain).",
              file=sys.stderr)
        sys.exit(1)

    print("QRZ Logbook API key not found in keychain. Enter it once to store securely.")
    print("Find it at QRZ -> Logbook -> Settings -> API Access Key.")
    key = getpass.getpass("QRZ Logbook API key: ").strip()
    keyring.set_password(KEYRING_SERVICE, "api_key", key)
    print("API key stored.")
    return key


# ---------------------------------------------------------------------------
# Logbook API
# ---------------------------------------------------------------------------

def api_call(key, **params):
    """POST to the Logbook API; return (header dict, ADIF text)."""
    resp = requests.post(LOGBOOK_URL, data={"KEY": key, **params},
                         headers={"User-Agent": "lotw-dxcc-dashboard/1.0"}, timeout=120)
    if resp.status_code in (401, 403):
        print("QRZ Logbook rejected the API key (HTTP %d). Check QRZ_LOGBOOK_KEY or the "
              "keychain entry %s/api_key." % (resp.status_code, KEYRING_SERVICE), file=sys.stderr)
        sys.exit(1)
    resp.raise_for_status()

    # The response is key=value pairs; ADIF (HTML-escaped) is last and may contain '&'.
    head, _, adif = resp.text.partition("ADIF=")
    header = dict(p.split("=", 1) for p in head.strip("&").split("&") if "=" in p)
    return header, adif


def fetch_page(key, after_logid, modsince=None):
    """Return (header dict, list of ADIF records as dicts) for one page."""
    option = f"MAX:{PAGE_SIZE},AFTERLOGID:{after_logid}"
    if modsince:
        option += f",MODSINCE:{modsince}"
    header, adif = api_call(key, ACTION="FETCH", OPTION=option)

    records = []
    for chunk in re.split(r"<eor>", html.unescape(adif), flags=re.I):
        rec = {m.group(1).lower(): chunk[m.end():m.end() + int(m.group(2))]
               for m in ADIF_FIELD.finditer(chunk)}
        if rec.get("app_qrzlog_logid"):
            records.append(rec)
    return header, records


def logbook_count(key):
    header, _ = api_call(key, ACTION="STATUS")
    if header.get("RESULT") != "OK":
        print(f"QRZ Logbook error: {header.get('REASON', header)}", file=sys.stderr)
        sys.exit(1)
    return int(header["COUNT"])


def fetch_all(key, modsince=None):
    records, after = [], 0
    while True:
        header, page = fetch_page(key, after, modsince)
        if header.get("RESULT") != "OK" and not page:
            # QRZ answers RESULT=FAIL, COUNT=0 (no REASON) when nothing matches.
            if records or (header.get("COUNT") == "0" and "REASON" not in header):
                break
            print(f"QRZ Logbook error: {header.get('REASON', header)}", file=sys.stderr)
            sys.exit(1)
        records += page
        print(f"  {len(records)} QSO(s) fetched")
        if len(page) < PAGE_SIZE:
            break
        after = max(int(r["app_qrzlog_logid"]) for r in page) + 1
    return records


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def to_row(rec):
    row = {c: rec.get(c, "").strip() for c in COLUMNS}
    d, t = rec.get("qso_date", ""), rec.get("time_on", "")
    row["qso_datetime"] = f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6] or '00'}Z" if d and t else ""
    row["band"] = row["band"].lower()          # QRZ mixes "20M" and "20m"
    if row["iota"].lower() == "none":
        row["iota"] = ""
    return {k: " ".join(v.split()) for k, v in row.items()}   # no tabs/newlines inside cells


def read_table():
    if not OUT_FILE.exists():
        return {}
    with OUT_FILE.open(newline="") as f:
        return {r["app_qrzlog_logid"]: r for r in csv.DictReader(f, delimiter="\t")}


def write_table(rows):
    rows = sorted(rows, key=lambda r: (r["qso_datetime"], r["app_qrzlog_logid"]))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = OUT_FILE.with_suffix(".tsv.tmp")
    with tmp.open("w", newline="") as out:
        w = csv.DictWriter(out, COLUMNS, delimiter="\t", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    tmp.replace(OUT_FILE)
    print(f"Wrote {OUT_FILE} ({len(rows)} rows, {len(COLUMNS)} columns)")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true",
                        help="Re-fetch the whole logbook instead of only changed QSOs.")
    args = parser.parse_args()

    key     = get_api_key()
    started = datetime.now(timezone.utc)
    state   = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    table   = read_table()

    full = args.full or not table or "last_fetch" not in state
    if full:
        print("Fetching the whole QRZ Logbook...")
        table = {r["app_qrzlog_logid"]: r for r in map(to_row, fetch_all(key))}
    else:
        # Overlap by a day: MODSINCE takes a date, and its boundary is not documented.
        since = (datetime.fromisoformat(state["last_fetch"]) - timedelta(days=1)).date().isoformat()
        print(f"Fetching QRZ Logbook QSOs changed since {since}...")
        changed = [to_row(r) for r in fetch_all(key, modsince=since)]
        new = sum(r["app_qrzlog_logid"] not in table for r in changed)
        table.update((r["app_qrzlog_logid"], r) for r in changed)
        print(f"  {len(changed)} changed QSO(s): {new} new, {len(changed) - new} updated")

        expected = logbook_count(key)
        if len(table) != expected:
            print(f"  Table has {len(table)} QSOs but the logbook has {expected} — re-fetching everything.")
            table = {r["app_qrzlog_logid"]: r for r in map(to_row, fetch_all(key))}

    write_table(table.values())
    STATE_FILE.write_text(json.dumps({"last_fetch": started.isoformat()}, indent=2))


if __name__ == "__main__":
    main()
