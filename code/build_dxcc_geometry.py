#!/usr/bin/env python3
"""
Build data_reference/dxcc_map.geojson: one outline per current DXCC entity, for the
DXCC map tab.

Sources:
  - Natural Earth 10m admin-0 countries and admin-1 states/provinces (public domain)
  - ADIF specification DXCC_Entity_Code table, for the "deleted" flag
  - QRZ XML DXCC list (dxcc=all), for names, continents, ISO codes and coordinates
    (needs the same QRZ credentials as qrz_fetch.py)

DXCC entities are not countries, so countries are split where DXCC splits them:
by admin-1 regions (Alaska, Asiatic Russia, Balearics...) or by clipping a parent
outline with lon/lat boxes (Svalbard, Easter Island, Kiribati groups...).
Every entity also gets a point; entities too small to see on a world map are
flagged "dot" so the page draws a marker for them.

Downloads are cached in .cache/dxcc_geometry/ (gitignored).

Usage:
  python build_dxcc_geometry.py
"""

import html
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import requests
from shapely import make_valid, set_precision, union_all
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
from shapely.geometry.polygon import orient

ROOT      = Path(__file__).parent.parent
CACHE_DIR = ROOT / ".cache" / "dxcc_geometry"
OUT_FILE  = ROOT / "data_reference" / "dxcc_map.geojson"

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
SOURCES = {
    "admin0": f"{NE_BASE}/ne_10m_admin_0_countries.geojson",
    "admin1": f"{NE_BASE}/ne_10m_admin_1_states_provinces.geojson",
    "adif":   "https://adif.org/316/ADIF_316.htm",
}

SIMPLIFY_DEG  = 0.02     # ~2 km; plenty for a world map
DOT_AREA_KM2  = 15000    # entities smaller than this also get a marker

# ---------------------------------------------------------------------------
# Entity -> geometry rules
# ---------------------------------------------------------------------------

# Pseudo-entity for the US Minor Outlying Islands: each island is clipped out of it
# into its own DXCC entity, and whatever is left over is dropped.
UMI = -1

# Natural Earth admin-0 units (ADM0_A3) per entity, where QRZ's ISO code is missing,
# wrong, or shared by several entities. Entities not listed use QRZ's ISO3 code when
# exactly one current entity has it.
ADM0 = {
    1:   ["CAN"], 9: ["ASM"], 13: ["ATA"], 103: ["GUM"], 105: ["USG"],
    108: ["BRA", "BRI"], 112: ["CHL", "SPI"], 116: ["COL"], 120: ["ECU"],
    148: ["VEN"], 150: ["AUS", "ATC"], 165: ["MUS"], 166: ["MNP"], 170: ["NZL"],
    172: ["PCN"], 175: ["PYF"], 176: ["FJI"], 185: ["SLB"], 202: ["PRI"],
    205: ["SHN"], 215: ["CYP", "CYN", "CNM"], 216: ["SER", "BJN"], 232: ["SOM", "SOL"],
    233: ["GIB"], 235: ["SGS"], 236: ["GRC"], 247: ["PGA"], 248: ["ITA"],
    257: ["MLT"], 266: ["NOR"], 272: ["PRT"], 277: ["SPM"], 283: ["WSB", "ESB"],
    284: ["SWE"], 285: ["VIR"], 287: ["CHE"], 291: ["USA"], 301: ["KIR"],
    303: ["CSI"], 308: ["CRI"], 324: ["IND", "KAS"], 339: ["JPN"], 375: ["PHL"],
    386: ["TWN"], 462: ["ZAF"], 466: ["SDN", "BRT"], 49: ["GNQ"], 50: ["MEX"],
    506: ["SCR"], 516: ["BLM"], 517: ["CUW"], 518: ["SXM"], 521: ["SDS"],
    522: ["KOS"], 213: ["MAF"], 36: ["CLP"], 33: ["IOT"], 131: ["ATF"],
    35: ["IOA"], UMI: ["UMI"], 191: ["COK"], 263: ["NLD"], 130: ["KAZ", "KAB"],
    227: ["FRA"], 281: ["ESP"], 223: ["GBR"], 299: ["MYS"], 54: ["RUS"], 162: ["NCL"],
    5: ["ALD"], 86: ["NIC"], 510: ["PSX"], 302: ["SAH"],
}

