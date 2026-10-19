'use strict';

// v0.91 — DXCC map tab.
// Served locally from the project root (site/ one level down) or on S3/Pages with
// the data folders next to the page — same path rule as v0.9.
const _base = window.location.pathname.includes('/site/') ? '../' : '';
const GEOMETRY_URL = _base + 'data_reference/dxcc_map.geojson';
const LOTW_URL     = _base + 'data_output/lotw_contacts.json';
const QRZ_QSO_URL  = _base + 'data_output/qrz_qso_table.tsv';

// Status ranks are hierarchical: an entity takes the highest status any of its QSOs reaches.
const STATUS = {
    lotw:   { rank: 3, label: 'LoTW confirmed', color: '#22c55e' },
    qrz:    { rank: 2, label: 'QRZ confirmed',  color: '#fb923c' },
    worked: { rank: 1, label: 'Unconfirmed',    color: '#fed7aa' },
    none:   { rank: 0, label: 'Not worked',     color: '#ffffff' },
};
const WATER_COLOR  = '#cfe8f7';
const BORDER_COLOR = '#94a3b8';

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

// Per-entity tallies from both sources.
//  - QRZ Logbook: every QSO has a DXCC number; status 'C' = confirmed on QRZ.
//  - LoTW: confirmed QSOs carry a DXCC number. Unconfirmed ones do not, so they are
//    matched to a QRZ QSO by call + minute (or by call, when that call maps to one
//    entity) to find their entity; LoTW QSOs already in the QRZ log are not re-counted.
function tallyEntities(lotw, qrzRows) {
    const ent = {};
    const get = d => (ent[d] ||= { qsos: 0, lotwConf: 0, qrzConf: 0 });

    const qrzByMinute = new Map();
    const qrzCallDxcc = new Map();
    for (const r of qrzRows) {
        if (!r.dxcc) continue;
        qrzByMinute.set(minuteKey(r.call, r.qso_datetime), r.dxcc);
        const call = r.call.toUpperCase();
        if (!qrzCallDxcc.has(call)) qrzCallDxcc.set(call, new Set());
        qrzCallDxcc.get(call).add(r.dxcc);
        const e = get(r.dxcc);
        e.qsos++;
        if (r.app_qrzlog_status === 'C') e.qrzConf++;
    }

    let unmatched = 0;
    for (const q of lotw) {
        const inQrz = qrzByMinute.get(minuteKey(q.call, q.datetime));
        let dxcc = q.confirmed && q.dxcc ? q.dxcc : inQrz;
        if (!dxcc) {
            const set = qrzCallDxcc.get((q.call || '').toUpperCase());
            if (set && set.size === 1) dxcc = [...set][0];
        }
        if (!dxcc) { unmatched++; continue; }
        const e = get(dxcc);
        if (!inQrz) e.qsos++;
        if (q.confirmed) e.lotwConf++;
    }
    return { ent, unmatched };
}

