# Roadmap

Feature ideas and planned work for OceanECO. Shipped items move to [CHANGELOG.md](CHANGELOG.md);
detailed designs live in [notes/](notes/).

## Next (v1.1 candidates)

### Admin dashboard: deferred parts
The first version (`/admin`: sensors, add sensor, model status, Prefect jobs, storage, audit log; see CLAUDE.md) leaves
these for later. Design and prototype: [notes/admin-dashboard/](notes/admin-dashboard/design.md).
Banner, feature switches, maintenance mode and thresholds are already built for v2.0 on the local branch
`admin-dashboard-v2-parked` (commit `583b8d6`).
- **Maintenance mode:** a switch that pauses every CSV download (`ui/DownloadButton.vue`) while data is mid-change.
  Overlaps the Vercel maintenance middleware on main (`b332f09`), which takes the whole site down instead.
- **Notice banner:** message, info/warning level and an expiry, shown under the app header; the app reads it at load
  from a public `GET /settings` backed by an `admin_settings` table.
- **Feature switches** (gliders, ship casts, Area tab) and editable freshness thresholds. Not wanted for now; the
  thresholds are constants in `useAdmin.ts`.
- **Backups:** 6-hourly snapshots of the `sensors` table and job states (7 days), then daily (90 days), optional S3
  copy, a snapshot before each restore and before bulk changes over 10 sensors; Restore lists what it reverts.
- **Email alerts** when a sensor turns silent (needs SMTP).
- **Model runs from the dashboard:** retry from the failed step, rebuild map tiles, reprocess a range (needs new
  `SSC/flows.py` parameters and the status rows from PROCESS; the API only has its sync logs).
- **Backfill from a date** (needs a `since` parameter in both harvesters' `store_sensor` and the sensor flows) and
  **Find new datasets** (`discover_erddap.py` over a whole server).
- **Cache controls** for map tiles on disk and `cache/oa_grid_cache.npz`.
- **v2:** gliders (`glider_deployments`) and ship casts (`ship_casts`) aren't in the `sensors` table, so they need
  their own sections; DFO IOS moorings are `sensors` rows and appear on their own.

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

_(add here)_

## Parked

- **Bathymetry raster layer** — kept but unused; needs UX for "map shows bathymetry, charts show another variable".
- **LiveOcean** — removed; re-adding needs the new SSH/sync convention.
- **Mapbox buoy clustering** — planned once sensor density makes nearest-station click selection ambiguous.
