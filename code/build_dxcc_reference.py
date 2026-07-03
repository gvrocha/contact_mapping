#!/usr/bin/env python3
"""
Parse CTY.DAT (AD1C format) into data_reference/dxcc_entities.json.

CTY.DAT longitude convention is inverted (positive = West); we convert to
standard GIS convention (positive = East) on output.

Run once to regenerate the reference file:
  python code/build_dxcc_reference.py [path/to/cty.dat]

Defaults to downloading the latest CTY.DAT from country-files.com if no
path is given.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

CTY_URL = "https://www.country-files.com/cty/cty.dat"
OUT_FILE = Path(__file__).parent.parent / "data_reference" / "dxcc_entities.json"

# First line of each entity record:
# Name:  CQ:  ITU:  Cont:  Lat:  Lon:  UTC:  Prefix:
_HEADER_RE = re.compile(
    r'^(\*?)(.+?):\s+'          # optional * (deleted), entity name
    r'(\d+):\s+'                # CQ zone
    r'(\d+):\s+'                # ITU zone
    r'([A-Z]{2}):\s+'           # continent
    r'(-?\d+\.?\d*):\s+'        # latitude  (positive = N)
    r'(-?\d+\.?\d*):\s+'        # longitude (CTY: positive = W → negate for GIS)
    r'(-?\d+\.?\d*):\s+'        # UTC offset
    r'(\S+):\s*$'               # primary prefix
)


def fetch_cty(path=None):
    if path:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    print(f"Downloading CTY.DAT from {CTY_URL} ...")
    try:
        with urllib.request.urlopen(CTY_URL, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as exc:
        print(f"Error: failed to download CTY.DAT: {exc}", file=sys.stderr)
        print("Pass a local file path as an argument, or check your network connection.", file=sys.stderr)
        sys.exit(1)


def parse_cty(text):
    entities = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _HEADER_RE.match(line)
        if not m:
            i += 1
            continue

        deleted      = m.group(1) == "*"
        name         = m.group(2).strip()
        cq_zone      = int(m.group(3))
        itu_zone     = int(m.group(4))
        continent    = m.group(5)
        lat          = float(m.group(6))
        lon_cty      = float(m.group(7))
        utc_offset   = float(m.group(8))
        prefix       = m.group(9).lstrip("*")   # some prefixes also carry *

        # CTY.DAT stores longitude with inverted sign; convert to standard GIS
        lon = -lon_cty

        # Consume alias lines until we hit the terminating ';'
        alias_text = ""
        i += 1
        while i < len(lines):
            alias_text += lines[i].strip()
            if alias_text.endswith(";"):
                break
            i += 1

        # Build prefix list from the alias line:
        # - Strip leading '=' (marks exact-callsign matches, not prefix patterns)
        # - Skip entries containing '/' (these are sub-entity overrides like
        #   3D2/r for Rotuma; they'd cause false prefix matches for normal calls)
        raw_aliases = [a.strip().lstrip("=") for a in alias_text.rstrip(";").split(",")]
        prefixes = [a for a in raw_aliases if a and "/" not in a]

        entities.append({
            "name":       name,
            "prefix":     prefix,
            "continent":  continent,
            "cq_zone":    cq_zone,
            "itu_zone":   itu_zone,
            "lat":        lat,
            "lon":        lon,
            "utc_offset": utc_offset,
            "deleted":    deleted,
            "prefixes":   prefixes,
        })
        i += 1

    return entities


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    text = fetch_cty(path)
    entities = parse_cty(text)

    active  = [e for e in entities if not e["deleted"]]
    deleted = [e for e in entities if e["deleted"]]

    print(f"Parsed {len(entities)} total entities: {len(active)} active, {len(deleted)} deleted.")

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps({
        "source": "CTY.DAT — https://www.country-files.com/cty/cty.dat",
        "note":   "lon/lat in standard GIS convention (positive = E/N). Deleted DXCC entities included with deleted=true.",
        "entities": entities,
    }, indent=2, ensure_ascii=False))
    print(f"Written to {OUT_FILE}")


if __name__ == "__main__":
    main()
