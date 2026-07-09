'use strict';

// For local dev, serve from project root: python3 -m http.server 8000
// then open http://localhost:8000/site/index.html
// For S3 deployment, change both paths to './<filename>' (all files at bucket root).
// Resolve data paths relative to the page so the same build works both
// locally (python -m http.server from project root → site/index.html)
// and on S3 (hamradio_contacts/index.html alongside the data folders).
const _base    = (() => {
    const p = window.location.pathname;
    // On S3 the page sits next to data_output/ in the same prefix.
    // Locally it sits one level above (../data_output/).
    return p.includes('/site/') ? '../' : '';
})();
const DATA_URL = _base + 'data_output/lotw_contacts.json';
const REF_URL  = _base + 'data_reference/dxcc_entities.json';
const QRZ_URL  = _base + 'data_output/qrz_cache.json';

let distUnit = 'km';   // toggled by the km/mi button in the legend

const BAND_ORDER = ['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m','2m'];

// Normalised display names — covers both LoTW COUNTRY field values and CTY.DAT entity names.
// Lookup is case-insensitive so LoTW's ALL-CAPS country values match automatically.
// Add entries here to override any name that's too long or uses an outdated convention.
const ENTITY_DISPLAY = {
    // LoTW returns ALL-CAPS country names that differ from CTY.DAT — both forms listed.
    // Lookup is case-insensitive so either form matches.
    'United States':                  'USA',
    'United States of America':       'USA',        // LoTW form
    'Canada':                         'Canada',
    'Brazil':                         'Brasil',
    'Federal Republic of Germany':    'Germany',    // LoTW form
    'Fed. Rep. of Germany':           'Germany',    // CTY.DAT form
    'Bosnia-Herzegovina':             'Bosnia-Herzegovina',
    'Saint Vincent':                  'Saint Vincent',
    'Republic of Korea':              'South Korea',
    'Dem. Rep. of the Congo':         'DR Congo',
    'Republic of the Congo':          'Congo',
    'Central African Republic':       'C. African Rep.',
    'Czech Republic':                 'Czechia',
    'Slovak Republic':                'Slovakia',
    'Kingdom of Eswatini':            'Eswatini',
    'Brunei Darussalam':              'Brunei',
    'Timor - Leste':                  'Timor-Leste',
    'United Arab Emirates':           'UAE',
    'Asiatic Russia':                 'Russia (AS)',
    'European Russia':                'Russia (EU)',
    'Asiatic Turkey':                 'Turkey (AS)',
    'European Turkey':                'Turkey (EU)',
    'Sov Mil Order of Malta':         'SMOM',
    'Republic of Kosovo':             'Kosovo',
    'Republic of South Sudan':        'South Sudan',
    'North Macedonia':                'N. Macedonia',
};

// Case-insensitive lookup into ENTITY_DISPLAY.
const _entityDisplayUpper = Object.fromEntries(
    Object.entries(ENTITY_DISPLAY).map(([k, v]) => [k.toUpperCase(), v])
);
const displayName = (raw) => raw ? (_entityDisplayUpper[raw.toUpperCase()] || raw) : raw;

// Countries where state/province is shown in the popup alongside the country name.
const STATE_COUNTRIES = new Set([
    'UNITED STATES', 'UNITED STATES OF AMERICA', 'CANADA', 'BRAZIL', 'BRASIL',
]);

const BAND_COLORS = {
    '160m': '#c084fc',
    '80m':  '#f87171',
    '60m':  '#fb923c',
    '40m':  '#fbbf24',
    '30m':  '#bef264',
    '20m':  '#34d399',
    '17m':  '#22d3ee',
    '15m':  '#60a5fa',
    '12m':  '#818cf8',
    '10m':  '#e879f9',
    '6m':   '#f472b6',
    '2m':   '#94a3b8',
};

const CONT_ORDER = ['NA','SA','EU','AF','AS','OC','AN'];

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

// Maidenhead grid square → [lon, lat] (center of square).
function maidenheadToLatLon(grid) {
    if (!grid || grid.length < 4) return null;
    grid = grid.toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}/.test(grid)) return null;
    let lon = (grid.charCodeAt(0) - 65) * 20 - 180 + parseInt(grid[2]) * 2;
    let lat = (grid.charCodeAt(1) - 65) * 10 - 90 + parseInt(grid[3]);
    if (grid.length >= 6 && /^[A-X]{2}/.test(grid.slice(4, 6))) {
        lon += (grid.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
        lat += (grid.charCodeAt(5) - 65) * (1 / 24) + (1 / 48);
    } else {
        lon += 1;
        lat += 0.5;
    }
    return [lon, lat];
}

// ---------------------------------------------------------------------------
// DXCC reference lookup
// ---------------------------------------------------------------------------

// Build a callsign-prefix → entity map from dxcc_entities.json.
function buildPrefixLookup(refEntities) {
    const lookup = {};
    for (const entity of refEntities) {
        for (const prefix of (entity.prefixes || [])) {
            lookup[prefix.toUpperCase()] = entity;
        }
    }
    return lookup;
}

// Maps each CTY entity's display name → entity object, for resolving LoTW country strings.
function buildNameLookup(refEntities) {
    const lookup = {};
    for (const entity of refEntities) {
        const dn = (displayName(entity.name) || entity.name).toUpperCase();
        lookup[dn] = entity;
    }
    return lookup;
}