# Split a parent's admin-1 regions out into other entities:
# parent dxcc -> (admin-1 field, {value: child dxcc}). Unlisted regions stay with the parent.
ADM1_SPLITS = {
    291: ("name",     {"Alaska": 6, "Hawaii": 110}),
    281: ("region",   {"Islas Baleares": 21, "Canary Is.": 29, "Ceuta": 32, "Melilla": 32}),
    272: ("name",     {"Azores": 149, "Madeira": 256}),
    248: ("region",   {"Sardegna": 225}),
    227: ("region",   {"Corse": 214, "Guyane française": 63, "Guadeloupe": 79,
                       "Martinique": 84, "Réunion": 453, "Mayotte": 169}),
    223: ("geonunit", {"England": 223, "Scotland": 279, "Wales": 294, "Northern Ireland": 265}),
    120: ("name",     {"Galápagos": 71}),
    324: ("name",     {"Andaman and Nicobar": 11, "Lakshadweep": 142}),
    299: ("name",     {"Sabah": 46, "Sarawak": 46, "Labuan": 46}),
    54:  ("region",   {"Urals": 15, "Siberian": 15, "Far Eastern": 15}),
    236: ("name",     {"Kriti": 40, "Crete": 40}),
}
# Admin-1 regions split out by name inside a region already assigned above.
ADM1_NAME_SPLITS = {54: {"Kaliningrad": 126}}

# Clip children out of a parent's outline: (child, parent, (lon_min, lat_min, lon_max, lat_max)).
# Applied in order, after admin-0/admin-1 assignment; each clip is removed from the parent.
CLIPS = [
    (259, 266, (0, 74, 40, 81.5)),          # Svalbard (incl. Bear Island)
    (118, 266, (-10, 70, -7, 72)),          # Jan Mayen
    (61,  54,  (35, 79.5, 66, 82)),         # Franz Josef Land
    (47,  112, (-110, -28, -105, -26)),     # Easter Island
    (125, 112, (-81.5, -34.5, -78, -33)),   # Juan Fernandez
    (217, 112, (-81, -27, -79.5, -26)),     # San Felix
    (37,  308, (-87.5, 5, -86.5, 6)),       # Cocos Island
    (204, 50,  (-115.5, 18, -110, 19.5)),   # Revillagigedo
    (460, 176, (176.5, -13, 177.5, -12)),   # Rotuma
    (195, 49,  (5, -2, 6, -1)),             # Annobon
    (207, 165, (63, -20, 64, -19.5)),       # Rodriguez
    (192, 339, (140, 24, 143, 28)),         # Ogasawara
    (177, 339, (153.5, 24, 154.5, 24.5)),   # Minami Torishima
    (507, 185, (165, -13, 171, -9)),        # Temotu
    (513, 172, (-125, -25, -124, -24)),     # Ducie
    (509, 175, (-141, -11, -138, -7.5)),    # Marquesas
    (508, 175, (-155, -28.5, -143, -21.5)), # Austral Islands
    (34,  170, (-177.5, -45, -175.5, -43)), # Chatham
    (133, 170, (-180, -32, -177, -29)),     # Kermadec
    (16,  170, (165, -53, 180, -47.5)),     # NZ Subantarctic
    (16,  170, (178, -48, 180, -47)),       #   (Bounty/Antipodes)
    (270, 170, (-173, -10, -171, -8)),      # Tokelau
    (234, 191, (-170, -23, -157, -18)),     # South Cook (rest of COK stays North Cook)
    (240, 235, (-30, -60, -25, -56)),       # South Sandwich
    (201, 462, (37, -47.5, 38.5, -46.5)),   # Prince Edward & Marion
    (138, 110, (-179, 28, -178, 28.6)),     # Kure Atoll
    (31,  301, (-175, -5, -170, -2)),       # Central Kiribati (Phoenix)
    (48,  301, (-162, -12, -150, 5)),       # East Kiribati (Line)
    (490, 301, (169, -1, 170, 0)),          # Banaba
    (38,  35,  (96, -12.5, 97.5, -11.5)),   # Cocos-Keeling (rest of IOA stays Christmas)
    (274, 205, (-13, -41, -9, -36.5)),      # Tristan da Cunha & Gough
    (250, 205, (-6, -16.5, -5.5, -15.8)),   # St Helena (rest of SHN stays Ascension)
    (10,  131, (77, -39, 78, -37.5)),       # Amsterdam & St Paul
    (41,  131, (50, -47, 53, -45.5)),       # Crozet
    (99,  131, (47, -12, 47.5, -11.3)),     # Glorioso
    (124, 131, (42.5, -17.2, 43, -16.8)),   # Juan de Nova
    (276, 131, (54.3, -16, 54.7, -15.7)),   # Tromelin (rest of ATF stays Kerguelen)
    (174, UMI, (-178, 28, -177, 28.5)),     # Midway
    (297, UMI, (166, 19, 167, 19.5)),       # Wake
    (123, UMI, (-170, 16.5, -169, 17)),     # Johnston
    (20,  UMI, (-177, -0.5, -176, 1)),      # Baker & Howland
    (197, UMI, (-163, -1, -159, 6.5)),      # Palmyra & Jarvis
    (182, UMI, (-75.5, 18, -74.5, 18.6)),   # Navassa
    (515, 9,   (-171.2, -11.2, -170.9, -10.9)),  # Swains
    (241, 13,  (-63.5, -63.5, -53, -60.8)), # South Shetland
    (238, 13,  (-47, -61.2, -44, -60.3)),   # South Orkney
    (199, 13,  (-91.5, -69.2, -90, -68.5)), # Peter I
    (520, 263, (-68.5, 11.9, -68, 12.4)),   # Bonaire
    (519, 263, (-63.4, 17.4, -62.9, 17.7)), # Saba & St Eustatius
    (216, 116, (-82, 12, -78, 16.5)),       # San Andres & Providencia (Colombian islands)
    (512, 162, (158, -20, 159.5, -19)),     # Chesterfield
    (45,  236, (26.2, 35.3, 28.5, 37.5)),   # Dodecanese
    (180, 236, (24.0, 40.1, 24.45, 40.45)), # Mt Athos
    (147, 150, (159, -31.8, 159.2, -31.4)), # Lord Howe
    (153, 150, (158.7, -54.8, 159, -54.4)), # Macquarie
    (56,  108, (-32.6, -4, -32.3, -3.7)),   # Fernando de Noronha
    (273, 108, (-29.5, -20.6, -28.7, -20.4)),   # Trindade & Martim Vaz
    (253, 108, (-29.4, 0.8, -29.3, 1.0)),   # St Peter & St Paul Rocks
    (4,   165, (56.5, -10.5, 56.8, -10.3)), # Agalega
    (4,   165, (59.4, -16.9, 59.8, -16.2)), #   (St Brandon)
    (24,  266, (3.2, -54.6, 3.5, -54.3)),   # Bouvet
    (161, 116, (-81.7, 3.9, -81.5, 4.1)),   # Malpelo
    (211, 1,   (-60.2, 43.9, -59.7, 44.05)),    # Sable
    (252, 1,   (-60.2, 47.1, -60.1, 47.3)), # St Paul Island
    (17,  148, (-63.7, 15.6, -63.6, 15.75)),    # Aves
    (43,  202, (-67.5, 18.37, -67.46, 18.4)),   # Desecheo
    (505, 386, (116.6, 20.6, 116.8, 20.8)), # Pratas
]


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def cached(name, url):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / Path(url).name
    if not path.exists():
        print(f"Downloading {name}: {url}")
        resp = requests.get(url, timeout=300)
        resp.raise_for_status()
        path.write_bytes(resp.content)
    return path


