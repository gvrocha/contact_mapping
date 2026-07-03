# Feature Backlog

## Milestone timeline table
A table of personal firsts and progression milestones, derived from `datetime` and `qsl_date` in the contact data. Examples:
- First QSO uploaded to LoTW
- First QSL confirmed
- First contact per continent (NA, SA, EU, AF, AS, OC)
- Time to N distinct DXCC entities worked (10, 20, 25, 50, 100, …)
- Time to N distinct DXCC entities confirmed

## Bundle MapLibre locally
Download MapLibre GL JS + CSS into `site/vendor/` so the dashboard loads from local files only and doesn't depend on CDN availability or connection speed. Matters especially when running on a slow or unreliable connection.

## Upload eagerness analysis
For confirmed QSOs, compare `lotw_upload_datetime` (when our upload reached LoTW) against `qsl_date` (when the QSL match was made, i.e. when the second upload arrived). The delta reveals who uploaded first:
- **Delta ≈ 0** (seconds to a few minutes): other station had already uploaded; we triggered the confirmation — we were last.
- **Delta large**: we uploaded first and waited — we were eager, the other station caught up later.

Suggested visualisation: histogram of deltas for confirmed QSOs, split between "we uploaded first" vs "they uploaded first". Could also show median delay-to-confirmation as a per-entity or per-country stat.
