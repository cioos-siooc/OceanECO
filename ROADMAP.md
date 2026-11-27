# Roadmap

Feature ideas and planned work for OceanECO. Shipped items move to [CHANGELOG.md](CHANGELOG.md);
detailed designs live in [notes/](notes/).

## Next (v1.1 candidates)

### Polygon / region queries
Draw an area (not just a Cross-Section line) and get area-averaged timeseries plus exposure stats,
e.g. % of area with Ω aragonite < 1 or DO below hypoxic thresholds. Shellfish tenures, MPAs and
inlets are areas, so this is the most management-relevant gap.
- Reuse: mapbox-gl-draw wiring from Cross-Section (`useMapDrawTools.ts`), `shared/grid_lookup.py` for cell selection.

### Area tab: more views
The observation box (`area/AreaPanel.vue`, `/obsArea`) has Points and Mean. Next: a monthly
climatology across years, a time × depth heatmap for wide depth ranges (`TimeDepthHeatmap`),
and the model at the circle's centre over the same depth range as an overlay.

### Area tab: make the Mean scientifically defensible
Points (each source kept distinct) is fine; the Mean mixes platforms and can be challenged on:
- **Units/correctness first:** 12 ERDDAP DO sensors are stored unconverted, so the Mean can average
  mixed units; confirm all DO is µmol/kg before combining.
- **Non-comparable methods:** extracted bottle chl vs in-situ fluorometer chl (factor 2–5 apart) are
  both `chlorophyll`; split them into separate variables. Same rule for future pH (scale/method).
- **Composition artifacts:** the mean jumps when a mooring starts/ends or a cruise passes. Show per-bin
  contributors (n, source types) and between-platform spread, and label it a "composite of available
  observations".
- **Anomaly mode:** subtract each platform's own climatology before combining. This is the standard
  merge method, and it removes offset, depth and composition bias.
- Depth/season bias inside the box: casts are sample-weighted, not depth-weighted, and cruise-seasonal.
  Depth stratification is covered by the time × depth heatmap above.

### Threshold alerts + "current conditions" panel
Surface where sensors or model regions are corrosive/hypoxic *now* (latest data or forecast), with
optional per-site email/RSS subscriptions.
- Reuse: Extreme Events / Compound Stress logic in `AnalysisWorkspace`.

### Map animation export (MP4/GIF)
Render the time animation of a variable over a window as a clip, for outreach and case studies.
- Reuse: existing time-animation loop in `TimeControls.vue` and value-packed tiles.

### Model-skill scorecard
Bias / RMSE / correlation for every in-domain sensor × variable, as a table and as colour on the
buoys, so users can see where to trust the model.
- Reuse: Sensor–Model comparison stats in `ComparisonWorkspace.vue`.

### Mobile / tablet layout
Replace `MobileBlocker.vue` with a reduced layout (map + one variable + point click + timeseries)
for field users. Share links already carry the view.

## Later / ideas

- **IOS ship casts on a schedule** — `ios_casts_to_ch.py` is CLI-only; a weekly Prefect flow running `--since <last year>` would pick up new casts. The first full-archive load (~124k casts) has to run by hand.
- **Argo on a schedule** — `argo_to_ch.py` is CLI-only; a weekly flow running `--since <last year>` would pick up new profiles and their delayed-mode revisions. The first full load (~2 h) has to run by hand.
- **Per-deployment colours in a merged sensor's series** — a merge plots as one line today; colouring by member (the data is in `members`) would show where one deployment ends and the next begins.
- **DFO MEDS buoys** — `catalog_dfo_meds.yml` is imported but every entry is `inactive`, so `/sensors` hides them; mark them `archive: true` instead to show their history without hourly polling.

## Parked

- **Bathymetry raster layer** — kept but unused; needs UX for "map shows bathymetry, charts show another variable".
- **LiveOcean** — removed; re-adding needs the new SSH/sync convention.
- **Mapbox buoy clustering** — planned once sensor density makes nearest-station click selection ambiguous.
