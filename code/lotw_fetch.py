#!/usr/bin/env python3
"""
Fetch all QSOs from LoTW and write a flat JSON contact list.
Each record carries a 'confirmed' flag and 'qsl_date' based on LoTW match status.

Usage:
  python lotw_fetch.py           # incremental: QSOs since last fetched date
  python lotw_fetch.py --full    # re-download everything, overwrite output
"""

import argparse
import getpass
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import keyring
import requests

LOTW_URL      = "https://lotw.arrl.org/lotwuser/lotwreport.adi"
KEYRING_SERVICE = "lotw"
DATA_DIR      = Path(__file__).parent.parent / "data_output"
REF_FILE      = Path(__file__).parent.parent / "data_reference" / "dxcc_entities.json"
STATE_FILE    = DATA_DIR / "lotw_state.json"
OUTPUT_FILE   = DATA_DIR / "lotw_contacts.json"


# ---------------------------------------------------------------------------
# DXCC reference — prefix-based entity lookup
# ---------------------------------------------------------------------------

def build_prefix_lookup():
    """Return a callsign-prefix → entity dict built from dxcc_entities.json."""
    if not REF_FILE.exists():
        return {}
    data = json.loads(REF_FILE.read_text())
    lookup = {}
    for entity in data.get("entities", []):
        for prefix in entity.get("prefixes", []):
            lookup[prefix.upper()] = entity
    return lookup


def lookup_entity_by_call(call, prefix_lookup):
    """Longest-prefix match: tries W1ABC → W1AB → W1A → W1 → W."""
    call = call.upper()
    for length in range(len(call), 0, -1):
        match = prefix_lookup.get(call[:length])
        if match:
            return match
    return None


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def get_credentials():
    username = keyring.get_password(KEYRING_SERVICE, "username")
    password = keyring.get_password(KEYRING_SERVICE, "password") if username else None

    if not username or not password:
        print("LoTW credentials not found in keychain. Enter them once to store securely.")
        print("Credentials are stored in your OS keychain (macOS Keychain, Windows Credential")
        print("Manager, or Linux Secret Service) and are never written to disk by this script.")
        username = input("LoTW username: ").strip()
        password = getpass.getpass("LoTW password: ")
        keyring.set_password(KEYRING_SERVICE, "username", username)
        keyring.set_password(KEYRING_SERVICE, "password", password)
        print("Credentials stored.")

    return username, password


# ---------------------------------------------------------------------------
# LoTW fetch
# ---------------------------------------------------------------------------

def fetch_lotw(username, password, since=None, qsl_since=None):
    """Fetch QSOs from LoTW.

    Normal mode (since): all QSOs on or after `since` date, confirmed or not.
    QSL-upgrade mode (qsl_since): only confirmed QSOs whose QSL was received on
    or after `qsl_since`. Used to catch QSLs granted for old QSOs since the last
    run — those QSOs are filtered out by the QSO-date filter alone.
    """
    params = {
        "login":         username,
        "password":      password,
        "qso_query":     "1",
        "qso_qsldetail": "yes",
        "qso_startdate": "2000-01-01",
        "qso_starttime": "00:00:00",
    }
    if qsl_since:
        params["qso_qsl"]      = "yes"      # confirmed QSOs only
        params["qso_qslsince"] = qsl_since  # whose QSL arrived on/after this date
    else:
        params["qso_qsl"]      = "no"       # all QSOs regardless of QSL status
        params["qso_startdate"] = since or "2000-01-01"

    resp = requests.get(LOTW_URL, params=params, timeout=60)
    resp.raise_for_status()

    if resp.text.lstrip().startswith("<html") or "<html" in resp.text[:500].lower():
        print("Error: LoTW returned an HTML page — likely a login failure.", file=sys.stderr)
        sys.exit(1)

    return resp.text


# ---------------------------------------------------------------------------
# ADIF parser
# ---------------------------------------------------------------------------

