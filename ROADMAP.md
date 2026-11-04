# Roadmap

Feature ideas and planned work for OceanECO. Shipped items move to [CHANGELOG.md](CHANGELOG.md);
detailed designs live in [notes/](notes/).

## Next (v1.1 candidates)

### Polygon / region queries
Draw an area (not just a Cross-Section line) and get area-averaged timeseries plus exposure stats,
e.g. % of area with Ω aragonite < 1 or DO below hypoxic thresholds. Shellfish tenures, MPAs and
inlets are areas, so this is the most management-relevant gap.
- Reuse: mapbox-gl-draw wiring from Cross-Section (`index.vue`), `shared/grid_lookup.py` for cell selection.

### Threshold alerts + "current conditions" panel
Surface where sensors or model regions are corrosive/hypoxic *now* (latest data or forecast), with
optional per-site email/RSS subscriptions.
- Reuse: Extreme Events / Compound Stress logic in `AnalysisWorkspace`.

### Map animation export (MP4/GIF)
Render the time animation of a variable over a window as a clip, for outreach and case studies.
- Reuse: existing time-animation loop in `index.vue` and value-packed tiles.

### Model-skill scorecard
Bias / RMSE / correlation for every in-domain sensor × variable, as a table and as colour on the
buoys, so users can see where to trust the model.
- Reuse: Sensor–Model comparison stats in `ComparisonWorkspace.vue`.

### Mobile / tablet layout
Replace `MobileBlocker.vue` with a reduced layout (map + one variable + point click + timeseries)
for field users. Share links already carry the view.

## Later / ideas

- **IOS ship casts on a schedule** — `ios_casts_to_ch.py` is CLI-only; a weekly Prefect flow running `--since <last year>` would pick up new casts. The first full-archive load (~124k casts) has to run by hand.
- **Per-deployment colours in a merged sensor's series** — a merge plots as one line today; colouring by member (the data is in `members`) would show where one deployment ends and the next begins.
- **DFO MEDS buoys** — `catalog_dfo_meds.yml` is imported but every entry is `inactive`, so `/sensors` hides them; mark them `archive: true` instead to show their history without hourly polling.

## Parked

- **Bathymetry raster layer** — kept but unused; needs UX for "map shows bathymetry, charts show another variable".
- **LiveOcean** — removed; re-adding needs the new SSH/sync convention.
- **Mapbox buoy clustering** — planned once sensor density makes nearest-station click selection ambiguous.
