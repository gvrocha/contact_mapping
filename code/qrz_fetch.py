#!/usr/bin/env python3
"""
Enrich contact data with QRZ-derived coordinates for callsigns that lack a
gridsquare in the LoTW data (typically unconfirmed QSOs).

Requires a QRZ XML subscription. Credentials are stored in the OS keychain
(macOS Keychain, Windows Credential Manager, or Linux Secret Service) via the
keyring library — they are never written to disk by this script.

Usage:
  python qrz_fetch.py           # fetch only callsigns not yet in the cache
  python qrz_fetch.py --full    # re-fetch all callsigns, overwrite cache
"""

import argparse
import getpass
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import keyring
import requests

QRZ_URL         = "https://xmldata.qrz.com/xml/current/"
KEYRING_SERVICE = "qrz"
DATA_DIR        = Path(__file__).parent.parent / "data_output"
CONTACTS_FILE   = DATA_DIR / "lotw_contacts.json"
CACHE_FILE      = DATA_DIR / "qrz_cache.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# Seconds between API calls — stay well within QRZ's unpublished rate limit.
REQUEST_DELAY = 1.0


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def get_credentials():
    username = os.environ.get("QRZ_USERNAME") or keyring.get_password(KEYRING_SERVICE, "username")
    password = os.environ.get("QRZ_PASSWORD") or (
        keyring.get_password(KEYRING_SERVICE, "password") if username else None
    )

    if not username or not password:
        print("QRZ credentials not found in keychain. Enter them once to store securely.")
        print("A QRZ XML subscription is required (https://www.qrz.com/page/xml_data.html).")
        print("Credentials are stored in your OS keychain and are never written to disk.")
        username = input("QRZ username: ").strip()
        password = getpass.getpass("QRZ password: ")
        keyring.set_password(KEYRING_SERVICE, "username", username)
        keyring.set_password(KEYRING_SERVICE, "password", password)
        print("Credentials stored.")

    return username, password


# ---------------------------------------------------------------------------
# QRZ session
# ---------------------------------------------------------------------------

def get_session_key(username, password):
    """Authenticate with QRZ and return a session key."""
    resp = requests.get(QRZ_URL, params={"username": username, "password": password,
                                         "agent": "lotw-dxcc-dashboard/1.0"}, timeout=30)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)
    ns   = {"q": "http://xmldata.qrz.com"}

    error = root.findtext("q:Session/q:Error", namespaces=ns)
    if error:
        print(f"QRZ auth error: {error}", file=sys.stderr)
        sys.exit(1)

    key = root.findtext("q:Session/q:Key", namespaces=ns)
    if not key:
        print("QRZ auth failed: no session key returned.", file=sys.stderr)
        sys.exit(1)

    return key


def lookup_callsign(session_key, call):
    """Return {lat, lon, grid} for a callsign, or None if not found.
    Re-authenticates and raises SessionExpired if the session has expired."""
    resp = requests.get(QRZ_URL, params={"s": session_key, "callsign": call}, timeout=30)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)
    ns   = {"q": "http://xmldata.qrz.com"}

    error = root.findtext("q:Session/q:Error", namespaces=ns)
    if error:
        if "Session Timeout" in error or "Invalid session" in error:
            raise _SessionExpired()
        # "Not found" is a normal outcome for rare/deleted callsigns — not an error.
        return None

    lat   = root.findtext("q:Callsign/q:lat",   namespaces=ns)
    lon   = root.findtext("q:Callsign/q:lon",   namespaces=ns)
    grid  = root.findtext("q:Callsign/q:grid",  namespaces=ns)
    state = root.findtext("q:Callsign/q:state", namespaces=ns)

    if not lat and not grid:
        return None

    result = {}
    if lat and lon:
        try:
            result["lat"] = float(lat)
            result["lon"] = float(lon)
        except ValueError:
            pass
    if grid:
        result["grid"] = grid.strip().upper()
    if state:
        result["state"] = state.strip().upper()

    return result or None


class _SessionExpired(Exception):
    pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--full", action="store_true",
                        help="Re-fetch all callsigns, overwriting the cache.")
    args = parser.parse_args()

    if not CONTACTS_FILE.exists():
        print(f"Error: {CONTACTS_FILE} not found. Run ./lotw_fetch first.", file=sys.stderr)
        sys.exit(1)

    contacts = json.loads(CONTACTS_FILE.read_text())

    # Collect all unique callsigns — QRZ provides state/province even for contacts
    # that already have a gridsquare from LoTW.
    all_calls = {q["call"] for q in contacts if q.get("call")}
    print(f"{len(all_calls)} unique callsign(s) in LoTW data.")

    cache = {}
    if not args.full and CACHE_FILE.exists():
        cache = json.loads(CACHE_FILE.read_text())
        print(f"{len(cache)} callsign(s) already in cache.")

    to_fetch = sorted(all_calls - set(cache.keys())) if not args.full else sorted(all_calls)
    if not to_fetch:
        print("Nothing new to fetch.")
        return

    print(f"Fetching {len(to_fetch)} callsign(s) from QRZ...")

    username, password = get_credentials()
    session_key = get_session_key(username, password)
    print("QRZ session established.")

    found = 0
    for i, call in enumerate(to_fetch, 1):
        try:
            result = lookup_callsign(session_key, call)
        except _SessionExpired:
            print("  Session expired — re-authenticating...")
            session_key = get_session_key(username, password)
            result = lookup_callsign(session_key, call)

        if result:
            cache[call] = result
            found += 1
            coords = f"lat={result.get('lat'):.4f}, lon={result.get('lon'):.4f}" if "lat" in result else f"grid={result.get('grid')}"
            print(f"  [{i}/{len(to_fetch)}] {call}: {coords}")
        else:
            cache[call] = {}   # record the miss so we don't re-fetch on next run
            print(f"  [{i}/{len(to_fetch)}] {call}: not found")

        if i < len(to_fetch):
            time.sleep(REQUEST_DELAY)

    CACHE_FILE.write_text(json.dumps(cache, indent=2, ensure_ascii=False))
    print(f"\n{found}/{len(to_fetch)} callsign(s) resolved. Cache written to {CACHE_FILE}.")


if __name__ == "__main__":
    main()