# Standard ADIF field format: <FIELDNAME:LENGTH> or <FIELDNAME:LENGTH:TYPE>
# followed immediately by the value. Values never contain '<', so [^<]* is safe.
_FIELD_RE = re.compile(r"<([A-Za-z0-9_]+)(?::\d+(?::[A-Za-z])?)?>([^<]*)", re.DOTALL)


def parse_adif(adif_text):
    """Return (header_dict, list_of_qso_dicts) from raw ADIF text."""
    header = {}
    qsos = []
    current = {}
    in_header = True

    for m in _FIELD_RE.finditer(adif_text):
        name  = m.group(1).upper()
        value = m.group(2).strip()

        if name == "EOH":
            in_header = False
            continue
        if name == "EOR":
            if current:
                qsos.append(current)
            current = {}
            continue

        if in_header:
            header[name] = value
        else:
            current[name] = value

    return header, qsos


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def _strip_lotw_comment(value):
    """LoTW appends ' // human-readable comment' to some field values; remove it."""
    return value.split(" //")[0].strip()


def normalize_qso(raw, prefix_lookup):
    date_raw = raw.get("QSO_DATE", "")
    time_raw = raw.get("TIME_ON", "0000").zfill(4)
    try:
        dt     = datetime.strptime(date_raw + time_raw[:4], "%Y%m%d%H%M")
        iso_dt = dt.isoformat()
    except ValueError:
        print(f"Warning: could not parse QSO datetime '{date_raw} {time_raw}' for {raw.get('CALL','')}",
              file=sys.stderr)
        iso_dt = None

    # APP_LoTW_RXQSL = datetime the QSL match was confirmed on LoTW.
    # More precise than QSLRDATE (date-only); fall back to QSLRDATE when absent.
    rxqsl_raw = _strip_lotw_comment(raw.get("APP_LOTW_RXQSL", ""))
    try:
        qsl_date = datetime.strptime(rxqsl_raw, "%Y-%m-%d %H:%M:%S").isoformat()
    except ValueError:
        qsl_date_raw = raw.get("QSLRDATE", "")
        try:
            qsl_date = datetime.strptime(qsl_date_raw, "%Y%m%d").date().isoformat()
        except ValueError:
            qsl_date = None  # absent on unconfirmed QSOs; not a warning condition

    # APP_LoTW_RXQSO = when our upload was received by LoTW (format: "YYYY-MM-DD HH:MM:SS").
    # APP_LoTW_RXQSL = when the QSL match was made (i.e. when the second of the two
    # uploads arrived). The delta between the two reveals who uploaded first:
    #   delta ≈ 0  → other station had already uploaded; we triggered the confirmation.
    #   delta large → we uploaded first and waited for the other station.
    upload_raw = _strip_lotw_comment(raw.get("APP_LOTW_RXQSO", ""))
    try:
        lotw_upload_datetime = datetime.strptime(upload_raw, "%Y-%m-%d %H:%M:%S").isoformat()
    except ValueError:
        lotw_upload_datetime = None

    country = _strip_lotw_comment(raw.get("COUNTRY", ""))

    # CTY.DAT (our reference) has no numeric DXCC entity numbers, so we derive
    # continent via callsign-prefix lookup regardless of whether LoTW returned
    # a DXCC number for this record.
    entity    = lookup_entity_by_call(raw.get("CALL", ""), prefix_lookup)
    continent = entity["continent"] if entity else ""

    return {
        "call":                  raw.get("CALL", "").upper(),
        "datetime":              iso_dt,
        "lotw_upload_datetime":  lotw_upload_datetime,
        "qsl_date":              qsl_date,
        "band":                  raw.get("BAND", "").lower(),
        "mode":                  raw.get("MODE", "").upper(),
        "dxcc":                  raw.get("DXCC", "").strip(),
        "country":               country,
        "continent":             continent,
        "confirmed":             raw.get("QSL_RCVD", "").upper() == "Y",
        "gridsquare":            raw.get("GRIDSQUARE", ""),
        "state":                 _strip_lotw_comment(raw.get("STATE", "")).strip(),
        "cq_zone":               raw.get("CQZ", "").strip(),
        "itu_zone":              raw.get("ITUZ", "").strip(),
    }


