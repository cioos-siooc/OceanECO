# Backend reference

Data, storage, API, process pipeline, sensors and gliders. Linked from `CLAUDE.md`.

**Data source:** SalishSeaCast (SSC) only — daily NetCDF from ERDDAP (`salishsea.eos.ubc.ca/erddap`), curvilinear sigma-coordinate grid. LiveOcean was removed.

**Storage** (`/opt/data/` in containers = `./data/` locally): `SalishSeaCast/nc/` raw NetCDF; `SalishSeaCast/images/` WebP tiles; `sensors/{id}/{sensorCategoryCode}.nc`; `cache/oa_grid_cache.npz` (grid, populated from `grid_SSC` on first use); `bathymetry/seafloor_tiles/` (seafloor tiles, built by `scripts/seafloor_tiles.sh`; `bathymetry/seafloor_src/` holds its downloads).

### ClickHouse (`db-ch`)
The sole database. API access via `api/modules/clickhouse_helpers.py` (local `CH_HOST`/`CH_PORT`, or remote with `CH_USE_REMOTE=true` + `CH_REMOTE_URL`). Key tables: `grid_SSC` (`gridX`/`gridY`/`longitude`/`latitude`; nearest-neighbor lookups + tile rendering), `SalishSeaCast_hourly`/`SalishSeaCast_daily`, `SalishSeaCast_status` (pipeline state machine), `sensors`/`sensor_timeseries`, `glider_deployments`/`glider_profiles` (C-PROOF gliders; long `profile, depth, variable, value`). Variable metadata (labels incl. compact `short`, precision, colormap bounds) lives in `shared/variable_config.yml` + `shared/colormaps.json`, not a table.

### API (`api/`)
FastAPI app in `SERVER.py`. Blocking work runs in a `ProcessPoolExecutor` via `run_in_process()`, limited by `_extract_semaphore` (default 4). The API never reads NetCDF — all data comes from ClickHouse.

