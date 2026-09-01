# Call sign Grids column + Alt Map tab — Handoff
**Date:** 2026-09-01
**Project:** W7GVR personal DXCC tracking dashboard
**Context:** Implementation session (site/app.js, site/index.html). User is moving to a new
machine/new conversation; this doc exists so a fresh Claude Code session has full context without
the original chat transcript.

---

## What shipped (live, enabled)

### Call sign table: "Grids" column
Between Country and QSOs, listing each call sign's unique 6-char Maidenhead locators
(space/dot-joined). Truncates 8-char gridsquares to 6; leaves 4-char ones as-is (no way to invent
the missing precision). Sortable like the other columns.

### `BAND_COLORS` harmonized with pskreporter
`site/app.js`'s `BAND_COLORS` table previously had colors invented for this project. It now matches
pskreporter.info's own default (non-`altcolor`) band palette exactly, pulled from their
`map_control_oln.js` `colormapper` object (20m gold, 40m blue, 6m red, etc.) — so a band reads the
same color in both tools. Only the bands already in `BAND_ORDER` were remapped (160m–2m); pskreporter
has entries for VHF/UHF/microwave bands too that weren't ported since nothing in this project's data
uses them yet.

---

## What's built but disabled: "Alt Map" tab

A pskreporter-style QSL map — one teardrop pin per confirmed QSO, colored by band, with a
Maidenhead grid overlay and a draggable time-range ribbon. It's **fully built and was working**, but
is currently **commented out** at the user's request, pending two design decisions (below) before
it goes live.

### Where the code lives
- `site/index.html`: the `<button data-tab="altmap">` and the `#tab-altmap` panel are both wrapped
  in `<!-- -->`, each with a comment pointing to the matching disabled code.
- `site/app.js`: the entire "Alt Map" section — `makePinIcon`, `buildGraticuleLines`,
  `drawGraticuleLabels`, `ALT_MAP_TIME_MS`, `initAltMap` — is wrapped in a single `/* */` block
  (search for `DISABLED for now`). In `main()`, the `altMap` variable and its tab-bar click branch
  are commented out too (search for `Alt Map tab disabled`).
- **`initTimeBrush` was *not* touched** — it's shared with the Activity tab's zoom brush (see
  "Shared brush component" below), so it stays live and un-commented.

### To re-enable
Uncomment all of the above (reverse the `<!-- -->` / `/* */` / `//` wrapping) and bump the
`app.js?v=` cache-busting query string in `index.html`. No other changes needed to get back to the
last-working state — but see "Open design questions" first, since the user specifically paused here
to reconsider two parts of the UI before shipping it.

### Shared brush component
`initTimeBrush()` (in `app.js`, above `initActivityChart`) is a reusable draggable time-range
brush — cumulative step-line plot, drag to pan, drag an edge to resize, click outside the selection
to re-center. It was extracted *from* the Activity tab's original brush code so that Activity and
Alt Map use the literal same implementation, not lookalikes. `initActivityChart` now calls it via
`onChange`/`onUserInteract` callbacks instead of having its own copy of the drag-interaction logic.
**This refactor is live and working regardless of Alt Map's disabled state** — don't revert it when
re-enabling Alt Map, and don't be surprised `initTimeBrush` exists outside the commented block.

