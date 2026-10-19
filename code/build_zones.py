#!/usr/bin/env python3
"""
Build data_reference/cq_zones.geojson (40 CQ zones, used for WAZ) and
data_reference/itu_zones.geojson (90 ITU zones), for the zone tabs.

Source: HB9HIL/hamradio-zones-geojson (cqzones.geojson / ituzones.geojson, MIT
licence, https://github.com/HB9HIL/hamradio-zones-geojson). Polygons are
repaired, lightly simplified and oriented per RFC 7946; each zone keeps its
label position and a description (CQ: the zone's name; ITU: the entities in it).

Downloads are cached in .cache/zones/ (gitignored).

Usage:
  python build_zones.py
"""

import json
import re
import sys
from pathlib import Path

import requests
from shapely import make_valid, set_precision
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.geometry.polygon import orient

ROOT      = Path(__file__).parent.parent
CACHE_DIR = ROOT / ".cache" / "zones"
SOURCE    = "https://raw.githubusercontent.com/HB9HIL/hamradio-zones-geojson/main/{}"

# kind: (source file, property prefix, zone count, output file)
ZONE_SETS = {
    "cq":  ("cqzones.geojson",  "cq_zone",  40, ROOT / "data_reference" / "cq_zones.geojson"),
    "itu": ("ituzones.geojson", "itu_zone", 90, ROOT / "data_reference" / "itu_zones.geojson"),
}

SIMPLIFY_DEG = 0.01


def load_source(filename):
    path = CACHE_DIR / filename
    if not path.exists():
        url = SOURCE.format(filename)
        print(f"Downloading {url}")
        resp = requests.get(url, timeout=300)
        resp.raise_for_status()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(resp.content)
    return json.loads(path.read_text())["features"]


def entity_names(raw):
    """'!!:CE0Y:**Easter Island#E52:**South Cook Islands' -> 'Easter Island, South Cook Islands'.
    Only '**' entries are entities; plain entries are call areas within the previous one."""
    names = [part.split("**", 1)[1] for part in raw.split("#") if "**" in part]
    names = [re.sub(r"\+.*", "", n).strip() for n in names]
    return ", ".join(dict.fromkeys(n for n in names if n))


def polygons(geom):
    if isinstance(geom, (Polygon, MultiPolygon)):
        return list(getattr(geom, "geoms", [geom]))
    return [p for g in getattr(geom, "geoms", []) for p in polygons(g)]


def to_geojson(geom, grid=0.001):
    """Snap, repair and orient (outer rings counter-clockwise) — see build_dxcc_geometry."""
    parts = [orient(p, sign=1.0) for p in polygons(make_valid(set_precision(geom, grid)))]
    g = MultiPolygon(parts) if len(parts) > 1 else parts[0]
    m = mapping(g)
    return {"type": m["type"], "coordinates": m["coordinates"]}


def build(kind):
    filename, prefix, count, out_file = ZONE_SETS[kind]
    features = []
    for f in load_source(filename):
        p = f["properties"]
        zone = int(p[f"{prefix}_number"])
        raw  = p[f"{prefix}_name"]
        geom = make_valid(shape(f["geometry"])).simplify(SIMPLIFY_DEG, preserve_topology=True)
        lat, lon = p[f"{prefix}_name_loc"]
        features.append({
            "type": "Feature",
            "properties": {"zone": zone, "label": [round(lon, 3), round(lat, 3)],
                           "description": entity_names(raw) if kind == "itu" else raw.strip()},
            "geometry": to_geojson(geom),
        })

    zones = sorted(f["properties"]["zone"] for f in features)
    if zones != list(range(1, count + 1)):
        sys.exit(f"{kind}: expected zones 1-{count}, got {len(zones)}: "
                 f"missing {sorted(set(range(1, count + 1)) - set(zones))}")

    features.sort(key=lambda f: f["properties"]["zone"])
    out_file.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                                   separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {out_file} ({len(features)} zones, {out_file.stat().st_size / 1e6:.1f} MB)")


def main():
    for kind in ZONE_SETS:
        build(kind)


if __name__ == "__main__":
    main()
