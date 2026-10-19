'use strict';

// v0.91 — DXCC map, CQ zones (WAZ) and ITU zones tabs.
// Served locally from the project root (site/ one level down) or on S3/Pages with
// the data folders next to the page — same path rule as v0.9.
const _base = window.location.pathname.includes('/site/') ? '../' : '';
const DXCC_GEOMETRY_URL = _base + 'data_reference/dxcc_map.geojson';
const CQ_ZONES_URL      = _base + 'data_reference/cq_zones.geojson';
const ITU_ZONES_URL     = _base + 'data_reference/itu_zones.geojson';
const LOTW_URL          = _base + 'data_output/lotw_contacts.json';
const QRZ_QSO_URL       = _base + 'data_output/qrz_qso_table.tsv';

// Status is hierarchical: an entity or zone takes the highest status any of its QSOs reaches.
const STATUS = {
    lotw:   { label: 'LoTW confirmed', color: '#22c55e' },
    qrz:    { label: 'QRZ confirmed',  color: '#fb923c' },
    worked: { label: 'Unconfirmed',    color: '#fed7aa' },
    none:   { label: 'Not worked',     color: '#ffffff' },
};
const STATUS_ORDER = ['lotw', 'qrz', 'worked', 'none'];

const DXCC_WATER  = '#cfe8f7';
const DXCC_BORDER = '#94a3b8';
// Zone maps: black-and-white base so the translucent zone colours read clearly.
const BW_WATER  = '#ffffff';
const BW_LAND   = '#e5e7eb';
const BW_BORDER = '#111827';
const ZONE_FILL_OPACITY = 0.45;