function statusOf(e) {
    if (!e) return 'none';
    if (e.lotwConf > 0) return 'lotw';
    if (e.qrzConf > 0)  return 'qrz';
    return e.qsos > 0 ? 'worked' : 'none';
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function buildDxccMap(geometry, ent) {
    for (const f of geometry.features) {
        const e = ent[String(f.properties.dxcc)];
        f.properties.status   = statusOf(e);
        f.properties.qsos     = e ? e.qsos : 0;
        f.properties.lotwConf = e ? e.lotwConf : 0;
        f.properties.qrzConf  = e ? e.qrzConf : 0;
    }

    const colorExpr = ['match', ['get', 'status'],
        ...Object.entries(STATUS).flatMap(([k, s]) => [k, s.color]), STATUS.none.color];

    const map = new maplibregl.Map({
        container: 'dxcc-map',
        style: {
            version: 8,
            sources: {},
            layers: [{ id: 'water', type: 'background', paint: { 'background-color': WATER_COLOR } }],
        },
        bounds: [[-170, -58], [190, 78]],
        maxZoom: 9,
        hash: true,
        attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({
        compact: true, customAttribution: 'Borders: Natural Earth · DXCC list: ADIF / QRZ',
    }));

    map.on('load', () => {
        map.addSource('dxcc', { type: 'geojson', data: geometry });
        map.addLayer({
            id: 'dxcc-fill', type: 'fill', source: 'dxcc',
            filter: ['==', ['get', 'kind'], 'area'],
            paint: { 'fill-color': colorExpr },
        });
        map.addLayer({
            id: 'dxcc-borders', type: 'line', source: 'dxcc',
            filter: ['==', ['get', 'kind'], 'area'],
            paint: { 'line-color': BORDER_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1.2] },
        });
        // Entities too small to see as areas get a marker on top.
        map.addLayer({
            id: 'dxcc-dots', type: 'circle', source: 'dxcc',
            filter: ['all', ['==', ['get', 'kind'], 'point'], ['get', 'dot']],
            paint: {
                'circle-color': colorExpr,
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 6],
                'circle-stroke-color': '#64748b',
                'circle-stroke-width': 0.8,
            },
        });

        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
        const show = ev => {
            const f = ev.features[0];
            const p = f.properties;
            const s = STATUS[p.status];
            map.getCanvas().style.cursor = 'pointer';
            const counts = p.qsos > 0
                ? `${p.qsos} QSO${p.qsos === 1 ? '' : 's'} · ${p.lotwConf} LoTW conf. · ${p.qrzConf} QRZ conf.`
                : '';
            popup.setLngLat(ev.lngLat).setHTML(
                `<div class="pop-name">${p.name}${p.continent ? ` (${p.continent})` : ''} <span style="color:#6b7280">#${p.dxcc}</span></div>` +
                `<div class="pop-status" style="color:${p.status === 'none' ? '#9ca3af' : s.color}">${s.label}</div>` +
                (counts ? `<div class="pop-counts">${counts}</div>` : '')
            ).addTo(map);
        };
        const hide = () => { map.getCanvas().style.cursor = ''; popup.remove(); };
        for (const layer of ['dxcc-dots', 'dxcc-fill']) {
            map.on('mousemove', layer, show);
            map.on('mouseleave', layer, hide);
        }
    });
    return map;
}

function renderLegend(geometry) {
    const counts = { lotw: 0, qrz: 0, worked: 0, none: 0 };
    for (const f of geometry.features) {
        if (f.properties.kind === 'point') counts[f.properties.status]++;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    document.getElementById('dxcc-legend').innerHTML =
        ['lotw', 'qrz', 'worked', 'none'].map(k =>
            `<span class="legend-item"><span class="legend-swatch" style="background:${STATUS[k].color}"></span>` +
            `${STATUS[k].label} <strong>${counts[k]}</strong></span>`
        ).join('') +
        `<span class="legend-note">${total} current DXCC entities · each shown at its highest status (LoTW &gt; QRZ &gt; unconfirmed)</span>`;
    return counts;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
    const callsign = (typeof CONFIG !== 'undefined' && CONFIG.callsign) ? CONFIG.callsign : '';
    if (callsign) document.getElementById('title').textContent = `${callsign} · DXCC Dashboard v0.91`;

    const [geometry, lotw, qrzRows] = await Promise.all([
        fetch(GEOMETRY_URL, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`${GEOMETRY_URL}: ${r.status}`); return r.json(); }),
        fetch(LOTW_URL, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`${LOTW_URL}: ${r.status}`); return r.json(); }),
        // The QRZ QSO table is optional: without it, only LoTW statuses are shown.
        fetch(QRZ_QSO_URL, { cache: 'no-cache' }).then(r => r.ok ? r.text() : '').then(t => t ? parseTsv(t) : []).catch(() => []),
    ]);

    const { ent, unmatched } = tallyEntities(lotw, qrzRows);
    buildDxccMap(geometry, ent);
    const c = renderLegend(geometry);

    const worked = c.lotw + c.qrz + c.worked;
    document.getElementById('stats').textContent =
        `${worked} entities worked · ${c.lotw} LoTW confirmed · ${c.lotw + c.qrz} confirmed on LoTW or QRZ` +
        (qrzRows.length ? '' : ' · QRZ QSO table not found') +
        (unmatched ? ` · ${unmatched} LoTW QSO${unmatched === 1 ? '' : 's'} with unknown entity` : '');

    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    }));
}

main().catch(err => {
    console.error(err);
    document.getElementById('stats').textContent = `Error: ${err.message}`;
});
