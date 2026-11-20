# Admin dashboard: design

An admin page inside OceanECO for watching and controlling sensors, model runs, jobs, storage and app settings.
Grafana (the shared CIOOS Pacific observability stack) stays the place for uptime, host and container health, and
logs. Umami stays the place for usage. This dashboard covers OceanECO's own data and the controls over it.

Clickable prototype: [prototype.html](prototype.html). Open it in a browser. Sensor and storage numbers are from the
dev ClickHouse on 12 Nov 2026. Rows marked *example* are illustrative.

## Decisions

| Topic | Decision |
|---|---|
| Users | One account, `admin`, with a password. No roles. The audit log doesn't record a user. |
| Read-only by default | After login everything is read-only. **Unlock** asks for the password again. Editing relocks after 15 minutes without a change, or with **Lock now**. The server must refuse writes from a locked session; greying out buttons is not enough. |
| Staged changes | Changes collect in a bottom bar and take effect only on **Apply**, which writes them to the audit log. **Discard** reverts them. Staged changes survive a relock, but Apply needs another unlock. |
| Sensor visibility and harvest | **On map** is today's `sensors.active`. **Auto-harvest** is a new per-sensor flag: whether the hourly job polls it. Silent sensors stay on the map. A hidden sensor is never harvested. A visible one can have auto-harvest on or off. **Harvest now** (↻) runs one sensor by hand. |
| Variables | Not editable here. Names, units and visibility stay in `shared/variable_config.yml`. |
| Backups | A snapshot of everything the dashboard controls every 6 hours (or daily). Keep 6-hourly for 7 days, then daily for 90 days, with an optional copy to S3. A snapshot is also taken before every restore and before any bulk change over 10 sensors. Measurements and model output are not included, since they can be re-harvested or reprocessed. The audit log is kept in full. |
| Access | Cloudflare Access and the login are decided later. |

## Sections

- **Overview:** a "needs attention" list (silent sensors still polled, failed model days, lagging sensors, unused
  tables), headline numbers, sensor freshness, recent actions.
- **Sensors:** status from the age of the newest value: live under 24 h, lagging 1–7 days, stale 7–90 days, silent
  over 90 days, or no data. Filters by status, organization and name, plus bulk "stop auto-harvest". Per-sensor
  controls: On map, Auto-harvest, Harvest now. The detail drawer holds the record coverage per variable; editable
  name, organization, depth and a note shown in the app; the variable mapping (source name, unit, conversion
  factor); Backfill from a date; and Delete data.
- **Add sensor:** a dialog. The source is an ERDDAP tabledap URL (with an optional row filter) or an ONC location
  code. **Look up** reads metadata only and warns about duplicates. Then review the position, record and the
  suggested variable mapping, set the details, how much to harvest the first time and the two switches, and stage
  the sensor.
- **Model runs:** a SalishSeaCast grid of variable × day, coloured by the furthest step reached, from
  `SalishSeaCast_status`. A selected cell shows its status, attempts, error and file. Actions: retry from the
  failed step, rebuild map tiles, rerun all steps, and reprocess a range (from, to, starting step, variables),
  which waits for any scheduled run.
- **Scheduled jobs:** the three Prefect deployments (`OceanECO-sensors-ERDDAP`, `OceanECO-sensors-ONC`,
  `oceaneco-ssc-pipeline`) with Run now, Pause and a link to Prefect. Also harvest one sensor.
- **Storage:** ClickHouse tables by size, grouped as Model, Observations and Not used by the app. Dropping a table
  requires typing a confirmation phrase. Cache controls: API response cache, map tiles on disk, grid cache.
- **App controls:** a notice banner (message, level, how long it shows), feature switches, sensor freshness
  thresholds, and email when a sensor turns silent.
- **Audit log:** every applied change with before and after values, and Undo for a single change.
- **Backups:** what a snapshot holds, the schedule, and a snapshot list with Download and Restore. Restore first
  lists the changes it would revert.

## What exists already

- Per-sensor harvest: both sensor flows in `sensors/flows.py` accept `sensor_id`.
- Add-sensor lookup: `sensors/discover_erddap.py` (`discover_one`), `sensors/discover_location.py` (`discover`),
  `sensors/manage_sensors.py` (`catalog_variables`).
- Model state: `SalishSeaCast_status` (date, variable, status, attempts, error_message), with statuses
  `{pending,success,failed}_{download,compute,image,ingest,sync}`.
- Admin auth precedent: `/admin/syncDaily` and `/admin/syncHourly` in `api/SERVER.py`.

## New pieces needed

- A `sensors` column for auto-harvest. The harvest flows must skip sensors with it off. Hiding a sensor turns it off.
- `/admin/*` API endpoints: sensor freshness, sensor writes, model status grid, reprocess, job controls (Prefect
  API), table sizes, cache clears, app settings, audit log, snapshots and restore.
- Storage for app settings, the audit log and snapshots (ClickHouse tables; snapshots optionally copied to S3).
- The public app reading app settings (banner, feature switches) at load time.
- The admin login with the read-only/unlock session and its server-side write check.