| Endpoint | Module |
|---|---|
| `POST /extractTimeseries` | `modules/extractTimeseries.py` |
| `POST /getProfile` | `modules/extract_profile.py` — vertical profile at a point/time; `bin_mode` hourly/daily/monthly (daily/monthly read `SalishSeaCast_daily` means) |
| `POST /depthProfile` | `modules/extract_depth_profile.py` — time-depth (Hovmöller) grid for `depth/TimeDepthHeatmap.vue`, optionally with a variable-depth sensor's casts binned onto it. Returns `grid` (`lat`/`lon`/`distanceKm` of the answering cell) |
| `POST /getMinMax` | `modules/extractMinMax.py` |
| `POST /sensorTimeseries` | `modules/extractSensorTimeseries.py` |
| `POST /extract_climateTimeseries` | `modules/extract_climate_timeseries.py` |
| `POST /analysis/timeseries` | `modules/ocean_analysis.py` |
| `POST /pointSnapshot` | `modules/point_snapshot.py` — every variable at one point for the Explore snapshot: all eight model columns at the map's depth in one read, plus the selected sensor's variables (via `extract_sensor_timeseries`, falling back to the last reading on record). Out-of-domain returns `model: null` + `modelError` rather than a 400 |
| `POST /crossSection` | `modules/extract_cross_section.py` — depth-vs-distance grid along a polyline (`vertices`, ≥2 `(lat, lon)`) at one time. Resamples by arc length, snaps via `shared/grid_lookup.py`'s cached KD-tree in one vectorized query, reads only distinct cells hit |
| `GET /gliders` | `modules/gliders.py` — C-PROOF deployments with a simplified `[lon, lat]` track (Douglas–Peucker, ~200 m) for the map + list; cached 5 min, gzipped |
| `POST /gliderSection` | `modules/gliders.py` — one variable of one deployment, or a `start`–`end` profile-number window of it, averaged to at most 600 columns × 256 depth rows (`perColumn` profiles per column; rows fixed per deployment, so every window shares them), with each column's `time`/`lat`/`lon`/`distanceKm`; gzipped |
| `GET /seafloor/{z}/{x}/{y}.webp` | Static value-packed seafloor depth tiles (z5–10, `SEAFLOOR_TILES_ROOT`) for the glider curtain's 3D seafloor; built locally by `scripts/seafloor_tiles.sh` (NRCan West Coast DEM, see `scripts/seafloor_tiles.md`) and copied to the API host |
| `GET /png/{source}/{var}/{dt}/{depth}` | Serves pre-rendered tiles; on a miss, `modules/extract_image.py` renders from ClickHouse (`shared/nc2tile.py`'s `render_tile_from_db`) and caches to the same path. `dt`'s shape selects bin mode: full timestamp = hourly, `YYYY-MM-DD` = daily, `YYYY-MM` = monthly. The "bottom" pseudo-depth isn't supported on the fallback path (404s) |
| `GET /variables` | `modules/variables.py` |
| `POST /admin/syncHourly`, `/admin/syncDaily` | `modules/sync_hourly.py` — bearer auth (`SYNC_API_TOKEN`); imports a date's Native-format export rsynced in by the remote pipeline into `SalishSeaCast_hourly`/`_daily` (logged in `SalishSeaCast_sync_log`) |

**Out-of-domain coordinates.** Point lookups go through `extractTimeseries.py`'s `_find_nearest_grid_point`, which raises `OutsideDomainError` when no `grid_SSC` cell is within `MAX_GRID_DIST_KM` (25 km). `SERVER.py`'s `_outside_domain_response` returns a 400 with a plain-string `detail` (many frontend call sites print it) **and** a structured `error` (`code: "outside_model_domain"`, `distanceKm`, `maxDistanceKm`, `requested`, `nearest`). Wired into `/extractTimeseries`, `/depthProfile`, `/getProfile`, `/extract_climateTimeseries`; frontend reads it via `useDepthProfileFetch.ts`'s `asOutsideDomainError()`. The exception must pass every field through `super().__init__` to survive `ProcessPoolExecutor` pickling. `ocean_analysis.py`'s `lookup_nearest_grid_cell` (used by `/analysis/timeseries`) is a **separate, unguarded** lookup.

### Process Pipeline (`process/`)
Entry: `process/SSC/cli.py`. Each file/day-variable is a row in `SalishSeaCast_status`, advancing:
```
pending_download → downloading → success_download → pending_compute → computing → success_compute
  → pending_image → imaging → success_image → pending_ingest → success_ingest → pending_sync → success_sync
```
- `SSC/downloader.py` — ERDDAP fetching with backfill
- `SSC/compute.py` — derived variables (pH, Ω aragonite) via PyCO2SYS
- `SSC/imaging.py` — WebP tiles via `nc2tile.py`
- `SSC/sync.py` — exports a date's rows to Native format, rsyncs them + images to the API machine (`cloudflared access ssh` ProxyCommand), then calls `POST /admin/syncHourly`

`run` = `check → download → check_image → compute → check_image → image → promote → ingest → promote → sync`, defined once in `cli.pipeline_steps()`. Step helpers raise `cli.PipelineError` (not `sys.exit`) so they can run inside Prefect tasks.

**Prefect.** `SSC/flows.py` is the only module importing Prefect (the CLI works without a server). Flow `oceaneco-ssc-pipeline`, deployment `OceanECO-SSC`, tag `oceaneco` (the server is shared across apps), one task run per step. Served by `scheduler` on cron `RUN_CRON` (default `0 */3 * * *`) with `RUN_LIMIT`/`RUN_WORKERS` (10/30); overlapping runs are cancelled (`CANCEL_NEW`). `SalishSeaCast.*`/`nc2tile` loggers reach task logs via `PREFECT_LOGGING_EXTRA_LOGGERS`. Sweep stages mark rows `failed_*` without raising; each run ends with an `oceaneco-ssc-status` markdown artifact and is marked Failed if any row failed. Ad-hoc runs (`date`, `force`) via the UI's "Run → custom".
- `RUN_SCHEDULE_PAUSED` (default `false`) is re-applied on every scheduler start, so a UI pause lasts until the next restart. Stop `scheduler` for a pause that holds.
- `prefect==` in `process/pyproject.toml` and `sensors/pyproject.toml` must be ≤ the shared server's version.
- Prod (`docker-compose.prod.process.yml`) has no `process` service and no local server; `scheduler` (`tools` profile) reports to `PREFECT_API_URL` (`https://pipelines.cioospacific.ca/api`, basic auth `PREFECT_AUTH_STRING`). A code update means rebuilding/recreating `scheduler`.
- Don't start a manual `SSC.cli run` while a scheduled one is in progress — both claim the same pending rows.
- Renaming a flow/deployment leaves the old one on the server — delete it in the UI.

**Shared code** (`shared/`, used by `api` and `process`): `nc2tile.py` (curvilinear → Web-Mercator WebP; grid from `grid_SSC` cached to `.npz`, bounds from `variable_config.py`, only `CH_*` env vars needed); `grid_lookup.py` (`cKDTree` over the same cached grid, built once per process, for batch nearest-cell snapping).

**Sensors** (`sensors/`, own compose service, unrelated to `process/`): ONC/ERDDAP → ClickHouse. `sensors/flows.py` (only Prefect importer) defines flows `oceaneco-sensors-erddap`/`-onc`, deployments `OceanECO-sensors-ERDDAP`/`-ONC` (crons `ERDDAP_CRON` `0 * * * *`, `ONC_CRON` `30 * * * *`, same `CANCEL_NEW`/shared-server setup), one task per sensor via `store_sensor()`, which raises `FetchError` on a failed request so the run is marked Failed. Served by `sensors-scheduler` (pausable via `SENSORS_SCHEDULE_PAUSED`); its `PREFECT_API_URL` is `:?`-required. Sensors are defined only in `sensors/catalog_*.yml` (one file per harvest source; no combined catalog), loaded into the `sensors` table by `manage_sensors.py import`. An ONC variable lists `sources` (`LOCATION/DEVICE_CATEGORY/code`, priority order, child locations allowed); `onc_to_ch.py` stores each as its own series in `sensor_timeseries.source` (part of the key). Readers merge them by that priority (`extractSensorTimeseries.py`'s `series_query`, also used by `/depthProfile`); `/sensorTimeseries`' `instrument` returns one, which the "Compare instruments" toggle (on the selected sensor's card in `sensorInfo.vue`, shown only when the selected variable has several instruments; state in `useViewState('explore')`) overlays in Explore with a difference panel.

**Gliders** (`sensors/cproof_to_ch.py`, CLI only — no Prefect flow yet): C-PROOF's gridded time–depth files (`L0-gridfiles/<dep>_grid[_delayed][_adjusted].nc`, discovered via `mission_all.txt`, which already picks each deployment's best variant) → `glider_deployments` + `glider_profiles`, kept apart from `sensors`/`sensor_timeseries` and their readers. The files are binned but not QC-screened, so `VARIABLES` applies a gross range per variable. Live files are rewritten in place: a deployment is re-fetched only when its ETag changes (`--force` overrides), then replaced wholesale (DELETE + insert). `--deployment ID` (repeatable) or `--all`.
