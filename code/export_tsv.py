#!/usr/bin/env python3
"""
Export lotw_contacts.json and qrz_cache.json to plain tab-separated tables,
for ad-hoc inspection with grep/awk/a spreadsheet instead of jq.

Usage:
  python export_tsv.py
"""

import csv
import json
from pathlib import Path

DATA_DIR      = Path(__file__).parent.parent / "data_output"
CONTACTS_FILE = DATA_DIR / "lotw_contacts.json"
QRZ_FILE      = DATA_DIR / "qrz_cache.json"

CONTACTS_FIELDS = [
    "call", "datetime", "lotw_upload_datetime", "qsl_date", "band", "mode",
    "dxcc", "country", "continent", "confirmed", "gridsquare", "state",
    "cq_zone", "itu_zone",
]
QRZ_FIELDS = ["call", "lat", "lon", "grid", "state"]


def export_contacts():
    contacts = json.loads(CONTACTS_FILE.read_text())
    out_path = DATA_DIR / "lotw_contacts.tsv"
    with out_path.open("w", newline="") as out:
        w = csv.writer(out, delimiter="\t")
        w.writerow(CONTACTS_FIELDS)
        for c in contacts:
            w.writerow([c.get(k, "") for k in CONTACTS_FIELDS])
    print(f"Wrote {out_path} ({len(contacts)} rows)")


def export_qrz_cache():
    qrz = json.loads(QRZ_FILE.read_text())
    out_path = DATA_DIR / "qrz_cache.tsv"
    with out_path.open("w", newline="") as out:
        w = csv.writer(out, delimiter="\t")
        w.writerow(QRZ_FIELDS)
        for call, rec in qrz.items():
            w.writerow([call] + [rec.get(k, "") for k in QRZ_FIELDS[1:]])
    print(f"Wrote {out_path} ({len(qrz)} rows)")


def main():
    export_contacts()
    if QRZ_FILE.exists():
        export_qrz_cache()


if __name__ == "__main__":
    main()
