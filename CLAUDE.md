# CLAUDE.md

Guidance for Claude Code in this repository. Area details live in `docs/claude/`; read the relevant file before working there:
- `docs/claude/backend.md`: API endpoints, out-of-domain errors, process pipeline and Prefect, sensors, gliders
- `docs/claude/frontend.md`: theme, UI, chart, CSV and share-link conventions, feature map, analytics

## Services & Ports

Host ports come from `docker-compose.dev.yml`'s `${VAR:-default}` fallbacks, overridden by `.env.dev`:

| Service | Description | Port |
|---|---|---|
| `front` | Nuxt frontend | 9010 |
| `api` | FastAPI backend | 9011 |
| `db-ch` | ClickHouse | 9013 (HTTP), 9014 (native) |
| `process` | Data pipeline worker (the CLI) — dev only | — |
| `scheduler` | Prod only (`docker-compose.prod.process.yml`): `process` image serving `SSC/flows.py` to Prefect; the only pipeline container there | — |
| `sensors-scheduler` | Prod only (`docker-compose.prod.api.yml`): `sensors` image serving `sensors/flows.py` (hourly ERDDAP/ONC ingestion) | — |

`docker-compose.staging.api.yml` runs a second `api` only (project `oa-staging`, port `STAGING_API_PORT`, default 9021; prod is 9011) from a separate clone, for example a v2 branch. It shares prod's `db-ch` via the external network `PROD_NETWORK` and has no sensors or sync.

Prefect is **prod-only**: both schedulers report to the shared https://pipelines.cioospacific.ca (the [cioos-pacific-pipeline](https://github.com/cioos-siooc/cioos-pacific-pipeline) stack; our flows are served by our own containers, not its `pipelines` work pool). Dev has no Prefect server or schedulers — run the CLI instead.

## Common Commands

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev up
```
**Always pass `--env-file`** (dev and prod). Without it, dev falls back to in-file defaults (front 3000, api 4000) and recreates dependent services on wrong ports; prod compose files `:?`-require `PREFECT_API_URL` and fail.

```bash
cd front && npm run dev | npm run build | npm run lint
cd api && pytest tests/                      # or a single file, e.g. tests/test_extract_timeseries_all.py
docker compose -f docker-compose.dev.yml exec db-ch clickhouse-client --query "SHOW TABLES"
./deploy.sh dev | prod                       # frontend → dev / master branch
```

**Process CLI** — dev: the `process` container or uv; prod: `docker compose -f docker-compose.prod.process.yml --env-file .env.process.remote exec scheduler uv run python -m SSC.cli …` (or `run --rm scheduler …` while it's stopped):
```bash
python -m SSC.cli {check|download|compute|image|ingest|sync|run|status} [--date YYYY-MM-DD] [--limit N] [--workers N]
# check: [--init-days N]; download/image: [--variable VAR]; run = all steps in order
```

## Architecture in brief
- **Data:** SalishSeaCast only (daily NetCDF from ERDDAP, curvilinear sigma grid). LiveOcean was removed.
- **Storage** (`/opt/data/` in containers = `./data/` locally): `SalishSeaCast/nc/` raw NetCDF; `SalishSeaCast/images/` WebP tiles; `sensors/{id}/{sensorCategoryCode}.nc`; `cache/oa_grid_cache.npz` (grid, populated from `grid_SSC` on first use); `bathymetry/seafloor_tiles/` (seafloor tiles, built by `scripts/seafloor_tiles.sh`; `bathymetry/seafloor_src/` holds its downloads).
- **ClickHouse** (`db-ch`) is the sole database, and the API never reads NetCDF. Variable metadata lives in `shared/variable_config.yml` and `shared/colormaps.json`, not in a table.
- **Pipeline:** `process/SSC/cli.py`; each row in `SalishSeaCast_status` moves through download → compute → image → ingest → sync. Don't start a manual `SSC.cli run` while a scheduled one is in progress.
- **Frontend:** Nuxt 4, Nuxt UI v4 (Tailwind v4, Reka UI) and Pinia, dark mode only. Vuetify is gone, so don't reintroduce `v-*` components.

## Frontend rules that apply everywhere
- Use Nuxt UI components for anything interactive. Icons come from the locally bundled MDI set, never the remote Iconify API.
- Charts are always ECharts, with colours from `config/palette.ts`'s `chart`. Never print a raw float: use `formatDisplayValue(varId, value, { unit })`, with the value already in display units.
- Never render a bare "Depth N m" (see Naming depths in `frontend.md`).
- All CSV downloads go through `useCsvExport.ts` and `ui/DownloadButton.vue`.
- Shareable state must live in `stores/main.ts`; per-tab control state goes through `useViewState(scope)`.
- Model raster tiles are value-packed, so keep them lossless with `base` 0.

## Python Environment
`process/`, `scripts/` use **uv** (`pyproject.toml` + `uv.lock`); `api/` uses pip + `requirements.txt`. Each has its own `.venv`.

## Version Logging
When asked to log a new version or update changes:
- Update `CHANGELOG.md` (Keep a Changelog: Added, Changed, Fixed).
- Bump the version in `package.json` per SemVer.
- Summarize key user-facing updates in ≤3 bullets.

## Roadmap
Feature ideas and planned work live in `ROADMAP.md` (Next / Later / Parked). When a roadmap item ships, remove it there and log it in `CHANGELOG.md`.