const ZONE_SETS = {
    cq:  { title: 'CQ zone',  count: 40, key: 'cqz',  url: CQ_ZONES_URL,  mapId: 'cq-map',  tableId: 'cq-table',
           legendId: 'cq-legend',  note: '40 CQ zones (WAZ)' },
    itu: { title: 'ITU zone', count: 90, key: 'ituz', url: ITU_ZONES_URL, mapId: 'itu-map', tableId: 'itu-table',
           legendId: 'itu-legend', note: '90 ITU zones' },
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function parseTsv(text) {
    const lines = text.split('\n').filter(l => l.length);
    const head  = lines.shift().split('\t');
    return lines.map(l => {
        const cells = l.split('\t');
        return Object.fromEntries(head.map((h, i) => [h, cells[i] || '']));
    });
}

const minuteKey = (call, dt) => `${(call || '').toUpperCase()}|${(dt || '').slice(0, 16)}`;
const zoneNum   = z => { const n = parseInt(z, 10); return Number.isFinite(n) && n > 0 ? String(n) : ''; };

// One merged QSO list from both sources: {dxcc, cqz, ituz, datetime, lotwConf, qrzConf}.
//  - Every QRZ Logbook QSO is included; if the same QSO (call + minute) is confirmed on
//    LoTW, LoTW's entity and zones win (they come from the other station's certificate;
//    QRZ's come from a profile and disagree on ~4% of QSOs).
//  - LoTW QSOs missing from the QRZ log are added. Unconfirmed LoTW QSOs carry no entity
//    or zones, so those are taken from the call's QRZ QSOs when that call has only one value.
function mergeQsos(lotw, qrzRows) {
    const lotwByMinute = new Map(lotw.map(q => [minuteKey(q.call, q.datetime), q]));
    const byCall = new Map();      // call -> {dxcc:Set, cqz:Set, ituz:Set} from QRZ
    const used = new Set();
    const out = [];

    for (const r of qrzRows) {
        const m  = lotwByMinute.get(minuteKey(r.call, r.qso_datetime));
        const lc = !!(m && m.confirmed);
        if (m) used.add(m);
        const qso = {
            dxcc: (lc && m.dxcc) || r.dxcc,
            cqz:  zoneNum((lc && m.cq_zone) || r.cqz),
            ituz: zoneNum((lc && m.itu_zone) || r.ituz),
            datetime: r.qso_datetime.replace('Z', ''),
            lotwConf: lc,
            qrzConf:  r.app_qrzlog_status === 'C',
        };
        out.push(qso);
        const call = r.call.toUpperCase();
        if (!byCall.has(call)) byCall.set(call, { dxcc: new Set(), cqz: new Set(), ituz: new Set() });
        for (const k of ['dxcc', 'cqz', 'ituz']) if (qso[k]) byCall.get(call)[k].add(qso[k]);
    }

    for (const q of lotw) {
        if (used.has(q)) continue;
        const known = byCall.get((q.call || '').toUpperCase());
        const only  = k => (known && known[k].size === 1) ? [...known[k]][0] : '';
        out.push({
            dxcc: (q.confirmed && q.dxcc) || only('dxcc'),
            cqz:  zoneNum(q.confirmed && q.cq_zone) || only('cqz'),
            ituz: zoneNum(q.confirmed && q.itu_zone) || only('ituz'),
            datetime: q.datetime || '',
            lotwConf: !!q.confirmed,
            qrzConf:  false,
        });
    }
    return out;
}

function tally(qsos, key) {
    const t = {};
    let missing = 0;
    for (const q of qsos) {
        const k = q[key];
        if (!k) { missing++; continue; }
        const e = (t[k] ||= { qsos: 0, lotwConf: 0, qrzConf: 0, first: '', last: '' });
        e.qsos++;
        if (q.lotwConf) e.lotwConf++;
        if (q.qrzConf)  e.qrzConf++;
        if (q.datetime) {
            if (!e.first || q.datetime < e.first) e.first = q.datetime;
            if (!e.last  || q.datetime > e.last)  e.last  = q.datetime;
        }
    }
    return { t, missing };
}

function statusOf(e) {
    if (!e) return 'none';
    if (e.lotwConf > 0) return 'lotw';
    if (e.qrzConf > 0)  return 'qrz';
    return e.qsos > 0 ? 'worked' : 'none';
}

function annotate(features, t, key) {
    for (const f of features) {
        const e = t[String(f.properties[key])];
        Object.assign(f.properties, {
            status: statusOf(e), qsos: e ? e.qsos : 0,
            lotwConf: e ? e.lotwConf : 0, qrzConf: e ? e.qrzConf : 0,
            first: e ? e.first : '', last: e ? e.last : '',
        });
    }
}

const statusColorExpr = () => ['match', ['get', 'status'],
    ...STATUS_ORDER.flatMap(k => [k, STATUS[k].color]), STATUS.none.color];

const countsLine = p => p.qsos > 0
    ? `${p.qsos} QSO${p.qsos === 1 ? '' : 's'} · ${p.lotwConf} LoTW conf. · ${p.qrzConf} QRZ conf.` : '';

const fmtDate = dt => dt ? dt.slice(0, 10) : '';

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

function newMap(container, background, attribution, extra = {}) {
    const map = new maplibregl.Map({
        container,
        style: { version: 8, sources: {}, layers: [{ id: 'water', type: 'background', paint: { 'background-color': background } }] },
        bounds: [[-170, -58], [190, 78]],
        maxZoom: 9,
        attributionControl: false,
        ...extra,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: attribution }));
    return map;
}

function attachPopup(map, layers, html) {
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    const show = ev => {
        map.getCanvas().style.cursor = 'pointer';
        popup.setLngLat(ev.lngLat).setHTML(html(ev.features[0].properties)).addTo(map);
    };
    const hide = () => { map.getCanvas().style.cursor = ''; popup.remove(); };
    for (const layer of layers) {
        map.on('mousemove', layer, show);
        map.on('mouseleave', layer, hide);
    }
}

const statusHtml = s => `<div class="pop-status" style="color:${s === 'none' ? '#9ca3af' : STATUS[s].color}">${STATUS[s].label}</div>`;