def load_adif_deleted():
    """Return {dxcc: deleted?} from the ADIF spec's DXCC_Entity_Code table."""
    text = cached("ADIF spec", SOURCES["adif"]).read_text(encoding="utf-8", errors="replace")
    table = text[text.find("Enumeration_DXCC_Entity_Code"):]
    table = table[:table.find("</table>")]
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if cells and cells[0].isdigit():
            out[int(cells[0])] = len(cells) > 2 and cells[2].upper().startswith("Y")
    if len(out) < 300:
        sys.exit(f"ADIF DXCC table parse failed ({len(out)} rows).")
    return out


def load_qrz_dxcc():
    """Return {dxcc: record} for all DXCC entities known to QRZ."""
    path = CACHE_DIR / "qrz_dxcc_all.json"
    if not path.exists():
        sys.path.insert(0, str(Path(__file__).parent))
        import qrz_fetch
        key  = qrz_fetch.get_session_key(*qrz_fetch.get_credentials())
        resp = requests.get(qrz_fetch.QRZ_URL, params={"s": key, "dxcc": "all"}, timeout=60)
        resp.raise_for_status()
        ns   = "{http://xmldata.qrz.com}"
        ents = [{c.tag.replace(ns, ""): (c.text or "") for c in d}
                for d in ET.fromstring(resp.text).findall(f"{ns}DXCC")]
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(ents, indent=1, ensure_ascii=False))
    return {int(e["dxcc"]): e for e in json.loads(path.read_text())}


def load_features(name):
    return json.loads(cached(f"Natural Earth {name}", SOURCES[name]).read_text())["features"]


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def polygons_only(geom):
    """Keep only polygonal parts (intersections/differences can leave lines/points)."""
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if isinstance(g, (Polygon, MultiPolygon))]
    return union_all(parts) if parts else None


def area_km2(geom):
    if geom is None or geom.is_empty:
        return 0.0
    lat = geom.centroid.y
    return geom.area * 111.32 * 111.32 * max(math.cos(math.radians(lat)), 0.05)