// Longest-prefix match: tries W1ABC → W1AB → W1A → W1 → W.
function lookupEntityByCall(call, prefixLookup) {
    call = call.toUpperCase();
    for (let len = call.length; len > 0; len--) {
        const match = prefixLookup[call.slice(0, len)];
        if (match) return match;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

// Group contacts by DXCC entity and accumulate per-band worked/confirmed status.
// qrzCache: optional {CALL: {lat, lon, grid}} from qrz_fetch — improves marker
// placement for contacts that LoTW didn't supply a gridsquare for.
// nameLookup: displayName→entity map used to resolve LoTW country strings to CTY entities.
function aggregate(contacts, prefixLookup, qrzCache = {}, nameLookup = {}) {
    const entities = {};

    // First pass: LoTW is the authoritative DXCC source. For any callsign that has
    // at least one confirmed QSO, derive the canonical entity key from LoTW's country
    // field rather than the CTY prefix lookup. This fixes cases like KG4OJT, which
    // CTY classifies as Guantanamo Bay but LoTW correctly identifies as USA.
    const callKey = {};
    for (const qso of contacts) {
        if (qso.confirmed && qso.country && !callKey[qso.call]) {
            const dn = displayName(qso.country);
            const e  = dn && nameLookup[dn.toUpperCase()];
            if (e) callKey[qso.call] = e.prefix;
        }
    }

    for (const qso of contacts) {
        // Use the LoTW-derived key when available; fall back to CTY prefix lookup so
        // confirmed and unconfirmed contacts from the same callsign land in one bucket.
        const ref = lookupEntityByCall(qso.call, prefixLookup);
        const key = callKey[qso.call] || (ref && ref.prefix) || qso.dxcc || qso.country || qso.call.slice(0, 3);

        if (!entities[key]) {
            const rawName = qso.country || (ref && ref.name) || key;
            const centroid = ref ? [ref.lon, ref.lat] : null;
            entities[key] = {
                name:             displayName(rawName),
                continent:        qso.continent || (ref && ref.continent) || '??',
                dxcc:             qso.dxcc,
                coords:           centroid,   // best overall coords; updated below
                unconfirmedCoords: centroid,  // coords for amber marker — never overridden by confirmed gridsquare
                bands:            {},
                qsoCount:         0,
                qslCount:         0,
                firstQso:         null,
                lastQso:          null,
                firstQsl:         null,
                lastQsl:          null,
                first:            null,
                last:             null,
            };
        }

        const entity = entities[key];

        // Overall coords: LoTW gridsquare > QRZ > CTY centroid (any contact).
        if (!entity.coordsFromGrid) {
            if (qso.gridsquare) {
                const gc = maidenheadToLatLon(qso.gridsquare);
                if (gc) { entity.coords = gc; entity.coordsFromGrid = true; }
            } else if (!entity.coordsFromQrz) {
                const qrz = qrzCache[qso.call];
                if (qrz) {
                    if (qrz.lat !== undefined && qrz.lon !== undefined) {
                        entity.coords = [qrz.lon, qrz.lat];
                        entity.coordsFromQrz = true;
                    } else if (qrz.grid) {
                        const gc = maidenheadToLatLon(qrz.grid);
                        if (gc) { entity.coords = gc; entity.coordsFromQrz = true; }
                    }
                }
            }
        }

        // Unconfirmed coords: QRZ > CTY centroid — never uses confirmed gridsquares,
        // so amber markers don't collide with green markers for the same entity.
        if (!qso.confirmed && !entity.unconfirmedCoordsFromQrz) {
            const qrz = qrzCache[qso.call];
            if (qrz) {
                if (qrz.lat !== undefined && qrz.lon !== undefined) {
                    entity.unconfirmedCoords = [qrz.lon, qrz.lat];
                    entity.unconfirmedCoordsFromQrz = true;
                } else if (qrz.grid) {
                    const gc = maidenheadToLatLon(qrz.grid);
                    if (gc) { entity.unconfirmedCoords = gc; entity.unconfirmedCoordsFromQrz = true; }
                }
            }
        }

        entity.qsoCount++;
        if (qso.confirmed) entity.qslCount++;

        if (qso.datetime) {
            if (!entity.firstQso || qso.datetime < entity.firstQso.datetime)
                entity.firstQso = { datetime: qso.datetime, band: qso.band };
            if (!entity.lastQso  || qso.datetime > entity.lastQso.datetime)
                entity.lastQso  = { datetime: qso.datetime, band: qso.band };
            if (!entity.first || qso.datetime < entity.first) entity.first = qso.datetime;
            if (!entity.last  || qso.datetime > entity.last)  entity.last  = qso.datetime;
        }
        if (qso.confirmed && qso.qsl_date) {
            if (!entity.firstQsl || qso.qsl_date < entity.firstQsl.datetime)
                entity.firstQsl = { datetime: qso.qsl_date, band: qso.band };
            if (!entity.lastQsl  || qso.qsl_date > entity.lastQsl.datetime)
                entity.lastQsl  = { datetime: qso.qsl_date, band: qso.band };
        }

        const band = qso.band || 'unknown';
        if (!entity.bands[band]) entity.bands[band] = { worked: false, confirmed: false };
        entity.bands[band].worked = true;
        if (qso.confirmed) entity.bands[band].confirmed = true;
    }

    return entities;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

// Great circle distance in km between two [lon, lat] points.
function haversineKm(from, to) {
    const toRad = d => d * Math.PI / 180;
    const [lon1, lat1] = from.map(toRad);
    const [lon2, lat2] = to.map(toRad);
    const dlat = lat2 - lat1, dlon = lon2 - lon1;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Generate n+1 points along the great circle between two [lon, lat] points.
// Consecutive longitudes are unwrapped so the line never jumps across the antimeridian.
function greatCirclePoints(from, to, n = 64) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const [lon1, lat1] = from.map(toRad);
    const [lon2, lat2] = to.map(toRad);

    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
    ));
    if (d === 0) return [from, to];

    const pts = [];
    for (let i = 0; i <= n; i++) {
        const f = i / n;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
        const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
        const z = A * Math.sin(lat1) + B * Math.sin(lat2);
        pts.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
    }

    // Unwrap: keep consecutive longitude deltas within ±180 so the arc stays short.
    for (let i = 1; i < pts.length; i++) {
        while (pts[i][0] - pts[i - 1][0] >  180) pts[i][0] -= 360;
        while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
    }
    return pts;
}

function fmtDatetime(iso) {
    if (!iso) return '?';
    return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

// Confirmed contacts → one marker per unique gridsquare (actual station location).
// Unconfirmed entities → one marker per entity at the CTY centroid.
function initMap(entities, contacts, qrzCache = {}, spotlight = {}, options = {}) {
    const homeGrid = (typeof CONFIG !== 'undefined' && CONFIG.homeGrid) ? CONFIG.homeGrid : 'EM69';
    const homeCoords = maidenheadToLatLon(homeGrid); // [lon, lat]

    const containerId = options.containerId || 'map';
    const projection  = options.projection  || 'mercator';

    const map = new maplibregl.Map({
        container: containerId,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [20, 20],
        zoom: projection === 'globe' ? 0.5 : 1.5,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
        if (projection === 'globe') {
            map.setProjection('globe');
            map.setFog({
                'space-color': '#0b0b19',
                'star-intensity': 0.6,
                'horizon-blend': 0.02,
                'high-color': '#245bdf',
                'color': '#bad2eb',
            });
        }

        // State / province boundary lines — uses the same vector tiles as the
        // base map (OpenMapTiles schema: source-layer 'boundary', admin_level 4).
        const vecSrc = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector');
        if (vecSrc) {
            map.addLayer({
                id: 'admin-state-lines',
                type: 'line',
                source: vecSrc[0],
                'source-layer': 'boundary',
                filter: ['all',
                    ['==', ['get', 'admin_level'], 4],
                    ['==', ['get', 'maritime'], 0],
                ],
                paint: {
                    'line-color': '#64748b',
                    'line-width': 0.8,
                    'line-opacity': 0.55,
                    'line-dasharray': [3, 2],
                },
            });
        }

        const features = [];

        // --- Confirmed: group by gridsquare ---
        const byGrid = {};
        for (const qso of contacts) {
            if (!qso.confirmed || !qso.gridsquare) continue;
            const grid = qso.gridsquare.toUpperCase();
            if (!byGrid[grid]) {
                const rawCountry = qso.country || '';
                const state = STATE_COUNTRIES.has(rawCountry.toUpperCase())
                    ? (qso.state || (qrzCache[qso.call] && qrzCache[qso.call].state) || '')
                    : '';
                byGrid[grid] = { grid, calls: [], datetimes: [], entityName: displayName(rawCountry), state };
            }
            byGrid[grid].calls.push(qso.call);
            if (qso.datetime) byGrid[grid].datetimes.push(qso.datetime);
        }

        for (const g of Object.values(byGrid)) {
            const coords = maidenheadToLatLon(g.grid);
            if (!coords) continue;
            const sorted     = [...g.datetimes].sort();
            const uniqueCalls = [...new Set(g.calls)];
            const callLabel  = uniqueCalls.length === 1
                ? uniqueCalls[0]
                : `${g.calls.length} contacts`;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: coords },
                properties: {
                    confirmed:  true,
                    grid:       g.grid,
                    entityName: g.state ? `${g.entityName} (${g.state})` : g.entityName,
                    callLabel,
                    first:      fmtDatetime(sorted[0]),
                    last:       fmtDatetime(sorted[sorted.length - 1]),
                },
            });
        }

        // --- Unconfirmed: one amber marker per entity that has any unconfirmed contacts ---
        // Uses unconfirmedCoords (QRZ or CTY centroid) — never the confirmed gridsquare,
        // so this marker is distinct from the green per-gridsquare confirmed markers.
        for (const entity of Object.values(entities)) {
            const anyUnconfirmed = Object.values(entity.bands).some(b => b.worked && !b.confirmed);
            if (!anyUnconfirmed || !entity.unconfirmedCoords) continue;
            const bandSummary = Object.entries(entity.bands)
                .sort(([a], [b]) => BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b))
                .map(([band]) => band)
                .join(', ');
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: entity.unconfirmedCoords },
                properties: {
                    confirmed: false,
                    name:      entity.name,
                    bandSummary,
                    first:     fmtDatetime(entity.first),
                    last:      fmtDatetime(entity.last),
                },
            });
        }

        map.addSource('entities', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features },
        });

        map.addLayer({
            id: 'entities-worked',
            type: 'circle',
            source: 'entities',
            filter: ['!', ['get', 'confirmed']],
            paint: {
                'circle-color': '#fbbf24',
                'circle-radius': 6,
                'circle-opacity': 0.5,
                'circle-stroke-color': '#92400e',
                'circle-stroke-width': 1.5,
                'circle-stroke-opacity': 1,
            },
        });

        map.addLayer({
            id: 'entities-confirmed',
            type: 'circle',
            source: 'entities',
            filter: ['get', 'confirmed'],
            paint: {
                'circle-color': '#34d399',
                'circle-radius': 7,
                'circle-opacity': 0.5,
                'circle-stroke-color': '#065f46',
                'circle-stroke-width': 1.5,
                'circle-stroke-opacity': 1,
            },
        });

        // Canvas-drawn X icons — avoids glyph dependency entirely.
        const makeXIcon = (color, size) => {
            const canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round';
            const m = size * 0.22;
            ctx.beginPath();
            ctx.moveTo(m, m);      ctx.lineTo(size-m, size-m);
            ctx.moveTo(size-m, m); ctx.lineTo(m,      size-m);
            ctx.stroke();
            return ctx.getImageData(0, 0, size, size);
        };
        map.addImage('x-worked',    makeXIcon('#92400e', 12));
        map.addImage('x-confirmed', makeXIcon('#065f46', 12));

        map.addLayer({
            id: 'entities-worked-x',
            type: 'symbol',
            source: 'entities',
            filter: ['!', ['get', 'confirmed']],
            layout: { 'icon-image': 'x-worked', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        });

        map.addLayer({
            id: 'entities-confirmed-x',
            type: 'symbol',
            source: 'entities',
            filter: ['get', 'confirmed'],
            layout: { 'icon-image': 'x-confirmed', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        });

        // Geodesic arc source — updated on hover, cleared on leave.
        const emptyLine = { type: 'FeatureCollection', features: [] };
        map.addSource('geodesic', { type: 'geojson', data: emptyLine });
        map.addLayer({
            id: 'geodesic-line',
            type: 'line',
            source: 'geodesic',
            paint: {
                'line-color': '#ffffff',
                'line-width': 2.5,
                'line-opacity': 0.6,
            },
        });

        const setArc = (targetCoords) => {
            if (!homeCoords || !targetCoords) return;
            map.getSource('geodesic').setData({
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: greatCirclePoints(homeCoords, targetCoords) },
                }],
            });
        };
        const clearArc = () => map.getSource('geodesic').setData(emptyLine);

        // Home location marker.
        if (homeCoords) {
            const el = document.createElement('div');
            el.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
                <line x1="1" y1="1" x2="13" y2="13" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="13" y1="1" x2="1" y2="13" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>
            </svg>`;
            new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(homeCoords).addTo(map);
        }

        // Pulsing spotlight rings for farthest contacts.
        const addSpotlight = (coords, color) => {
            const el = document.createElement('div');
            el.className = 'spotlight';
            el.style.color = color;
            new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coords).addTo(map);
        };
        if (spotlight.worked)    addSpotlight(spotlight.worked.coords,    spotlight.worked.confirmed ? '#34d399' : '#fbbf24');
        if (spotlight.confirmed) addSpotlight(spotlight.confirmed.coords, '#34d399');

        const ARC_COLORS = { 'entities-confirmed': '#34d399', 'entities-worked': '#fbbf24' };

        const hoverTip = new maplibregl.Popup({
            closeButton: false, closeOnClick: false, offset: 12, maxWidth: '240px',
        });

        const distLine = (coords) => {
            if (!homeCoords) return '';
            const km = haversineKm(homeCoords, coords);
            const val = distUnit === 'km' ? Math.round(km) : Math.round(km * 0.621371);
            return `<br><small>${val.toLocaleString()} ${distUnit}</small>`;
        };

        map.on('mouseenter', 'entities-confirmed', (ev) => {
            const p = ev.features[0].properties;
            const coords = ev.features[0].geometry.coordinates;
            map.getCanvas().style.cursor = 'pointer';
            map.setPaintProperty('geodesic-line', 'line-color', ARC_COLORS['entities-confirmed']);
            setArc(coords);
            const topLine = p.entityName
                ? `<strong>${p.entityName}</strong> &nbsp;<span style="color:#9ca3af">${p.callLabel} · ${p.grid}</span>`
                : `<strong>${p.callLabel}</strong> &nbsp;<span style="color:#9ca3af">${p.grid}</span>`;
            hoverTip.setLngLat(coords)
                .setHTML(topLine +
                    `<br><small>First: ${p.first}</small>` +
                    `<br><small>Last: &nbsp;${p.last}</small>` +
                    distLine(coords))
                .addTo(map);
        });

        map.on('mouseenter', 'entities-worked', (ev) => {
            const p = ev.features[0].properties;
            const coords = ev.features[0].geometry.coordinates;
            map.getCanvas().style.cursor = 'pointer';
            map.setPaintProperty('geodesic-line', 'line-color', ARC_COLORS['entities-worked']);
            setArc(coords);
            hoverTip.setLngLat(coords)
                .setHTML(`<strong>${p.name}</strong> &nbsp;<span style="color:#9ca3af">${p.bandSummary}</span>` +
                    `<br><small>First: ${p.first}</small>` +
                    `<br><small>Last: &nbsp;${p.last}</small>` +
                    distLine(coords))
                .addTo(map);
        });

        for (const layerId of ['entities-worked', 'entities-confirmed']) {
            map.on('mouseleave', layerId, () => {
                map.getCanvas().style.cursor = '';
                clearArc();
                hoverTip.remove();
            });
        }
    });

    return map;
}

// ---------------------------------------------------------------------------
// Scoreboard table
// ---------------------------------------------------------------------------

function makeEntityDateCell(obj) {
    const td = document.createElement('td');
    td.className = 'm-date';
    if (!obj || !obj.datetime) { td.classList.add('pending'); td.textContent = '—'; return td; }
    const date = obj.datetime.slice(0, 10);
    const time = obj.datetime.length > 10 ? obj.datetime.slice(11, 16) + ' UTC' : null;
    const top  = [date, time].filter(Boolean).join(' ');
    td.innerHTML = obj.band
        ? `${top}<br><small style="color:#9ca3af">${obj.band}</small>`
        : top;
    return td;
}

function buildTable(entities, refEntities) {
    const thead   = document.getElementById('table-head');
    const tbody   = document.getElementById('table-body');
    const summary = document.getElementById('entity-summary');

    const rows         = Object.values(entities);
    const workedCount  = rows.length;
    const confirmedCount = rows.filter(e => e.qslCount > 0).length;
    const totalCount   = (refEntities || []).length;
    if (summary) {
        summary.innerHTML = `<strong>${workedCount}</strong>${totalCount ? ` / ${totalCount}` : ''} entities worked &nbsp;·&nbsp; <strong>${confirmedCount}</strong> confirmed`;
    }

    const COLS = [
        { key: 'name',     label: 'Entity',    cls: '',         defaultDir:  1, get: e => e.name },
        { key: 'cont',     label: 'Cont',      cls: '',         defaultDir:  1, get: e => e.continent },
        { key: 'qsos',     label: 'QSOs',      cls: 'band-col', defaultDir: -1, get: e => e.qsoCount },
        { key: 'qsls',     label: 'QSLs',      cls: 'band-col', defaultDir: -1, get: e => e.qslCount },
        { key: 'bands',    label: 'Bands',     cls: '',         defaultDir: -1, get: e => Object.keys(e.bands).length },
        { key: 'firstQso', label: 'First QSO', cls: '',         defaultDir:  1, get: e => e.firstQso?.datetime ?? null },
        { key: 'firstQsl', label: 'First QSL', cls: '',         defaultDir:  1, get: e => e.firstQsl?.datetime ?? null },
        { key: 'lastQso',  label: 'Last QSO',  cls: '',         defaultDir: -1, get: e => e.lastQso?.datetime  ?? null },
        { key: 'lastQsl',  label: 'Last QSL',  cls: '',         defaultDir: -1, get: e => e.lastQsl?.datetime  ?? null },
    ];

    const getters = Object.fromEntries(COLS.map(c => [c.key, c.get]));

    thead.innerHTML = '';
    const headerRow = document.createElement('tr');
    const thEls = {};
    for (const col of COLS) {
        const th = document.createElement('th');
        if (col.cls) th.className = col.cls;
        th.style.cursor = 'pointer';
        th.title = `Sort by ${col.label}`;
        th.addEventListener('click', () => {
            if (sortKey === col.key) sortDir = -sortDir;
            else { sortKey = col.key; sortDir = col.defaultDir; }
            renderRows();
        });
        thEls[col.key] = { el: th, label: col.label };
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    let sortKey = 'qsls';
    let sortDir = -1;

    const cmpVal = (a, b, key, dir) => {
        const av = getters[key](a), bv = getters[key](b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number') return dir * (av - bv);
        return dir * String(av).localeCompare(String(bv));
    };

    const renderRows = () => {
        for (const col of COLS) {
            const { el, label } = thEls[col.key];
            el.textContent = sortKey === col.key ? `${label} ${sortDir === 1 ? '▲' : '▼'}` : label;
            el.style.color  = sortKey === col.key ? '#34d399' : '';
        }

        const sorted = [...rows].sort((a, b) => {
            const p = cmpVal(a, b, sortKey, sortDir);
            if (p !== 0) return p;
            if (sortKey !== 'qsls') { const c = cmpVal(a, b, 'qsls', -1); if (c) return c; }
            if (sortKey !== 'qsos') { const c = cmpVal(a, b, 'qsos', -1); if (c) return c; }
            if (sortKey !== 'name') { const c = cmpVal(a, b, 'name',  1); if (c) return c; }
            return 0;
        });

        tbody.innerHTML = '';
        for (const entity of sorted) {
            const tr = document.createElement('tr');

            const tdName = document.createElement('td');
            const ef = countryFlag(entity.name);
            tdName.textContent = ef ? `${ef} ${entity.name}` : entity.name;
            tr.appendChild(tdName);

            const tdCont = document.createElement('td');
            tdCont.textContent = entity.continent;
            tdCont.className = 'cont';
            tr.appendChild(tdCont);

            const tdQso = document.createElement('td');
            tdQso.className = 'band-cell';
            tdQso.textContent = entity.qsoCount;
            tdQso.style.color = '#fbbf24';
            tr.appendChild(tdQso);

            const tdQsl = document.createElement('td');
            tdQsl.className = 'band-cell';
            tdQsl.textContent = entity.qslCount || '—';
            tdQsl.style.color = entity.qslCount ? '#34d399' : '#4b5563';
            tr.appendChild(tdQsl);

            const tdBands = document.createElement('td');
            tdBands.className = 'm-date';
            tdBands.textContent = [
                ...BAND_ORDER.filter(b => entity.bands[b]),
                ...Object.keys(entity.bands).filter(b => !BAND_ORDER.includes(b)).sort(),
            ].join(' · ') || '—';
            tr.appendChild(tdBands);

            tr.appendChild(makeEntityDateCell(entity.firstQso));
            tr.appendChild(makeEntityDateCell(entity.firstQsl));
            tr.appendChild(makeEntityDateCell(entity.lastQso));
            tr.appendChild(makeEntityDateCell(entity.lastQsl));

            tbody.appendChild(tr);
        }
    };

    renderRows();
}

// ---------------------------------------------------------------------------
// Flag emoji helpers
// ---------------------------------------------------------------------------

const ENTITY_TO_ISO = {
    // North America
    'USA':'US', 'Canada':'CA', 'Mexico':'MX', 'Cuba':'CU', 'Jamaica':'JM',
    'Haiti':'HT', 'Dominican Republic':'DO', 'Puerto Rico':'PR',
    'Trinidad & Tobago':'TT', 'Bahamas':'BS', 'Barbados':'BB',
    'Saint Vincent':'VC', 'Saint Lucia':'LC', 'Grenada':'GD',
    'Antigua & Barbuda':'AG', 'Dominica':'DM', 'Saint Kitts & Nevis':'KN',
    'Costa Rica':'CR', 'Panama':'PA', 'Guatemala':'GT', 'Honduras':'HN',
    'El Salvador':'SV', 'Nicaragua':'NI', 'Belize':'BZ',
    'Guadeloupe':'GP', 'Martinique':'MQ', 'Aruba':'AW',
    // South America
    'Brasil':'BR', 'Argentina':'AR', 'Chile':'CL', 'Colombia':'CO',
    'Peru':'PE', 'Venezuela':'VE', 'Uruguay':'UY', 'Bolivia':'BO',
    'Paraguay':'PY', 'Ecuador':'EC', 'Guyana':'GY', 'Suriname':'SR',
    'French Guiana':'GF',
    // Europe
    'Germany':'DE', 'France':'FR', 'Spain':'ES', 'Italy':'IT',
    'United Kingdom':'GB', 'Netherlands':'NL', 'Belgium':'BE',
    'Switzerland':'CH', 'Austria':'AT', 'Sweden':'SE', 'Norway':'NO',
    'Denmark':'DK', 'Finland':'FI', 'Poland':'PL', 'Czechia':'CZ',
    'Slovakia':'SK', 'Hungary':'HU', 'Romania':'RO', 'Bulgaria':'BG',
    'Greece':'GR', 'Portugal':'PT', 'Russia (EU)':'RU', 'Russia (AS)':'RU',
    'Ukraine':'UA', 'Belarus':'BY', 'Lithuania':'LT', 'Latvia':'LV',
    'Estonia':'EE', 'Croatia':'HR', 'Slovenia':'SI', 'Serbia':'RS',
    'Bosnia-Herzegovina':'BA', 'Montenegro':'ME', 'N. Macedonia':'MK',
    'Albania':'AL', 'Kosovo':'XK', 'Moldova':'MD', 'Luxembourg':'LU',
    'Ireland':'IE', 'Iceland':'IS', 'Malta':'MT', 'Cyprus':'CY',
    'Andorra':'AD', 'Monaco':'MC', 'San Marino':'SM', 'Liechtenstein':'LI',
    'Gibraltar':'GI', 'Faroe Islands':'FO', 'Aland Islands':'AX',
    // Asia
    'Japan':'JP', 'China':'CN', 'South Korea':'KR', 'Taiwan':'TW',
    'Hong Kong':'HK', 'Philippines':'PH', 'Indonesia':'ID', 'Malaysia':'MY',
    'Thailand':'TH', 'Vietnam':'VN', 'India':'IN', 'Pakistan':'PK',
    'Bangladesh':'BD', 'Sri Lanka':'LK', 'Nepal':'NP', 'Myanmar':'MM',
    'Cambodia':'KH', 'Singapore':'SG', 'UAE':'AE', 'Saudi Arabia':'SA',
    'Israel':'IL', 'Jordan':'JO', 'Lebanon':'LB', 'Syria':'SY',
    'Iraq':'IQ', 'Iran':'IR', 'Kuwait':'KW', 'Qatar':'QA', 'Bahrain':'BH',
    'Oman':'OM', 'Yemen':'YE', 'Kazakhstan':'KZ', 'Uzbekistan':'UZ',
    'Azerbaijan':'AZ', 'Georgia':'GE', 'Armenia':'AM', 'Mongolia':'MN',
    'Brunei':'BN', 'Timor-Leste':'TL', 'Turkey (EU)':'TR', 'Turkey (AS)':'TR',
    'Maldives':'MV', 'Afghanistan':'AF', 'Kyrgyzstan':'KG', 'Tajikistan':'TJ',
    'Turkmenistan':'TM', 'Macau':'MO', 'North Korea':'KP',
    // Africa
    'South Africa':'ZA', 'Egypt':'EG', 'Nigeria':'NG', 'Kenya':'KE',
    'Ethiopia':'ET', 'Morocco':'MA', 'Tunisia':'TN', 'Algeria':'DZ',
    'Libya':'LY', 'Sudan':'SD', 'Tanzania':'TZ', 'Uganda':'UG',
    'Ghana':'GH', 'Cameroon':'CM', 'Senegal':'SN', 'Zimbabwe':'ZW',
    'Zambia':'ZM', 'Mozambique':'MZ', 'Madagascar':'MG', 'DR Congo':'CD',
    'Congo':'CG', 'Angola':'AO', 'Namibia':'NA', 'Botswana':'BW',
    'Eswatini':'SZ', 'South Sudan':'SS', 'C. African Rep.':'CF',
    'Rwanda':'RW', 'Burundi':'BI', 'Mali':'ML', 'Niger':'NE',
    'Chad':'TD', 'Somalia':'SO', 'Djibouti':'DJ', 'Eritrea':'ER',
    'Gabon':'GA', 'Equatorial Guinea':'GQ', 'Benin':'BJ', 'Togo':'TG',
    'Burkina Faso':'BF', "Côte d'Ivoire":'CI', 'Sierra Leone':'SL',
    'Liberia':'LR', 'Guinea':'GN', 'Guinea-Bissau':'GW',
    'Cape Verde':'CV', 'São Tomé & Príncipe':'ST', 'Comoros':'KM',
    'Mauritius':'MU', 'Reunion':'RE', 'Seychelles':'SC', 'Malawi':'MW',
    'Lesotho':'LS',
    // Oceania
    'Australia':'AU', 'New Zealand':'NZ', 'Papua New Guinea':'PG',
    'Fiji':'FJ', 'Solomon Islands':'SB', 'Vanuatu':'VU', 'Samoa':'WS',
    'Tonga':'TO', 'Kiribati':'KI', 'Micronesia':'FM', 'Palau':'PW',
    'Marshall Islands':'MH', 'Nauru':'NR', 'Tuvalu':'TV',
    'Cook Islands':'CK', 'Niue':'NU', 'Hawaii':'US',
    // DXCC sub-entities that map to a parent country flag
    'England':'GB', 'Scotland':'GB', 'Wales':'GB', 'Northern Ireland':'GB',
    'Sicily':'IT', 'Sardinia':'IT',
    'Montserrat':'MS', 'Anguilla':'AI', 'Cayman Islands':'KY',
    'Turks & Caicos Islands':'TC', 'British Virgin Islands':'VG',
    'US Virgin Islands':'VI', 'Guam':'GU', 'American Samoa':'AS',
    'Northern Mariana Islands':'MP',
    'Svalbard':'SJ', 'Jan Mayen':'SJ',
    'Azores':'PT', 'Madeira':'PT', 'Canary Islands':'ES', 'Ceuta & Melilla':'ES',
    'French Polynesia':'PF', 'New Caledonia':'NC', 'Wallis & Futuna':'WF',
    'Reunion':'RE', 'Mayotte':'YT', 'Saint Pierre & Miquelon':'PM',
};

const flagEmoji = (isoCode) => {
    if (!isoCode || isoCode.length !== 2) return '';
    return [...isoCode.toUpperCase()]
        .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
        .join('');
};

const _entityToIsoUC = Object.fromEntries(
    Object.entries(ENTITY_TO_ISO).map(([k, v]) => [k.toUpperCase(), v])
);

const countryFlag = (displayedName) => {
    if (!displayedName) return '';
    const iso = _entityToIsoUC[displayedName.toUpperCase()];
    return iso ? flagEmoji(iso) : '';
};

// ---------------------------------------------------------------------------
// Call sign table
// ---------------------------------------------------------------------------

// Title-case country names that LoTW returns in ALL-CAPS.
// Short abbreviations (USA, UAE, SMOM ≤ 4 chars) are left unchanged.
const normalizeCountryName = (raw) => {
    if (!raw) return '';
    const dn = displayName(raw);
    if (dn === dn.toUpperCase() && dn.length > 4 && /[A-Z]{2}/.test(dn))
        return dn.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    return dn;
};

function makeDateCell(isoStr) {
    const td = document.createElement('td');
    td.className = 'm-date';
    if (!isoStr) { td.classList.add('pending'); td.textContent = '—'; return td; }
    const date = isoStr.slice(0, 10);
    const time = isoStr.length > 10 ? isoStr.slice(11, 16) + ' UTC' : null;
    td.textContent = time ? `${date} ${time}` : date;
    return td;
}

function buildCallsignTable(contacts, qrzCache = {}) {
    const summary = document.getElementById('callsigns-summary');
    const thead   = document.querySelector('#callsigns-table thead');
    const tbody   = document.getElementById('callsigns-body');
    if (!summary || !thead || !tbody) return;

    const byKey = {};
    for (const qso of contacts) {
        const grid = qso.gridsquare || '';
        const key  = `${qso.call}\0${grid}`;
        if (!byKey[key]) {
            byKey[key] = { call: qso.call, grid, country: '', state: null, count: 0,
                           firstQso: null, lastQso: null, firstQsl: null, lastQsl: null };
        }
        const r = byKey[key];
        r.count++;
        if (!r.country && qso.country) r.country = normalizeCountryName(qso.country);
        if (!r.state && STATE_COUNTRIES.has((qso.country || '').toUpperCase()))
            r.state = regionStateOf(qso, qrzCache);
        if (qso.datetime) {
            if (!r.firstQso || qso.datetime < r.firstQso) r.firstQso = qso.datetime;
            if (!r.lastQso  || qso.datetime > r.lastQso)  r.lastQso  = qso.datetime;
        }
        if (qso.confirmed && qso.qsl_date) {
            if (!r.firstQsl || qso.qsl_date < r.firstQsl) r.firstQsl = qso.qsl_date;
            if (!r.lastQsl  || qso.qsl_date > r.lastQsl)  r.lastQsl  = qso.qsl_date;
        }
    }

    const rows = Object.values(byKey);
    summary.innerHTML = `<strong>${rows.length}</strong> unique call sign / grid combinations · <strong>${contacts.length}</strong> QSOs total`;

    const COLS = [
        { key: 'call',     label: 'Call sign', defaultDir:  1 },
        { key: 'grid',     label: 'Grid',      defaultDir:  1 },
        { key: 'country',  label: 'Country',   defaultDir:  1 },
        { key: 'count',    label: '#',         defaultDir: -1 },
        { key: 'firstQso', label: 'First QSO', defaultDir: -1 },
        { key: 'firstQsl', label: 'First QSL', defaultDir: -1 },
        { key: 'lastQso',  label: 'Last QSO',  defaultDir: -1 },
        { key: 'lastQsl',  label: 'Last QSL',  defaultDir: -1 },
    ];

    // Build sortable header
    thead.innerHTML = '';
    const headerRow = document.createElement('tr');
    const thNo = document.createElement('th');
    thNo.textContent = 'No.';
    headerRow.appendChild(thNo);
    const thEls = {};
    for (const col of COLS) {
        const th = document.createElement('th');
        th.style.cursor = 'pointer';
        th.title = `Sort by ${col.label}`;
        th.addEventListener('click', () => {
            if (sortKey === col.key) sortDir = -sortDir;
            else { sortKey = col.key; sortDir = col.defaultDir; }
            renderRows();
        });
        thEls[col.key] = { el: th, label: col.label };
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    let sortKey = 'count';
    let sortDir = -1;

    // Compare two row values; nulls always sort to the end regardless of direction.
    const cmpVal = (a, b, key, dir) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (key === 'count') return dir * (av - bv);
        return dir * String(av).localeCompare(String(bv));
    };

    const renderRows = () => {
        // Update header labels with sort indicator
        for (const col of COLS) {
            const { el, label } = thEls[col.key];
            el.textContent = sortKey === col.key ? `${label} ${sortDir === 1 ? '▲' : '▼'}` : label;
            el.style.color  = sortKey === col.key ? '#34d399' : '';
        }

        const sorted = [...rows].sort((a, b) => {
            const p = cmpVal(a, b, sortKey, sortDir);
            if (p !== 0) return p;
            // Tie-break: count desc → firstQsl desc (nulls last) → firstQso desc
            if (sortKey !== 'count')    { const c = cmpVal(a, b, 'count',    -1); if (c) return c; }
            if (sortKey !== 'firstQsl') { const c = cmpVal(a, b, 'firstQsl', -1); if (c) return c; }
            if (sortKey !== 'firstQso') { const c = cmpVal(a, b, 'firstQso', -1); if (c) return c; }
            return 0;
        });

        tbody.innerHTML = '';
        sorted.forEach((r, i) => {
            const tr = document.createElement('tr');

            const tdNo = document.createElement('td');
            tdNo.className = 'm-date';
            tdNo.style.color = '#6b7280';
            tdNo.textContent = i + 1;
            tr.appendChild(tdNo);

            const tdCall = document.createElement('td');
            tdCall.className = 'm-label';
            tdCall.textContent = r.call;
            tr.appendChild(tdCall);

            const tdGrid = document.createElement('td');
            tdGrid.className = 'm-date';
            tdGrid.textContent = r.grid || '—';
            tr.appendChild(tdGrid);

            const tdCountry = document.createElement('td');
            tdCountry.className = 'm-date';
            const flag = countryFlag(r.country);
            const countryStr = r.state ? `${r.country} (${r.state})` : (r.country || '—');
            tdCountry.textContent = flag ? `${flag} ${countryStr}` : countryStr;
            tr.appendChild(tdCountry);

            const tdCount = document.createElement('td');
            tdCount.className = 'm-date';
            tdCount.textContent = r.count;
            tr.appendChild(tdCount);

            tr.appendChild(makeDateCell(r.firstQso));
            tr.appendChild(makeDateCell(r.firstQsl));
            tr.appendChild(makeDateCell(r.lastQso));
            tr.appendChild(makeDateCell(r.lastQsl));

            tbody.appendChild(tr);
        });
    };

    renderRows();
}

// ---------------------------------------------------------------------------
// Milestones table
// ---------------------------------------------------------------------------

const CONT_NAMES = { NA: 'North America', SA: 'South America', EU: 'Europe',
                     AF: 'Africa', AS: 'Asia', OC: 'Oceania', AN: 'Antarctica' };

function buildMilestones(contacts) {
    const tbody = document.getElementById('milestones-body');

    // Two separate sorted lists: QSOs by datetime, confirmed by qsl_date.
    const byDatetime = [...contacts].filter(q => q.datetime)
        .sort((a, b) => a.datetime.localeCompare(b.datetime));
    const byQslDate  = [...contacts].filter(q => q.confirmed && q.qsl_date)
        .sort((a, b) => a.qsl_date.localeCompare(b.qsl_date));

    // Returns { date, call, grid } for the "first QSO" and "first QSL" for a given criterion.
    const firstPair = (qsoList, qslList) => ({
        qso: qsoList[0] || null,
        qsl: qslList[0] || null,
    });

    const rows = [];

    // --- General ---
    rows.push({ section: 'General' });
    rows.push({ label: 'First contact', ...firstPair(byDatetime, byQslDate) });

    // --- First per continent ---
    rows.push({ section: 'First contact by continent' });
    const firstQsoByCont = {}, firstQslByCont = {};
    for (const q of byDatetime) {
        if (q.continent && !firstQsoByCont[q.continent]) firstQsoByCont[q.continent] = q;
    }
    for (const q of byQslDate) {
        if (q.continent && !firstQslByCont[q.continent]) firstQslByCont[q.continent] = q;
    }
    for (const cont of CONT_ORDER) {
        rows.push({
            label: CONT_NAMES[cont] || cont,
            qso:   firstQsoByCont[cont] || null,
            qsl:   firstQslByCont[cont] || null,
        });
    }

    // --- Count milestones ---
    rows.push({ section: 'Contact count milestones' });
    for (const n of [10, 20, 30, 40, 50, 60]) {
        rows.push({
            label: `${n} contacts`,
            qso:   byDatetime[n - 1]  || null,
            qsl:   byQslDate[n - 1]   || null,
        });
    }

    // --- Render ---
    for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.section !== undefined) {
            tr.className = 'm-section';
            const td = document.createElement('td');
            td.colSpan = 3;
            td.textContent = row.section;
            tr.appendChild(td);
        } else {
            const label = document.createElement('td');
            label.className = 'm-label';
            label.textContent = row.label;
            tr.appendChild(label);
            tr.appendChild(makeContactCell(row.qso, 'datetime'));
            tr.appendChild(makeContactCell(row.qsl, 'qsl_date'));
        }
        tbody.appendChild(tr);
    }
}

// ---------------------------------------------------------------------------
// US States table
// ---------------------------------------------------------------------------

const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

// ---------------------------------------------------------------------------
// Shared helpers for regional tables (US States, Canada, Europe)
// ---------------------------------------------------------------------------

const isUS = (qso) => {
    const c = qso.call.toUpperCase();
    return /^(K|W|N|AA|AB|AC|AD|AE|AF|AG|AH|AI|AJ|AK)[0-9]/.test(c)
        || (qso.country || '').toUpperCase().includes('UNITED STATES');
};

const isCanada = (qso) => {
    const c = qso.call.toUpperCase();
    return /^(VE|VA|VO|VY)[0-9]/.test(c)
        || (qso.country || '').toUpperCase() === 'CANADA';
};

// Returns the 2-letter state/province from LoTW field or QRZ cache.
const regionStateOf = (qso, qrzCache) => {
    if (qso.state) {
        const st = qso.state.split(' //')[0].trim().toUpperCase();
        if (st) return st;
    }
    const qrz = qrzCache[qso.call];
    return (qrz && qrz.state) ? qrz.state.toUpperCase() : null;
};

// Renders a table cell with date + callsign·grid sub-line.
function makeContactCell(qso, dateField = 'datetime') {
    const td = document.createElement('td');
    td.className = 'm-date';
    if (!qso) {
        td.classList.add('pending');
        td.textContent = '—';
        return td;
    }
    const raw  = dateField === 'qsl_date' ? (qso.qsl_date || '') : (qso.datetime || '');
    const date = raw.slice(0, 10);
    const time = raw.length > 10 ? raw.slice(11, 16) + ' UTC' : null;
    const sub  = [qso.call, qso.gridsquare].filter(Boolean).join(' · ');
    const top  = [date, time].filter(Boolean).join(' ');
    td.innerHTML = `${top}<br><small style="color:#9ca3af">${sub}</small>`;
    return td;
}

const US_STATE_NAMES = {
    AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
    CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
    HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
    KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
    MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri',
    MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey',
    NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio',
    OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina',
    SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont',
    VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
};

function buildUsStates(contacts, qrzCache) {
    const summary = document.getElementById('states-summary');
    const note    = document.getElementById('states-note');

    const agg = {};
    for (const qso of contacts) {
        if (!isUS(qso)) continue;
        const st = regionStateOf(qso, qrzCache);
        if (!st || !US_STATES.includes(st)) continue;
        if (!agg[st]) agg[st] = { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null };
        const e = agg[st];
        e.qsoCount++;
        if (qso.band) e.bands[qso.band] = true;
        if (qso.datetime) {
            if (!e.firstQso || qso.datetime < e.firstQso.datetime)
                e.firstQso = { datetime: qso.datetime, band: qso.band };
            if (!e.lastQso  || qso.datetime > e.lastQso.datetime)
                e.lastQso  = { datetime: qso.datetime, band: qso.band };
        }
        if (qso.confirmed) {
            e.qslCount++;
            if (qso.qsl_date) {
                if (!e.firstQsl || qso.qsl_date < e.firstQsl.datetime)
                    e.firstQsl = { datetime: qso.qsl_date, band: qso.band };
                if (!e.lastQsl  || qso.qsl_date > e.lastQsl.datetime)
                    e.lastQsl  = { datetime: qso.qsl_date, band: qso.band };
            }
        }
    }

    const hasQrz         = Object.keys(qrzCache).length > 0;
    const rows           = US_STATES.map(st => ({
        label: `${US_STATE_NAMES[st]} (${st})`,
        ...(agg[st] || { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null }),
    }));
    const workedCount    = rows.filter(r => r.qsoCount > 0).length;
    const confirmedCount = rows.filter(r => r.qslCount > 0).length;

    summary.innerHTML = (hasQrz && workedCount > 0)
        ? `<strong>${workedCount}</strong> / 50 states worked &nbsp;·&nbsp; <strong>${confirmedCount}</strong> confirmed`
        : '';
    note.textContent = !hasQrz ? 'State data requires QRZ lookup — run ./qrz_fetch then reload.' : '';

    buildRegionTable({ theadId: 'states-head', tbodyId: 'states-body', rows, nameLabel: 'State' });
}

// ---------------------------------------------------------------------------
// Canada provinces table
// ---------------------------------------------------------------------------

const CA_PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];
const CA_PROVINCE_NAMES = {
    AB:'Alberta', BC:'British Columbia', MB:'Manitoba', NB:'New Brunswick',
    NL:'Newfoundland & Labrador', NS:'Nova Scotia', NT:'Northwest Territories',
    NU:'Nunavut', ON:'Ontario', PE:'Prince Edward Island', QC:'Québec',
    SK:'Saskatchewan', YT:'Yukon',
};

function buildCanadaProvinces(contacts, qrzCache) {
    const summary = document.getElementById('canada-summary');
    const note    = document.getElementById('canada-note');

    const agg = {};
    for (const qso of contacts) {
        if (!isCanada(qso)) continue;
        const prov = regionStateOf(qso, qrzCache);
        if (!prov || !CA_PROVINCES.includes(prov)) continue;
        if (!agg[prov]) agg[prov] = { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null };
        const e = agg[prov];
        e.qsoCount++;
        if (qso.band) e.bands[qso.band] = true;
        if (qso.datetime) {
            if (!e.firstQso || qso.datetime < e.firstQso.datetime)
                e.firstQso = { datetime: qso.datetime, band: qso.band };
            if (!e.lastQso  || qso.datetime > e.lastQso.datetime)
                e.lastQso  = { datetime: qso.datetime, band: qso.band };
        }
        if (qso.confirmed) {
            e.qslCount++;
            if (qso.qsl_date) {
                if (!e.firstQsl || qso.qsl_date < e.firstQsl.datetime)
                    e.firstQsl = { datetime: qso.qsl_date, band: qso.band };
                if (!e.lastQsl  || qso.qsl_date > e.lastQsl.datetime)
                    e.lastQsl  = { datetime: qso.qsl_date, band: qso.band };
            }
        }
    }

    const hasQrz         = Object.keys(qrzCache).length > 0;
    const rows           = CA_PROVINCES.map(prov => ({
        label: `${CA_PROVINCE_NAMES[prov]} (${prov})`,
        ...(agg[prov] || { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null }),
    }));
    const workedCount    = rows.filter(r => r.qsoCount > 0).length;
    const confirmedCount = rows.filter(r => r.qslCount > 0).length;

    summary.innerHTML = (hasQrz && workedCount > 0)
        ? `<strong>${workedCount}</strong> / 13 provinces & territories worked &nbsp;·&nbsp; <strong>${confirmedCount}</strong> confirmed`
        : '';
    note.textContent = !hasQrz ? 'Province data requires QRZ lookup — run ./qrz_fetch then reload.' : '';

    buildRegionTable({ theadId: 'canada-head', tbodyId: 'canada-body', rows, nameLabel: 'Province / Territory' });
}

// ---------------------------------------------------------------------------
// Shared sortable region table builder (states, provinces, continent entities)
// ---------------------------------------------------------------------------

function buildRegionTable({ theadId, tbodyId, rows, nameLabel = 'Entity', hasFlag = false }) {
    const thead = document.getElementById(theadId);
    const tbody = document.getElementById(tbodyId);
    if (!thead || !tbody) return;

    const COLS = [
        { key: 'name',     label: nameLabel,   cls: '',         defaultDir:  1, get: r => r.label },
        { key: 'qsos',     label: 'QSOs',      cls: 'band-col', defaultDir: -1, get: r => r.qsoCount },
        { key: 'qsls',     label: 'QSLs',      cls: 'band-col', defaultDir: -1, get: r => r.qslCount },
        { key: 'bands',    label: 'Bands',     cls: '',         defaultDir: -1, get: r => Object.keys(r.bands).length },
        { key: 'firstQso', label: 'First QSO', cls: '',         defaultDir:  1, get: r => r.firstQso?.datetime ?? null },
        { key: 'firstQsl', label: 'First QSL', cls: '',         defaultDir:  1, get: r => r.firstQsl?.datetime ?? null },
        { key: 'lastQso',  label: 'Last QSO',  cls: '',         defaultDir: -1, get: r => r.lastQso?.datetime  ?? null },
        { key: 'lastQsl',  label: 'Last QSL',  cls: '',         defaultDir: -1, get: r => r.lastQsl?.datetime  ?? null },
    ];

    const getters = Object.fromEntries(COLS.map(c => [c.key, c.get]));

    thead.innerHTML = '';
    const headerRow = document.createElement('tr');
    const thEls = {};
    for (const col of COLS) {
        const th = document.createElement('th');
        if (col.cls) th.className = col.cls;
        th.style.cursor = 'pointer';
        th.title = `Sort by ${col.label}`;
        th.addEventListener('click', () => {
            if (sortKey === col.key) sortDir = -sortDir;
            else { sortKey = col.key; sortDir = col.defaultDir; }
            renderRows();
        });
        thEls[col.key] = { el: th, label: col.label };
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    let sortKey = 'qsls';
    let sortDir = -1;

    const cmpVal = (a, b, key, dir) => {
        const av = getters[key](a), bv = getters[key](b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number') return dir * (av - bv);
        return dir * String(av).localeCompare(String(bv));
    };

    const renderRows = () => {
        for (const col of COLS) {
            const { el, label } = thEls[col.key];
            el.textContent = sortKey === col.key ? `${label} ${sortDir === 1 ? '▲' : '▼'}` : label;
            el.style.color  = sortKey === col.key ? '#34d399' : '';
        }

        const sorted = [...rows].sort((a, b) => {
            const p = cmpVal(a, b, sortKey, sortDir);
            if (p !== 0) return p;
            if (sortKey !== 'qsls') { const c = cmpVal(a, b, 'qsls', -1); if (c) return c; }
            if (sortKey !== 'qsos') { const c = cmpVal(a, b, 'qsos', -1); if (c) return c; }
            if (sortKey !== 'name') { const c = cmpVal(a, b, 'name',  1); if (c) return c; }
            return 0;
        });

        tbody.innerHTML = '';
        for (const row of sorted) {
            const tr = document.createElement('tr');

            const tdName = document.createElement('td');
            tdName.className = 'm-label';
            tdName.textContent = (hasFlag && row.flag) ? `${row.flag} ${row.label}` : row.label;
            tr.appendChild(tdName);

            const tdQso = document.createElement('td');
            tdQso.className = 'band-cell';
            tdQso.textContent = row.qsoCount || '—';
            tdQso.style.color = row.qsoCount ? '#fbbf24' : '#4b5563';
            tr.appendChild(tdQso);

            const tdQsl = document.createElement('td');
            tdQsl.className = 'band-cell';
            tdQsl.textContent = row.qslCount || '—';
            tdQsl.style.color = row.qslCount ? '#34d399' : '#4b5563';
            tr.appendChild(tdQsl);

            const tdBands = document.createElement('td');
            tdBands.className = 'm-date';
            tdBands.textContent = [
                ...BAND_ORDER.filter(b => row.bands[b]),
                ...Object.keys(row.bands).filter(b => !BAND_ORDER.includes(b)).sort(),
            ].join(' · ') || '—';
            tr.appendChild(tdBands);

            tr.appendChild(makeEntityDateCell(row.firstQso));
            tr.appendChild(makeEntityDateCell(row.firstQsl));
            tr.appendChild(makeEntityDateCell(row.lastQso));
            tr.appendChild(makeEntityDateCell(row.lastQsl));

            tbody.appendChild(tr);
        }
    };

    renderRows();
}

// ---------------------------------------------------------------------------
// Continent entity tables (Europe, South America, Africa, Asia, Oceania)
// ---------------------------------------------------------------------------

// Stable uppercase key: prefers LoTW country field; falls back to prefix lookup
// for contacts where LoTW returned continent but left country blank (e.g. Ukraine).
function entityKeyFor(qso, prefixLookup) {
    const c = qso.country || (lookupEntityByCall(qso.call, prefixLookup) || {}).name || '';
    return (displayName(c) || c).toUpperCase();
}

function buildContinentEntities(contacts, refEntities, prefixLookup, contCode) {
    const id      = contCode.toLowerCase();
    const summary = document.getElementById(`${id}-summary`);
    if (!summary) return;

    const agg = {};
    for (const qso of contacts) {
        if (qso.continent !== contCode) continue;
        const key = entityKeyFor(qso, prefixLookup);
        if (!key) continue;
        if (!agg[key]) agg[key] = { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null };
        const e = agg[key];
        e.qsoCount++;
        if (qso.band) e.bands[qso.band] = true;
        if (qso.datetime) {
            if (!e.firstQso || qso.datetime < e.firstQso.datetime)
                e.firstQso = { datetime: qso.datetime, band: qso.band };
            if (!e.lastQso  || qso.datetime > e.lastQso.datetime)
                e.lastQso  = { datetime: qso.datetime, band: qso.band };
        }
        if (qso.confirmed) {
            e.qslCount++;
            if (qso.qsl_date) {
                if (!e.firstQsl || qso.qsl_date < e.firstQsl.datetime)
                    e.firstQsl = { datetime: qso.qsl_date, band: qso.band };
                if (!e.lastQsl  || qso.qsl_date > e.lastQsl.datetime)
                    e.lastQsl  = { datetime: qso.qsl_date, band: qso.band };
            }
        }
    }

    const rows = (refEntities || [])
        .filter(e => e.continent === contCode)
        .map(e => {
            const display = displayName(e.name) || e.name;
            const key     = display.toUpperCase();
            return {
                label: display,
                flag:  countryFlag(display),
                ...(agg[key] || { qsoCount: 0, qslCount: 0, bands: {}, firstQso: null, lastQso: null, firstQsl: null, lastQsl: null }),
            };
        });

    const workedCount    = rows.filter(r => r.qsoCount > 0).length;
    const confirmedCount = rows.filter(r => r.qslCount > 0).length;

    summary.innerHTML = `<strong>${workedCount}</strong> / ${rows.length} ${CONT_NAMES[contCode] || contCode} entities worked &nbsp;·&nbsp; <strong>${confirmedCount}</strong> confirmed`;

    buildRegionTable({ theadId: `${id}-head`, tbodyId: `${id}-body`, rows, nameLabel: 'Entity', hasFlag: true });
}

// ---------------------------------------------------------------------------
// Globe.gl 3D globe view
// ---------------------------------------------------------------------------

function initGlobeView(entities, contacts, qrzCache) {
    const homeGrid   = (typeof CONFIG !== 'undefined' && CONFIG.homeGrid) ? CONFIG.homeGrid : 'EM69';
    const callsign   = (typeof CONFIG !== 'undefined' && CONFIG.callsign) ? CONFIG.callsign : '';
    const homeCoords = maidenheadToLatLon(homeGrid);
    const [homeLon, homeLat] = homeCoords;

    // --- Confirmed: one point per unique gridsquare ---
    const byGrid = {};
    for (const qso of contacts) {
        if (!qso.confirmed || !qso.gridsquare) continue;
        const grid   = qso.gridsquare.toUpperCase();
        const coords = maidenheadToLatLon(grid);
        if (!coords) continue;
        const [lon, lat] = coords;
        const rawCountry = qso.country || '';
        const state = STATE_COUNTRIES.has(rawCountry.toUpperCase())
            ? (qso.state || (qrzCache[qso.call] && qrzCache[qso.call].state) || '') : '';
        const label = state
            ? `${displayName(rawCountry)} (${state})` : (displayName(rawCountry) || rawCountry);
        if (!byGrid[grid]) byGrid[grid] = { lat, lon, grid, calls: [], datetimes: [], label, confirmed: true };
        byGrid[grid].calls.push(qso.call);
        if (qso.datetime) byGrid[grid].datetimes.push(qso.datetime);
    }

    // --- Unconfirmed: one point per entity (never confirmed, has coords) ---
    const unconfirmed = Object.values(entities)
        .filter(e => !Object.values(e.bands).some(b => b.confirmed) && e.unconfirmedCoords)
        .map(e => ({ lat: e.unconfirmedCoords[1], lon: e.unconfirmedCoords[0], label: e.name, confirmed: false }));

    const allPoints = [...Object.values(byGrid), ...unconfirmed];

    // --- Home marker ---
    const homePoint = { lat: homeLat, lon: homeLon, label: `${callsign} — Home`, grid: homeGrid, isHome: true };

    // --- Arcs: home → every contact point ---
    const arcs = allPoints.map(p => ({
        startLat: homeLat, startLng: homeLon,
        endLat:   p.lat,   endLng:   p.lon,
        confirmed: p.confirmed,
        offset: Math.random(),
    }));

    // --- Tooltip HTML ---
    const tipHtml = (d) => {
        if (d.isHome) return `<div class="g-tip"><b>${d.label}</b><br>${d.grid}</div>`;
        const dates  = (d.datetimes || []).sort();
        const first  = dates[0]?.slice(0, 10) || '';
        const last   = dates.at(-1)?.slice(0, 10) || '';
        const callTx = d.calls
            ? (d.calls.length === 1 ? d.calls[0] : `${d.calls.length} stations`) : '';
        return `<div class="g-tip">
            <b>${d.label}</b>${callTx ? ' · ' + callTx : ''}<br>
            ${d.grid ? d.grid + '<br>' : ''}
            ${first}${first !== last ? ' → ' + last : ''}
        </div>`;
    };

    const container = document.getElementById('globe');
    const status    = document.getElementById('globe-status');

    const GlobeFn = window.Globe;
    if (typeof GlobeFn !== 'function') {
        if (status) status.textContent = '✗ Globe.gl not loaded (window.Globe is ' + typeof GlobeFn + ')';
        throw new Error('window.Globe is not a function');
    }
    if (status) status.textContent = '✓ Globe.gl v2.46.1 — initializing…';

    const globe = GlobeFn()
        .globeImageUrl('vendor/earth-night.jpg')
        .backgroundColor('#0b0b19')
        .atmosphereColor('#4a8fe8')
        .atmosphereAltitude(0.12)
        .pointsData([...allPoints, homePoint])
        .pointLat('lat')
        .pointLng('lon')
        .pointColor(d => d.isHome ? '#ffffff' : (d.confirmed ? '#34d399' : '#fbbf24'))
        .pointRadius(d => d.isHome ? 0.7 : 0.45)
        .pointAltitude(0.01)
        .pointLabel(tipHtml)
        .arcsData(arcs)
        .arcStartLat('startLat')
        .arcStartLng('startLng')
        .arcEndLat('endLat')
        .arcEndLng('endLng')
        .arcColor(d => d.confirmed ? '#34d39988' : '#fbbf2488')
        .arcStroke(1.0)
        .arcAltitude(0)
        .arcDashLength(1)
        .arcDashGap(0)
        .arcDashAnimateTime(0)
        (container);

    if (status) status.textContent = '✓ Globe.gl v2.46.1';

    globe._resize = () => globe.width(container.clientWidth).height(container.clientHeight);

    return globe;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
    // Apply callsign from config to page title and header.
    const callsign = (typeof CONFIG !== 'undefined' && CONFIG.callsign) ? CONFIG.callsign : '';
    const title = callsign ? `${callsign} — DXCC Dashboard` : 'DXCC Dashboard';
    document.title = title;
    document.getElementById('page-title').textContent = title;

    let contacts, refData;
    try {
        [contacts, refData] = await Promise.all([
            fetch(DATA_URL).then(r => {
                if (!r.ok) throw new Error(`Could not load contacts (HTTP ${r.status}): ${DATA_URL}`);
                return r.json();
            }),
            fetch(REF_URL).then(r => {
                if (!r.ok) throw new Error(`Could not load DXCC reference (HTTP ${r.status}): ${REF_URL}`);
                return r.json();
            }),
        ]);
    } catch (err) {
        document.getElementById('stats').textContent = `Error: ${err.message}`;
        return;
    }

    // QRZ cache is optional — absent when the user hasn't run qrz_fetch or has no subscription.
    const qrzCache = await fetch(QRZ_URL)
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));

    const refEntities = refData.entities;
    if (!Array.isArray(refEntities) || refEntities.length === 0) {
        console.warn('DXCC reference file loaded but contains no entities — coordinate fallback disabled.');
    }

    const prefixLookup = buildPrefixLookup(refEntities || []);
    const nameLookup   = buildNameLookup(refEntities || []);
    const entities     = aggregate(contacts, prefixLookup, qrzCache, nameLookup);
    const entityList   = Object.values(entities);

    // Collect bands present in the data, keeping canonical order; append any
    // non-standard bands (e.g. 60m, 4m) sorted alphabetically after.
    const bandSet = new Set(entityList.flatMap(e => Object.keys(e.bands)));
    const activeBands = [
        ...BAND_ORDER.filter(b => bandSet.has(b)),
        ...[...bandSet].filter(b => !BAND_ORDER.includes(b)).sort(),
    ];

    // Find farthest worked and farthest confirmed entities.
    const homeGrid   = (typeof CONFIG !== 'undefined' && CONFIG.homeGrid) ? CONFIG.homeGrid : 'EM69';
    const homeCoords = maidenheadToLatLon(homeGrid);

    let topWorked = null, topWorkedDist = 0;
    let topConfirmed = null, topConfirmedDist = 0;

    if (homeCoords) {
        for (const entity of entityList) {
            if (!entity.coords) continue;
            const d = haversineKm(homeCoords, entity.coords);
            const isConfirmed = Object.values(entity.bands).some(b => b.confirmed);
            if (d > topWorkedDist) { topWorkedDist = d; topWorked = { entity, dist: d, confirmed: isConfirmed }; }
            if (isConfirmed && d > topConfirmedDist) { topConfirmedDist = d; topConfirmed = { entity, dist: d }; }
        }
    }

    // Build spotlight info for initMap — only show farthest confirmed separately
    // when it differs from the farthest worked entity.
    const spotlight = {};
    if (topWorked) {
        spotlight.worked = { coords: topWorked.entity.coords, confirmed: topWorked.confirmed };
    }
    if (topConfirmed && topConfirmed.entity !== topWorked?.entity) {
        spotlight.confirmed = { coords: topConfirmed.entity.coords };
    }

    const map = initMap(entities, contacts, qrzCache, spotlight);

    // Register tab handler and km/mi toggle immediately — before any builder
    // runs — so a thrown builder never prevents tab switching from working.
    document.getElementById('legend').addEventListener('click', (ev) => {
        const btn = ev.target.closest('.unit-btn');
        if (!btn) return;
        distUnit = btn.dataset.unit;
        document.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.unit === distUnit));
    });

    let globeMap = null;
    document.getElementById('tab-bar').addEventListener('click', (ev) => {
        const btn = ev.target.closest('.tab');
        if (!btn) return;
        const target = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
        if (target === 'map') {
            map.resize();
        } else if (target === 'globe') {
            if (!globeMap) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    try {
                        globeMap = initGlobeView(entities, contacts, qrzCache);
                    } catch (err) {
                        document.getElementById('globe').textContent = `Globe error: ${err.message}`;
                    }
                }));
            } else {
                globeMap._resize();
            }
        }
    });

    // Populate all data panels (each wrapped so one failure cannot block others).
    const builders = [
        () => buildCallsignTable(contacts, qrzCache),
        () => buildTable(entities, refEntities),
        () => buildMilestones(contacts),
        () => buildUsStates(contacts, qrzCache),
        () => buildCanadaProvinces(contacts, qrzCache),
        ...['EU', 'SA', 'AF', 'AS', 'OC'].map(c =>
            () => buildContinentEntities(contacts, refEntities, prefixLookup, c)),
    ];
    for (const fn of builders) {
        try { fn(); } catch (err) { console.error('Builder error:', err); }
    }

    const workedCount    = entityList.length;
    const confirmedCount = entityList.filter(e => Object.values(e.bands).some(b => b.confirmed)).length;
    const noCoordCount   = entityList.filter(e => !e.coords).length;

    const qslCount = contacts.filter(q => q.confirmed).length;
    document.getElementById('stats').textContent =
        `${contacts.length} QSOs · ${qslCount} QSLs · ${workedCount} entities worked (${confirmedCount} confirmed)`;

    const footerParts = [];
    footerParts.push(noCoordCount > 0
        ? `${noCoordCount} entit${noCoordCount === 1 ? 'y' : 'ies'} not shown on map — no coordinate data`
        : 'All worked entities shown on the map.');
    if (topWorked) {
        const km = Math.round(topWorked.dist).toLocaleString();
        const tag = topWorked.confirmed ? 'Farthest QSO & QSL' : 'Farthest QSO (unconfirmed)';
        footerParts.push(`${tag}: ${topWorked.entity.name} · ${km} km`);
    }
    if (topConfirmed && topConfirmed.entity !== topWorked?.entity) {
        const km = Math.round(topConfirmed.dist).toLocaleString();
        footerParts.push(`Farthest QSL: ${topConfirmed.entity.name} · ${km} km`);
    }
    document.getElementById('footer-msg').textContent = footerParts.join('  ·  ');
}

main();