function buildDxccMap(geometry) {
    const color = statusColorExpr();
    const map = newMap('dxcc-map', DXCC_WATER, 'Borders: Natural Earth · DXCC list: ADIF / QRZ', { hash: true });
    map.on('load', () => {
        map.addSource('dxcc', { type: 'geojson', data: geometry });
        map.addLayer({ id: 'dxcc-fill', type: 'fill', source: 'dxcc',
            filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': color } });
        map.addLayer({ id: 'dxcc-borders', type: 'line', source: 'dxcc',
            filter: ['==', ['get', 'kind'], 'area'],
            paint: { 'line-color': DXCC_BORDER, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1.2] } });
        // Entities too small to see as areas get a marker on top.
        map.addLayer({ id: 'dxcc-dots', type: 'circle', source: 'dxcc',
            filter: ['all', ['==', ['get', 'kind'], 'point'], ['get', 'dot']],
            paint: { 'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 6],
                     'circle-stroke-color': '#64748b', 'circle-stroke-width': 0.8 } });
        attachPopup(map, ['dxcc-dots', 'dxcc-fill'], p => {
            const c = countsLine(p);
            return `<div class="pop-name">${escapeHtml(p.name)}${p.continent ? ` (${p.continent})` : ''} ` +
                   `<span style="color:#6b7280">#${p.dxcc}</span></div>` + statusHtml(p.status) +
                   (c ? `<div class="pop-counts">${c}</div>` : '');
        });
    });
    return map;
}

function buildZoneMap(set, zones, base) {
    const map = newMap(set.mapId, BW_WATER,
        'Zones: HB9HIL/hamradio-zones-geojson (MIT) · Borders: Natural Earth');
    map.on('load', () => {
        map.addSource('base', { type: 'geojson', data: base });
        map.addLayer({ id: 'base-land', type: 'fill', source: 'base',
            filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': BW_LAND } });
        map.addLayer({ id: 'base-borders', type: 'line', source: 'base',
            filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-color': BW_BORDER, 'line-width': 0.35 } });

        map.addSource('zones', { type: 'geojson', data: zones });
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones',
            paint: { 'fill-color': statusColorExpr(),
                     'fill-opacity': ['case', ['==', ['get', 'status'], 'none'], 0, ZONE_FILL_OPACITY] } });
        map.addLayer({ id: 'zone-lines', type: 'line', source: 'zones',
            paint: { 'line-color': '#7c2d12', 'line-width': 1.2, 'line-opacity': 0.8 } });

        for (const f of zones.features) {
            const el = document.createElement('div');
            el.className = 'zone-label';
            el.textContent = f.properties.zone;
            new maplibregl.Marker({ element: el }).setLngLat(f.properties.label).addTo(map);
        }

        attachPopup(map, ['zone-fill'], p => {
            const c = countsLine(p);
            return `<div class="pop-name">${set.title} ${p.zone}</div>` +
                   `<div class="pop-desc">${escapeHtml(p.description)}</div>` + statusHtml(p.status) +
                   (c ? `<div class="pop-counts">${c}</div>` : '');
        });
    });
    return map;
}

// ---------------------------------------------------------------------------
// Legends and tables
// ---------------------------------------------------------------------------

function statusCounts(items) {
    const counts = { lotw: 0, qrz: 0, worked: 0, none: 0 };
    for (const p of items) counts[p.status]++;
    return counts;
}

// Solid colour a translucent fill shows over white, so legend swatches match the map.
function overWhite(hex, alpha) {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return '#' + c.map(v => Math.round(255 - (255 - v) * alpha).toString(16).padStart(2, '0')).join('');
}

function renderLegend(id, counts, note, translucent = false) {
    document.getElementById(id).innerHTML =
        STATUS_ORDER.map(k => {
            const bg = translucent ? overWhite(STATUS[k].color, ZONE_FILL_OPACITY) : STATUS[k].color;
            return `<span class="legend-item"><span class="legend-swatch" style="background:${bg}"></span>` +
                   `${STATUS[k].label} <strong>${counts[k]}</strong></span>`;
        }).join('') +
        `<span class="legend-note">${note} · each shown at its highest status (LoTW &gt; QRZ &gt; unconfirmed)</span>`;
}

function renderZoneTable(set, zones, missing, onPick) {
    const rows = zones.features.map(f => f.properties);
    document.getElementById(set.tableId).innerHTML =
        `<table class="zone-table"><thead><tr>` +
        `<th class="num">Zone</th><th>Description</th><th>Status</th>` +
        `<th class="num">QSOs</th><th class="num">LoTW conf.</th><th class="num">QRZ conf.</th>` +
        `<th>First QSO</th><th>Last QSO</th></tr></thead><tbody>` +
        rows.map(p =>
            `<tr data-zone="${p.zone}" class="${p.status === 'none' ? 'not-worked' : ''}">` +
            `<td class="num"><strong>${p.zone}</strong></td>` +
            `<td class="desc">${escapeHtml(p.description)}</td>` +
            `<td><span class="legend-swatch" style="background:${overWhite(STATUS[p.status].color, ZONE_FILL_OPACITY)}"></span> ${STATUS[p.status].label}</td>` +
            `<td class="num">${p.qsos || ''}</td><td class="num">${p.lotwConf || ''}</td><td class="num">${p.qrzConf || ''}</td>` +
            `<td>${fmtDate(p.first)}</td><td>${fmtDate(p.last)}</td></tr>`
        ).join('') +
        `</tbody></table>` +
        (missing ? `<p class="table-note">${missing} QSO${missing === 1 ? '' : 's'} have no ${set.title.replace(' zone', '')} zone in LoTW or QRZ and are not counted.</p>` : '');

    document.querySelectorAll(`#${set.tableId} tbody tr`).forEach(tr =>
        tr.addEventListener('click', () => onPick(Number(tr.dataset.zone))));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const getJson = url => fetch(url, { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
});

async function main() {
    const callsign = (typeof CONFIG !== 'undefined' && CONFIG.callsign) ? CONFIG.callsign : '';
    if (callsign) document.getElementById('title').textContent = `${callsign} · DXCC Dashboard v0.91`;

    const [dxccGeometry, cqZones, ituZones, lotw, qrzRows] = await Promise.all([
        getJson(DXCC_GEOMETRY_URL), getJson(CQ_ZONES_URL), getJson(ITU_ZONES_URL), getJson(LOTW_URL),
        // The QRZ QSO table is optional: without it, only LoTW statuses are shown.
        fetch(QRZ_QSO_URL, { cache: 'no-cache' }).then(r => r.ok ? r.text() : '').then(t => t ? parseTsv(t) : []).catch(() => []),
    ]);

    const qsos = mergeQsos(lotw, qrzRows);

    // DXCC
    const dx = tally(qsos, 'dxcc');
    annotate(dxccGeometry.features, dx.t, 'dxcc');
    const dxCounts = statusCounts(dxccGeometry.features.filter(f => f.properties.kind === 'point').map(f => f.properties));
    renderLegend('dxcc-legend', dxCounts, '340 current DXCC entities');

    // Zones
    const zoneData = { cq: cqZones, itu: ituZones };
    const zoneCounts = {};
    for (const [kind, set] of Object.entries(ZONE_SETS)) {
        const z = tally(qsos, set.key);
        annotate(zoneData[kind].features, z.t, 'zone');
        zoneCounts[kind] = statusCounts(zoneData[kind].features.map(f => f.properties));
        renderLegend(set.legendId, zoneCounts[kind], set.note, true);
        set.missing = z.missing;
    }

    const worked = c => c.lotw + c.qrz + c.worked;
    document.getElementById('stats').textContent =
        `${worked(dxCounts)} entities worked (${dxCounts.lotw} LoTW confirmed) · ` +
        `CQ zones ${worked(zoneCounts.cq)}/40 (${zoneCounts.cq.lotw} LoTW) · ` +
        `ITU zones ${worked(zoneCounts.itu)}/90 (${zoneCounts.itu.lotw} LoTW)` +
        (qrzRows.length ? '' : ' · QRZ QSO table not found') +
        (dx.missing ? ` · ${dx.missing} QSO${dx.missing === 1 ? '' : 's'} with unknown entity` : '');

    // Maps are created the first time their tab is shown (MapLibre cannot size a hidden map).
    const maps = {};
    const ensureMap = tab => {
        if (maps[tab]) { maps[tab].resize(); return; }
        if (tab === 'dxccmap') maps[tab] = buildDxccMap(dxccGeometry);
        const kind = { cqzones: 'cq', ituzones: 'itu' }[tab];
        if (kind) {
            const set = ZONE_SETS[kind];
            const map = maps[tab] = buildZoneMap(set, zoneData[kind], dxccGeometry);
            renderZoneTable(set, zoneData[kind], set.missing, zone => {
                const f = zoneData[kind].features.find(x => x.properties.zone === zone);
                if (f) map.flyTo({ center: f.properties.label, zoom: Math.max(map.getZoom(), 2.5) });
            });
        }
    };

    const activate = target => {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
        ensureMap(target);
    };
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));
    activate(document.querySelector('.tab.active').dataset.tab);
}

main().catch(err => {
    console.error(err);
    document.getElementById('stats').textContent = `Error: ${err.message}`;
});