def to_geojson(geom, grid=0.001):
    """GeoJSON geometry snapped to a 0.001° grid (keeps the file small), repaired, and
    oriented per RFC 7946 (outer rings counter-clockwise, holes clockwise). Renderers
    such as MapLibre infer outer vs. hole from winding, so mixed orientation inside a
    MultiPolygon makes whole land masses render as holes."""
    g = polygons_only(make_valid(set_precision(geom, grid)))
    parts = list(getattr(g, "geoms", [g]))
    g = MultiPolygon([orient(p, sign=1.0) for p in parts]) if len(parts) > 1 else orient(parts[0], sign=1.0)
    m = mapping(g)
    return {"type": m["type"], "coordinates": m["coordinates"]}


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def main():
    deleted = load_adif_deleted()
    qrz     = load_qrz_dxcc()
    current = {d: qrz[d] for d, dele in deleted.items() if not dele and d != 0 and d in qrz}
    print(f"{len(current)} current DXCC entities.")

    admin0 = load_features("admin0")
    admin1 = load_features("admin1")
    a0_geom = {}
    for f in admin0:
        code = f["properties"]["ADM0_A3"]
        g = make_valid(shape(f["geometry"]))
        a0_geom[code] = union_all([a0_geom[code], g]) if code in a0_geom else g
    a1_by_country = defaultdict(list)
    for f in admin1:
        a1_by_country[f["properties"]["adm0_a3"]].append(f)

    # 1. admin-0 assignment
    by_ccc = defaultdict(list)
    for d, e in current.items():
        by_ccc[e.get("ccc") or ""].append(d)
    claimed = {c for codes in ADM0.values() for c in codes}
    assign = {d: codes for d, codes in ADM0.items() if d in current or d < 0}
    for ccc, ds in by_ccc.items():
        if len(ds) == 1 and ds[0] not in assign and ccc in a0_geom and ccc not in claimed:
            assign[ds[0]] = [ccc]
            claimed.add(ccc)

    geom = {}
    for d, codes in assign.items():
        parts = [a0_geom[c] for c in codes if c in a0_geom]
        if parts:
            geom[d] = union_all(parts)

    # 2. admin-1 splits: parent rebuilt from its own remaining regions
    for parent, (field, children) in ADM1_SPLITS.items():
        country = assign[parent][0]
        name_split = ADM1_NAME_SPLITS.get(parent, {})
        groups = defaultdict(list)
        for f in a1_by_country[country]:
            p = f["properties"]
            target = name_split.get(p["name"]) or children.get(p.get(field)) or parent
            groups[target].append(make_valid(shape(f["geometry"])))
        for target, gs in groups.items():
            geom[target] = union_all(gs)
        # admin-0 extras assigned to the parent (e.g. KAS for India) stay with it
        extras = [a0_geom[c] for c in assign[parent][1:] if c in a0_geom]
        if extras:
            geom[parent] = union_all([geom[parent]] + extras)

    # 3. clips
    for child, parent, bbox in CLIPS:
        if bbox is None or parent not in geom:
            continue
        piece = polygons_only(geom[parent].intersection(box(*bbox)))
        if piece is None:
            print(f"  note: clip for {child} ({current.get(child, {}).get('name')}) found nothing in {parent}")
            continue
        geom[child] = union_all([geom[child], piece]) if child in geom else piece
        geom[parent] = polygons_only(geom[parent].difference(box(*bbox)))

    # 4. report what is unassigned
    used = {c for codes in assign.values() for c in codes}
    unused = sorted(c for c in a0_geom if c not in used)
    if unused:
        print("  Natural Earth units not assigned to any entity:", unused)

    # 5. write
    features, dots = [], 0
    for d, e in sorted(current.items()):
        g = polygons_only(geom.get(d))
        area = area_km2(g)
        if g is not None:
            g = polygons_only(make_valid(g.simplify(SIMPLIFY_DEG, preserve_topology=True)))
        lat, lon = float(e.get("lat") or 0), float(e.get("lon") or 0)
        if (lat, lon) == (0.0, 0.0) and g is not None:
            rp = g.representative_point()
            lat, lon = rp.y, rp.x
        dot = area < DOT_AREA_KM2
        dots += dot
        props = {"dxcc": d, "name": e.get("name", ""), "continent": (e.get("continent") or "").upper(),
                 "dot": dot}
        if g is not None:
            features.append({"type": "Feature", "properties": {**props, "kind": "area"},
                             "geometry": to_geojson(g)})
        features.append({"type": "Feature", "properties": {**props, "kind": "point"},
                         "geometry": {"type": "Point", "coordinates": [round(lon, 3), round(lat, 3)]}})

    with_area = sum(1 for f in features if f["properties"]["kind"] == "area")
    no_area = [f'{d}:{current[d]["name"]}' for d in sorted(current) if polygons_only(geom.get(d)) is None]
    print(f"{with_area} entities with outlines, {len(current) - with_area} point-only, {dots} drawn as dots.")
    if no_area:
        print("  point-only:", ", ".join(no_area))

    OUT_FILE.write_text(json.dumps({"type": "FeatureCollection", "features": features},
                                   separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {OUT_FILE} ({OUT_FILE.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