### Non-obvious technical gotchas hit while building this
- **`createImageBitmap` can't decode SVG in Chrome.** The first pin-icon implementation loaded an
  SVG data URI via `map.loadImage()`, which MapLibre implements internally via `createImageBitmap`
  — this fails silently (returns a rejected promise the code didn't handle correctly), so the pins
  just never appeared, no error surfaced. Fixed by drawing the pin directly on a `<canvas>` (see
  `makePinIcon`), matching the pattern the codebase already used for the home-marker "✕" icon.
- **MapLibre's vector-tile glyph server doesn't have every font.** pskreporter's own grid-square
  labels use "Georgia" (a serif font). MapLibre symbol layers can only render text in fonts the
  style's glyph server has PBF glyphs for — `tiles.openfreemap.org`'s "liberty" style only has Noto
  Sans (confirmed via `curl` — `/fonts/Georgia/0-255.pbf` → 404, `/fonts/Noto%20Sans%20Regular/...`
  → 200). Text in an unavailable font renders as *nothing*, not a fallback font, with no console
  error. Fixed by drawing the grid labels on a synced 2D canvas overlay instead of a symbol layer
  (see `drawGraticuleLabels`) — canvas text can use any font actually installed in the browser.
- **Background-tab `requestAnimationFrame` throttling looks exactly like a rendering bug during
  automated testing.** When driving the browser via `claude-in-chrome` tools, MapLibre's internal
  render loop (and therefore its `'load'` event, tile paint, etc.) is gated on rAF, which Chrome
  throttles hard for a tab that isn't actually being composited/focused. Symptom: `map.loaded()`
  stays `false`, layers/sources you just added don't show up, `getLayer()` returns `undefined` —
  for 5+ seconds — even though the code is correct. Taking a `screenshot` (or otherwise forcing a
  real paint) flushes the backlog and everything appears at once. **If this recurs:** don't chase it
  as an app bug; take a screenshot to force a repaint, or add a short `wait` before asserting on map
  state. Also: the *first* click on a tab button after `navigate` frequently doesn't register at all
  in this environment (second click always worked) — cause not fully diagnosed, treat as a known
  quirk of the test harness, not the app.

---

## Open design questions (why Alt Map is paused, not shipped)

These were discussed and are ready to turn into an implementation plan — nothing below needs
re-litigating from scratch, just a decision.

### A. Replace the "over the last" time dropdown with explicit From/To fields
Today, filtering is `<select id="altmap-time">` (24h/7d/30d/etc. presets) which calls
`brush.setRange()`. The user wants the presets gone, replaced by two directly-editable date/time
fields kept in sync with the brush (drag the brush → fields update; edit a field → brush moves).
The brush's `getRange()`/`setRange()`/`onChange` API already supports this — the from/to fields
would just be a second consumer of the same interface the dropdown used.

Decisions still open:
1. **Field granularity** — `<input type="date">` (day resolution, simpler) vs.
   `<input type="datetime-local">` (minute resolution, matches what the brush can actually express).
2. **Timezone semantics** — treat field values as UTC (consistent with the rest of the app, e.g. the
   pin popup labels times "UTC") vs. browser-local time. Recommended: UTC, with a small "(UTC)"
   label, to avoid a double-timezone-conversion bug.
3. **Validation** — clamp out-of-range values to `[dataMin, dataMax]`; if `from > to`, swap silently
   rather than reject.
4. **Keep an "all time" shortcut?** Recommended yes — a small "Reset" link, since removing the
   dropdown removes the one-click "show everything" option.

### B. Multi-band selection (not just one-or-all)
Today `<select id="altmap-band">` is single-select: one band or "all". The user wants an arbitrary
subset (e.g. 30m + 40m but not 20m).

**Recommended approach:** replace the `<select>` with a row of toggle "pills" — one per active band,
reusing the `.unit-btn` styling already used for the km/mi toggle and Activity's zoom-preset
buttons, each colored via `BAND_COLORS` so the row doubles as a legend. Plus an "All" pill. Rejected
alternatives: native `<select multiple>` (ctrl/cmd-click isn't discoverable), a checkbox popover
(more UI machinery — open/close/click-outside — for no real benefit here).

Mechanical change: pin-layer filter goes from `['==', ['get','band'], band]` to
`['in', ['get','band'], ['literal', [...selectedBands]]]`.

Decisions still open:
1. **Deselect-all behavior** — show zero pins (honest, but the map might read as broken) vs. don't
   allow unchecking the last remaining band pill.
2. **Should the brush's reference line respect the band selection?** Today it deliberately always
   plots *all* confirmed QSLs regardless of band (a stable reference that doesn't jump around as you
   toggle bands). Worth a deliberate yes/no once "band" is a real multi-select rather than a single
   value — reflecting the selection would be more informative but changes what the ribbon means.

---

## Local dev workflow used this session
- `python3 -m http.server 8791` from the repo root (not `site/`) — the app fetches
  `data_output/lotw_contacts.json` and `data_reference/dxcc_entities.json` relative to the repo
  root via a `_base` computed in `app.js`, so serving from inside `site/` breaks those fetches.
- Iterated visually via the `claude-in-chrome` skill/tools rather than guessing at CSS — see the rAF
  gotcha above before assuming something isn't rendering.
- Cache-bust by bumping the `?v=` query string on the `<script src="app.js?...">` tag in
  `index.html` — the browser (and this local server) will otherwise serve a stale `app.js` even
  after a fresh `navigate`.

---

## Not carried over from this machine
This project also has Claude Code **memory** (architecture notes, decisions, gotchas from earlier
sessions — e.g. the Alaska/Hawaii DXCC entity quirk, LoTW API lessons) living outside this repo, at
`~/.claude/projects/-Users-gvrocha-dev-hamradio-contact-mapping/memory/` on the machine this session
ran on. That does **not** transfer via `git clone` — a fresh machine's Claude Code starts with none
of it. If continuity there matters, copy that directory over manually (it's not meant for this
public repo — some of it is personal/career-strategy content that shouldn't be committed). The
technical/architectural substance relevant to writing code against this repo is captured in
`STATUS.md` and this `documentation/claude/` folder instead, which *does* travel with the repo.