def qso_key(qso):
    return (qso["call"], qso["datetime"], qso["band"], qso["mode"])


# ---------------------------------------------------------------------------
# State + I/O
# ---------------------------------------------------------------------------

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(last_qso_date):
    STATE_FILE.write_text(json.dumps({
        "last_fetch":    datetime.now(timezone.utc).isoformat(),
        "last_qso_date": last_qso_date,
    }, indent=2))


def load_contacts():
    if OUTPUT_FILE.exists():
        return json.loads(OUTPUT_FILE.read_text())
    return []


def save_contacts(contacts):
    OUTPUT_FILE.write_text(json.dumps(contacts, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true",
                        help="Ignore saved state and re-download everything.")
    args = parser.parse_args()

    prefix_lookup = build_prefix_lookup()
    if not prefix_lookup:
        print("Warning: DXCC reference file not found — continent data will be missing.",
              file=sys.stderr)
        print(f"  Run: python code/build_dxcc_reference.py", file=sys.stderr)

    username, password = get_credentials()

    state      = load_state()
    since      = None if args.full else state.get("last_qso_date")
    last_fetch = None if args.full else state.get("last_fetch")
    # Use the date portion only; fall back to a week ago so the first incremental
    # run after upgrading from the old code still catches recent confirmations.
    qsl_since  = (last_fetch[:10] if last_fetch
                  else None)

    print("Full fetch ..." if not since else f"Incremental fetch since {since} ...")

    adif_text   = fetch_lotw(username, password, since=since)
    _, raw_qsos = parse_adif(adif_text)
    new_contacts = [normalize_qso(q, prefix_lookup) for q in raw_qsos]
    print(f"  {len(new_contacts)} QSO(s) from LoTW (QSO-date filter).")

    if args.full:
        contacts = new_contacts
    else:
        # Second fetch: confirmed QSOs whose QSL arrived since last run.
        # This catches cases where a QSL is granted for an *old* QSO — those
        # QSOs predate `since` so the first fetch misses them entirely.
        upgraded = 0
        if qsl_since:
            print(f"  Fetching QSLs confirmed since {qsl_since} ...")
            adif_qsl      = fetch_lotw(username, password, qsl_since=qsl_since)
            _, raw_qsl    = parse_adif(adif_qsl)
            qsl_confirmed = [normalize_qso(q, prefix_lookup) for q in raw_qsl]
            print(f"  {len(qsl_confirmed)} confirmed QSO(s) in QSL-since window.")
        else:
            qsl_confirmed = []

        existing   = load_contacts()
        by_key     = {qso_key(q): q for q in existing}

        added = 0
        for q in new_contacts:
            key = qso_key(q)
            if key not in by_key:
                by_key[key] = q
                added += 1

        for q in qsl_confirmed:
            key = qso_key(q)
            if key in by_key:
                if not by_key[key]["confirmed"] and q["confirmed"]:
                    by_key[key] = q   # upgrade unconfirmed → confirmed
                    upgraded += 1
            else:
                by_key[key] = q
                added += 1

        contacts = list(by_key.values())
        print(f"  {added} new, {upgraded} upgraded to confirmed, "
              f"{len(existing)} on disk → {len(contacts)} total.")

    save_contacts(contacts)
    total_qsl = sum(1 for c in contacts if c.get("confirmed"))
    print(f"Written to {OUTPUT_FILE}.")
    print(f"Totals: {len(contacts)} QSOs · {total_qsl} confirmed (QSL).")

    dates = [c["datetime"][:10] for c in contacts if c.get("datetime")]
    if dates:
        last_qso_date = max(dates)
        save_state(last_qso_date)
        print(f"State updated (last_qso_date={last_qso_date}).")
    else:
        print("Warning: no QSO dates found — state not updated.", file=sys.stderr)


if __name__ == "__main__":
    main()
