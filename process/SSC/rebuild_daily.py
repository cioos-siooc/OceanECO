"""Rebuild SalishSeaCast_daily into the archive ClickHouse (docker-compose.archive.yml).

Target schema: one integer column per variable (`{var}_q` = round(daily mean /
precision), precision from shared/variable_config.yml), yearly partitions, and
a `{var}_mean` ALIAS that decodes it, so the API's existing
`f"{variable}_mean"` SQL works unchanged against this table.

Built for the USB hard disks the hourly NetCDF archive lives on. The regular
ingest (ingest.py) opens every variable once per day, so parallel days make the
disks seek between files. Here each variable's source is streamed once, in time
order, by one process, in two stages:

  read    one process per variable (--workers at a time) reads the year day by
          day, computes the daily mean over a fixed set of ocean cells, and
          writes it, quantized, into a per-year scratch memmap
          (`{scratch}/{year}/{var}.i32`, shape (days, cells)).
  insert  joins the 11 memmaps day by day into SalishSeaCast_daily, logging each
          finished day in rebuild_log, so a rerun resumes where it stopped.

The cell set is the cells where temperature is valid (not NaN, not the 0.0
seafloor padding) in any hour of the year's first day. That's ingest.py's
mask rule, taken as static. The temperature read checks it: cells valid on a
later day but missing from the set are counted and logged. A day's rows are
the cells with at least one valid temperature hour that day, as in ingest.py.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import time as _time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, datetime, timedelta

import netCDF4
import numpy as np
import pandas as pd

from shared.ssc_schema import DAILY_TABLE, daily_sql

from .config import ALL_VARIABLES, VARIABLE_PRECISION, erddap_base_url

logger = logging.getLogger('SalishSeaCast.rebuild')

ARCHIVE_VARIABLES: list[str] = ALL_VARIABLES
TABLE = DAILY_TABLE
LOG_TABLE = 'rebuild_log'
NULL_Q = np.iinfo(np.int32).min          # memmap sentinel for "no value" -> NULL
GRID_SHAPE = (40, 898, 398)              # (depth, gridY, gridX)
SCRATCH_DIR = os.getenv('REBUILD_SCRATCH_DIR', '/scratch')
STATUS_EVERY_DAYS = 30


def precision(var: str) -> float:
    if var not in VARIABLE_PRECISION:
        raise KeyError(f'{var} has no precision in shared/variable_config.yml')
    return float(VARIABLE_PRECISION[var])


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def schema_sql() -> list[str]:
    return [
        daily_sql(),
        f"""CREATE TABLE IF NOT EXISTS {LOG_TABLE} (
  date Date,
  n_rows UInt64,
  missing Array(String),
  done_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree
ORDER BY date""",
    ]


def init_schema(client) -> None:
    for sql in schema_sql():
        client.command(sql)
    logger.info('Schema ready: %s, %s', TABLE, LOG_TABLE)


# ---------------------------------------------------------------------------
# NetCDF sources
# ---------------------------------------------------------------------------

def nc_dirs() -> list[str]:
    dirs = [d for d in os.getenv('SSC_NC_DIRS', '').split(':') if d]
    if not dirs:
        raise RuntimeError('SSC_NC_DIRS is empty (colon-separated NetCDF roots)')
    return dirs


def find_sources(var: str, year: int, days: list[date]) -> tuple[str, object] | None:
    """('yearly', path) if any root has {var}/{var}_{YYYY}.nc, else
    ('daily', {day: path}) from {var}/{var}_{YYYYMMDD}.nc or
    {var}/{YYYY}/{var}_{YYYYMMDD}.nc, else None. Never a *_tmp.nc."""
    for root in nc_dirs():
        p = os.path.join(root, var, f'{var}_{year}.nc')
        if os.path.isfile(p):
            return 'yearly', p
    per_day: dict[date, str] = {}
    for d in days:
        ymd = d.strftime('%Y%m%d')
        for root in nc_dirs():
            for p in (os.path.join(root, var, f'{var}_{ymd}.nc'),
                      os.path.join(root, var, str(year), f'{var}_{ymd}.nc')):
                if os.path.isfile(p):
                    per_day[d] = p
                    break
            if d in per_day:
                break
    return ('daily', per_day) if per_day else None


def _time_dim(ds: netCDF4.Dataset) -> str:
    return next(d for d in ds.dimensions if 'time' in d.lower())


def _day_indices(ds: netCDF4.Dataset, path: str) -> dict[date, np.ndarray]:
    """Time-step indices per calendar day. Some yearly files aren't monotonic
    (omega_arag_2012.nc repeats 2012-09-25 after Dec 31): keep the first
    occurrence of each timestamp, as ingest._DayFile does."""
    tv = ds.variables[_time_dim(ds)]
    times = pd.DatetimeIndex(netCDF4.num2date(tv[:], tv.units, getattr(tv, 'calendar', 'standard'),
                                              only_use_cftime_datetimes=False,
                                              only_use_python_datetimes=True))
    dup = times.duplicated(keep='first')
    if dup.any():
        logger.warning('%s: %d repeated time steps dropped (kept first)', path, int(dup.sum()))
    out: dict[date, list[int]] = {}
    for i, (t, is_dup) in enumerate(zip(times, dup)):
        if not is_dup:
            out.setdefault(t.date(), []).append(i)
    return {d: np.asarray(ix) for d, ix in out.items()}


def _read_blockwise(ncvar, t_sel, n_t: int, label: str, path: str, bad: list | None) -> np.ndarray:
    """Fallback after an HDF error: read one spatial chunk column at a time,
    leave unreadable ones NaN, and record every corrupt *storage* chunk
    (full time x depth x y x chunk extent) in `bad` for the repair stage."""
    chunks = ncvar.chunking()
    ct, cz, cy, cx = chunks if isinstance(chunks, list) else (24, 20, 20, 20)
    nt_file = ncvar.shape[0]
    t_idx = np.arange(nt_file)[t_sel]
    arr = np.full((n_t, *GRID_SHAPE), np.nan, dtype=np.float32)
    nz, ny, nx = GRID_SHAPE
    n_bad = 0
    for z in range(0, nz, cz):
        for y in range(0, ny, cy):
            for x in range(0, nx, cx):
                sl = (slice(z, min(z + cz, nz)), slice(y, min(y + cy, ny)), slice(x, min(x + cx, nx)))
                try:
                    arr[(slice(None), *sl)] = np.ma.filled(ncvar[(t_sel, *sl)], np.nan)
                    continue
                except RuntimeError:
                    pass
                # Pin down which time chunk(s) of this column are corrupt.
                for c0 in range(int(t_idx[0]) // ct * ct, int(t_idx[-1]) + 1, ct):
                    c1 = min(c0 + ct, nt_file)
                    try:
                        ncvar[(slice(c0, c1), *sl)]
                    except RuntimeError:
                        n_bad += 1
                        if bad is not None:
                            bad.append({'path': path, 'var': ncvar.name, 'day': label.split()[-1],
                                        't': [c0, c1], 'z': [sl[0].start, sl[0].stop],
                                        'y': [sl[1].start, sl[1].stop], 'x': [sl[2].start, sl[2].stop]})
    logger.warning('%s: %d corrupt chunk(s) in %s, left NULL until repaired', label, n_bad, path)
    return arr


def _read_steps(ncvar, idx: np.ndarray, label: str = '', path: str = '',
                bad: list | None = None) -> np.ndarray:
    """(n_t, depth, y, x) float32 with fill/missing -> NaN."""
    if len(idx) and np.all(np.diff(idx) == 1):
        t_sel = slice(int(idx[0]), int(idx[-1]) + 1)
    else:
        t_sel = idx
    try:
        arr = ncvar[t_sel]
    except RuntimeError as e:  # 'NetCDF: HDF error' = corrupt chunk(s)
        logger.warning('%s: %s, retrying chunk by chunk', label, e)
        arr = _read_blockwise(ncvar, t_sel, len(idx), label, path, bad)
    arr = np.ma.filled(arr, np.nan).astype(np.float32, copy=False)
    arr[np.abs(arr) >= 1e19] = np.nan
    return arr


def iter_days(var: str, source: tuple[str, object], days: list[date], bad: list | None = None):
    """Yield (day, hourly float32 array) in time order; days absent from the
    source are skipped (their memmap rows stay NULL). Corrupt storage chunks
    are appended to `bad` (see _read_blockwise) and read as NaN."""
    kind, where = source
    if kind == 'yearly':
        with netCDF4.Dataset(where) as ds:
            ncvar = ds.variables[var]
            ncvar.set_auto_maskandscale(True)
            idx = _day_indices(ds, where)
            for d in days:
                if d in idx:
                    yield d, _read_steps(ncvar, idx[d], f'{var} {d}', where, bad)
    else:
        for d in days:
            p = where.get(d)
            if not p:
                continue
            with netCDF4.Dataset(p) as ds:
                ncvar = ds.variables[var]
                ncvar.set_auto_maskandscale(True)
                ix = _day_indices(ds, p).get(d)
                if ix is not None:
                    yield d, _read_steps(ncvar, ix, f'{var} {d}', p, bad)


# ---------------------------------------------------------------------------
# Repair: corrupt NC chunks -> re-fetched from ERDDAP and written back in place
# ---------------------------------------------------------------------------

def _fetch_erddap(var: str, times: list[datetime], sl: tuple[slice, slice, slice]) -> np.ndarray:
    """(time, depth, y, x) block of `var` from the SalishSeaCast ERDDAP for the
    given timestamps. KeyError for variables ERDDAP doesn't publish (pH/Ω)."""
    import requests
    base = erddap_base_url(var)
    t0, t1 = (t.strftime('%Y-%m-%dT%H:%M:%SZ') for t in (times[0], times[-1]))
    dims = ''.join(f'%5B{s.start}:1:{s.stop - 1}%5D' for s in sl)
    url = f'{base}.nc?{var}%5B({t0}):1:({t1})%5D{dims}'
    tmp = os.path.join(SCRATCH_DIR, f'.erddap_{os.getpid()}.nc')
    for attempt in range(3):
        try:
            with requests.get(url, timeout=300) as r:
                r.raise_for_status()
                with open(tmp, 'wb') as f:
                    f.write(r.content)
            break
        except requests.RequestException:
            if attempt == 2:
                raise
            _time.sleep(10 * (attempt + 1))
    try:
        with netCDF4.Dataset(tmp) as ds:
            et = ds.variables['time']
            e_times = netCDF4.num2date(et[:], et.units, only_use_cftime_datetimes=False,
                                       only_use_python_datetimes=True)
            pos = {t.replace(tzinfo=None): i for i, t in enumerate(e_times)}
            sel = [pos[t.replace(tzinfo=None)] for t in times]   # KeyError if a step is missing
            return np.ma.filled(ds.variables[var][sel], np.nan).astype(np.float32)
    finally:
        os.remove(tmp)


def _read_input_block(var: str, times: list[datetime], sl: tuple[slice, slice, slice]) -> np.ndarray:
    """(time, depth, y, x) block of a local input NC (T/S/TA/DIC) at `times`."""
    days = sorted({t.date() for t in times})
    src = find_sources(var, days[0].year, days)
    if src is None:
        raise FileNotFoundError(f'no {var} NetCDF for {days[0]}')
    kind, where = src
    out = []
    paths = [where] if kind == 'yearly' else sorted({where[d] for d in days})
    for p in paths:
        with netCDF4.Dataset(p) as ds:
            tv = ds.variables[_time_dim(ds)]
            ft = netCDF4.num2date(tv[:], tv.units, only_use_cftime_datetimes=False,
                                  only_use_python_datetimes=True)
            pos = {t.replace(tzinfo=None): i for i, t in enumerate(ft)}
            for t in times:
                i = pos.get(t.replace(tzinfo=None))
                if i is not None:
                    out.append((t, np.ma.filled(ds.variables[var][(i, *sl)], np.nan).astype(np.float32)))
    got = {t.replace(tzinfo=None): a for t, a in out}
    missing = [t for t in times if t.replace(tzinfo=None) not in got]
    if missing:
        raise KeyError(f'{var}: {len(missing)} time step(s) missing, first {missing[0]}')
    arr = np.stack([got[t.replace(tzinfo=None)] for t in times])
    arr[np.abs(arr) >= 1e19] = np.nan
    return arr


def _compute_carbonate(var: str, times: list[datetime], sl: tuple[slice, slice, slice]) -> np.ndarray:
    """Recompute a pH/Ω block from the local T, S, TA, DIC files exactly as
    compute.py's _worker does (same unit conversion, pressure and PyCO2SYS options)."""
    import PyCO2SYS as pyco2
    from .config import DEPTH_TO_PRESSURE_FACTOR, SEAWATER_DENSITY
    ta = _read_input_block('total_alkalinity', times, sl) * (1000.0 / SEAWATER_DENSITY)
    dic = _read_input_block('dissolved_inorganic_carbon', times, sl) * (1000.0 / SEAWATER_DENSITY)
    t = _read_input_block('temperature', times, sl)
    s = _read_input_block('salinity', times, sl)
    kind, where = find_sources('temperature', times[0].year, [times[0].date()])
    with netCDF4.Dataset(where if kind == 'yearly' else next(iter(where.values()))) as ds:
        depth = np.asarray(ds.variables['depth'][sl[0]], dtype=np.float64)
    p = np.broadcast_to((depth / DEPTH_TO_PRESSURE_FACTOR)[None, :, None, None], ta.shape)
    mask = ~(np.isnan(ta) | np.isnan(dic) | np.isnan(t) | np.isnan(s) | (s <= 0))
    out = np.full(ta.shape, np.nan, dtype=np.float32)
    if mask.any():
        res = pyco2.sys(par1=ta[mask], par2=dic[mask], par1_type=1, par2_type=2,
                        salinity=s[mask], temperature=t[mask], pressure=p[mask],
                        opt_pH_scale=1, opt_k_carbonic=10, opt_buffers_mode=0)
        key = {'ph_total': 'pH', 'omega_arag': 'saturation_aragonite',
               'omega_cal': 'saturation_calcite'}[var]
        out[mask] = np.asarray(res[key], dtype=np.float32)
    return out


def _recompute_block(b: dict, times: list[datetime], sl: tuple[slice, slice, slice]) -> np.ndarray:
    """pH/Ω repair source. First recomputes a neighbouring *readable* chunk and
    checks it against the file (within precision/2) so we only write values
    produced the same way as the originals."""
    tsl = slice(*b['t'])
    with netCDF4.Dataset(b['path']) as ds:
        v = ds.variables[b['var']]
        nx = v.shape[-1]
        w = sl[2].stop - sl[2].start
        candidates = [sl[2].start - w, sl[2].stop] if sl[2].start >= w else [sl[2].stop]
        ref = None
        for x0 in candidates:
            if 0 <= x0 < nx:
                nsl = (sl[0], sl[1], slice(x0, min(x0 + w, nx)))
                try:
                    ref = (nsl, np.ma.filled(v[(tsl, *nsl)], np.nan).astype(np.float32))
                    break
                except RuntimeError:
                    continue
    if ref is None:
        raise RuntimeError('no readable neighbour chunk to validate the recompute against')
    nsl, stored = ref
    check = _compute_carbonate(b['var'], times, nsl)
    both = np.isfinite(stored) & np.isfinite(check)
    if both.sum():
        diff = float(np.nanmax(np.abs(stored[both] - check[both])))
        if diff > precision(b['var']) / 2:
            raise RuntimeError(f'recompute check failed on neighbour chunk (max diff {diff:g})')
    if (np.isfinite(stored) != np.isfinite(check)).any():
        raise RuntimeError('recompute check failed: NaN pattern differs on neighbour chunk')
    return _compute_carbonate(b['var'], times, sl)


def repair_chunks(bad: list[dict]) -> list[dict]:
    """Rewrite each corrupt storage chunk in place and verify it by reading it
    back: downloaded variables from ERDDAP, pH/Ω recomputed from the local
    inputs. The write covers the whole chunk, so HDF5 never has to read the
    corrupt bytes. Returns the chunks that could not be repaired."""
    from .config import COMPUTE_VARIABLES
    failed = []
    for b in bad:
        sl = tuple(slice(*b[k]) for k in ('z', 'y', 'x'))
        tsl = slice(*b['t'])
        what = f"{b['var']} {os.path.basename(b['path'])} t{b['t']} z{b['z']} y{b['y']} x{b['x']}"
        try:
            with netCDF4.Dataset(b['path']) as ds:
                tv = ds.variables[_time_dim(ds)]
                times = list(netCDF4.num2date(tv[tsl], tv.units, only_use_cftime_datetimes=False,
                                              only_use_python_datetimes=True))
            if b['var'] in COMPUTE_VARIABLES:
                block, how = _recompute_block(b, times, sl), 'recomputed from T/S/TA/DIC'
            else:
                block, how = _fetch_erddap(b['var'], times, sl), 'from ERDDAP'
            with netCDF4.Dataset(b['path'], 'r+') as ds:
                ds.variables[b['var']][(tsl, *sl)] = np.ma.masked_invalid(block)
            with netCDF4.Dataset(b['path']) as ds:
                back = np.ma.filled(ds.variables[b['var']][(tsl, *sl)], np.nan).astype(np.float32)
            if not np.array_equal(back, block, equal_nan=True):
                raise RuntimeError('read-back differs from the written block')
            logger.info('repaired %s %s (%d valid values)', what, how, int(np.isfinite(block).sum()))
        except Exception as e:
            logger.error('could not repair %s: %r', what, e)
            failed.append({**b, 'error': repr(e)})
    return failed


# ---------------------------------------------------------------------------
# Stage 1: read -> scratch memmaps
# ---------------------------------------------------------------------------

def _year_dir(scratch: str, year: int) -> str:
    return os.path.join(scratch, str(year))


def year_days(year: int, n_days: int | None = None) -> list[date]:
    start, end = date(year, 1, 1), date(year, 12, 31)
    days = [start + timedelta(i) for i in range((end - start).days + 1)]
    return days[:n_days] if n_days else days


def build_cells(year: int, days: list[date], scratch: str) -> None:
    """Fix the year's cell set from temperature's first available day."""
    ydir = _year_dir(scratch, year)
    path = os.path.join(ydir, 'cells.npz')
    if os.path.exists(path):
        return
    os.makedirs(ydir, exist_ok=True)
    src = find_sources('temperature', year, days)
    if not src:
        raise FileNotFoundError(f'No temperature NetCDF for {year}')
    bad: list = []
    first_day, hours = next(iter_days('temperature', src, days, bad))
    if bad:
        # The cell set must come from a clean day: fix the file now, read again.
        if repair_chunks(bad):
            raise RuntimeError(f'temperature {first_day}: corrupt chunk(s) not repairable')
        first_day, hours = next(iter_days('temperature', src, days))
    valid_any = (np.isfinite(hours) & (hours != 0)).any(axis=0)       # (d, y, x)
    flat = np.flatnonzero(valid_any.ravel()).astype(np.int64)

    kind, where = src
    coord_path = where if kind == 'yearly' else next(iter(where.values()))
    with netCDF4.Dataset(coord_path) as ds:
        depth = np.asarray(ds.variables['depth'][:], dtype=np.float32)
        grid_y = np.asarray(ds.variables['gridY'][:]).astype(np.uint16)
        grid_x = np.asarray(ds.variables['gridX'][:]).astype(np.uint16)
    di, yi, xi = np.unravel_index(flat, GRID_SHAPE)
    np.savez(path, flat=flat, depth=depth[di], gridY=grid_y[yi], gridX=grid_x[xi],
             days=np.array([d.isoformat() for d in days]))
    logger.info('%d: %d ocean cells from temperature on %s', year, len(flat), first_day)


def _load_cells(scratch: str, year: int) -> dict:
    with np.load(os.path.join(_year_dir(scratch, year), 'cells.npz')) as z:
        return {k: z[k] for k in z.files}


def read_variable(var: str, year: int, n_days: int | None, scratch: str) -> dict:
    """Stream one variable's year into {var}.i32 (and valid.u8 for temperature).
    Idempotent: skipped when {var}.done exists."""
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    ydir = _year_dir(scratch, year)
    done_path = os.path.join(ydir, f'{var}.done')
    if os.path.exists(done_path):
        with open(done_path) as f:
            return json.load(f)

    days = year_days(year, n_days)
    day_pos = {d: i for i, d in enumerate(days)}
    cells = _load_cells(scratch, year)
    flat = cells['flat']
    n_cells = len(flat)
    p = precision(var)

    src = find_sources(var, year, days)
    if src is None:
        result = {'var': var, 'days_read': 0, 'missing': 'no source'}
        logger.warning('%s %d: no NetCDF source, column stays NULL', var, year)
        with open(done_path, 'w') as f:
            json.dump(result, f)
        return result

    q = np.lib.format.open_memmap(os.path.join(ydir, f'{var}.i32.npy'), mode='w+',
                                  dtype=np.int32, shape=(len(days), n_cells))
    q[:] = NULL_Q
    valid_mm = None
    if var == 'temperature':
        valid_mm = np.lib.format.open_memmap(os.path.join(ydir, 'valid.u8.npy'), mode='w+',
                                             dtype=np.uint8, shape=(len(days), n_cells))
    outside_max = 0
    t0 = _time.monotonic()
    n_read = 0
    bad_chunks: list = []
    for d, hours in iter_days(var, src, days, bad_chunks):
        n_t = hours.shape[0]
        sub = hours.reshape(n_t, -1)[:, flat]                       # (n_t, n_cells)
        if var == 'temperature':
            valid = np.isfinite(sub) & (sub != 0)
            full_any = (np.isfinite(hours) & (hours != 0)).any(axis=0).ravel()
            outside_max = max(outside_max, int(full_any.sum()) - int(full_any[flat].sum()))
        else:
            valid = np.isfinite(sub)
        cnt = valid.sum(axis=0)
        s = np.where(valid, sub, 0).sum(axis=0, dtype=np.float64)
        with np.errstate(invalid='ignore', divide='ignore'):
            mean = s / cnt
        ok = cnt > 0
        row = np.full(n_cells, NULL_Q, dtype=np.int32)
        row[ok] = np.rint(mean[ok] / p).astype(np.int32)
        i = day_pos[d]
        q[i] = row
        if valid_mm is not None:
            valid_mm[i] = ok
        n_read += 1
        if n_read % STATUS_EVERY_DAYS == 0:
            el = _time.monotonic() - t0
            logger.info('%s %d: %d/%d days (%.1f s/day)', var, year, n_read, len(days), el / n_read)
    q.flush()
    if valid_mm is not None:
        valid_mm.flush()
    if outside_max:
        logger.warning('temperature %d: up to %d valid cells/day fall outside the cell set '
                       '(mask not static) and are dropped', year, outside_max)
    result = {'var': var, 'days_read': n_read, 'days': len(days),
              'sec': round(_time.monotonic() - t0, 1), 'outside_max': outside_max,
              'bad_chunks': bad_chunks}
    with open(done_path, 'w') as f:
        json.dump(result, f)
    logger.info('%s %d: read done %s', var, year, result)
    return result


def _source_root(var: str, year: int, days: list[date]) -> str:
    src = find_sources(var, year, days[:1])
    if not src:
        return ''
    kind, where = src
    path = where if kind == 'yearly' else next(iter(where.values()))
    return next((r for r in nc_dirs() if path.startswith(r)), '')


def read_stage(year: int, variables: list[str], workers: int, n_days: int | None, scratch: str) -> None:
    days = year_days(year, n_days)
    build_cells(year, days, scratch)
    # Interleave variables across NetCDF roots (drives) so both disks stream at once.
    by_root: dict[str, list[str]] = {}
    for v in variables:
        by_root.setdefault(_source_root(v, year, days), []).append(v)
    order: list[str] = []
    queues = list(by_root.values())
    while any(queues):
        for qv in queues:
            if qv:
                order.append(qv.pop(0))
    logger.info('read %d: %s with %d workers', year, order, workers)
    failures = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(read_variable, v, year, n_days, scratch): v for v in order}
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception:
                logger.exception('read failed for %s %d', futs[fut], year)
                failures.append(futs[fut])
    if failures:
        raise RuntimeError(f'read stage failed for {failures}')
    bad = {v: len(_done(scratch, year, v).get('bad_chunks', [])) for v in variables}
    bad = {v: n for v, n in bad.items() if n}
    if bad:
        logger.warning('read %d: corrupt NC chunks found %s, run the repair stage', year, bad)


def _done(scratch: str, year: int, var: str) -> dict:
    p = os.path.join(_year_dir(scratch, year), f'{var}.done')
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def repair_stage(year: int, variables: list[str], workers: int, n_days: int | None,
                 scratch: str) -> None:
    """Fix every corrupt chunk the read stage recorded (download from ERDDAP,
    write into the NC file in place), then re-read only the affected
    variables. Raises if anything is still unrepaired, so insert can't run."""
    affected: dict[str, list[dict]] = {}
    for v in variables:
        b = _done(scratch, year, v).get('bad_chunks') or []
        if b:
            affected[v] = b
    if not affected:
        logger.info('repair %d: no corrupt chunks recorded', year)
        return
    seen: set = set()
    unique = []
    for chunks in affected.values():
        for b in chunks:
            key = (b['path'], *b['t'], *b['z'], *b['y'], *b['x'])
            if key not in seen:
                seen.add(key)
                unique.append(b)
    logger.info('repair %d: %d corrupt chunk(s) in %s', year, len(unique), sorted(affected))
    failed = repair_chunks(unique)
    failed_vars = {b['var'] for b in failed}
    reread = [v for v in affected if v not in failed_vars]
    for v in reread:
        os.remove(os.path.join(_year_dir(scratch, year), f'{v}.done'))
    if reread:
        logger.info('repair %d: re-reading %s from the repaired files', year, reread)
        read_stage(year, reread, min(workers, len(reread)), n_days, scratch)
    still = [v for v in variables if _done(scratch, year, v).get('bad_chunks')]
    if failed or still:
        raise RuntimeError(f'repair {year}: unrepaired chunks remain for {sorted(set(still) | failed_vars)}')
    logger.info('repair %d: all corrupt chunks repaired and re-read', year)


# ---------------------------------------------------------------------------
# Stage 2: scratch memmaps -> ClickHouse
# ---------------------------------------------------------------------------

def insert_stage(client, year: int, variables: list[str], n_days: int | None, scratch: str) -> None:
    ydir = _year_dir(scratch, year)
    for v in variables:
        if not os.path.exists(os.path.join(ydir, f'{v}.done')):
            raise RuntimeError(f'{v} {year} not read yet (run the read stage first)')
    days = year_days(year, n_days)
    cells = _load_cells(scratch, year)
    valid = np.load(os.path.join(ydir, 'valid.u8.npy'), mmap_mode='r')
    q = {}
    for v in ARCHIVE_VARIABLES:
        p = os.path.join(ydir, f'{v}.i32.npy')
        q[v] = np.load(p, mmap_mode='r') if v in variables and os.path.exists(p) else None
    no_data = [v for v, a in q.items() if a is None]

    done = {r[0] for r in client.query(
        f'SELECT date FROM {LOG_TABLE} FINAL WHERE toYear(date) = {year}').result_rows}
    t0 = _time.monotonic()
    n_rows_total = 0
    for i, d in enumerate(days):
        if d in done:
            continue
        rows = np.flatnonzero(valid[i])
        if not len(rows):
            continue
        partial = client.query(f"SELECT count() FROM {TABLE} WHERE time = '{d}'").result_rows[0][0]
        if partial:
            logger.warning('%s: %d rows from an interrupted insert, deleting', d, partial)
            client.command(f"DELETE FROM {TABLE} WHERE time = '{d}'")
        cols = {
            'time': np.full(len(rows), np.datetime64(d, 'D')),
            'depth': cells['depth'][rows],
            'gridX': cells['gridX'][rows],
            'gridY': cells['gridY'][rows],
        }
        missing = list(no_data)
        for v in ARCHIVE_VARIABLES:
            if q[v] is None:
                vals = np.zeros(len(rows), dtype=np.int32)
                mask = np.ones(len(rows), dtype=bool)
            else:
                vals = np.asarray(q[v][i, rows])
                mask = vals == NULL_Q
                if mask.all():
                    missing.append(v)
                vals = np.where(mask, 0, vals).astype(np.int32)
            cols[f'{v}_q'] = pd.arrays.IntegerArray(vals, mask)
        df = pd.DataFrame(cols)
        client.insert_df(TABLE, df)
        client.insert(LOG_TABLE, [[d, len(rows), sorted(set(missing))]],
                      column_names=['date', 'n_rows', 'missing'])
        n_rows_total += len(rows)
        el = _time.monotonic() - t0
        logger.info('%s: %d rows (%.0f rows/s, missing: %s)', d, len(rows),
                    n_rows_total / max(el, 1e-9), ','.join(sorted(set(missing))) or '-')
    logger.info('insert %d done: %d rows in %.0f s', year, n_rows_total, _time.monotonic() - t0)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def rebuild_year(client, year: int, workers: int = 6, stage: str = 'all',
                 variables: list[str] | None = None, n_days: int | None = None,
                 scratch: str = SCRATCH_DIR, keep_scratch: bool = False) -> None:
    variables = list(variables or ARCHIVE_VARIABLES)
    unknown = [v for v in variables if v not in ARCHIVE_VARIABLES]
    if unknown:
        raise ValueError(f'Unknown variables: {unknown}')
    if stage in ('all', 'insert') and 'temperature' not in variables:
        raise ValueError('variables must include temperature (it defines the rows)')
    if stage in ('all', 'read'):
        read_stage(year, variables, workers, n_days, scratch)
    if stage in ('all', 'repair'):
        repair_stage(year, variables, workers, n_days, scratch)
    if stage in ('all', 'insert'):
        unrepaired = [v for v in variables if _done(scratch, year, v).get('bad_chunks')]
        if unrepaired:
            raise RuntimeError(f'{year}: corrupt NC chunks still unrepaired for {unrepaired} '
                               '(see their .done files); not inserting')
        insert_stage(client, year, variables, n_days, scratch)
        if not keep_scratch and stage == 'all' and not n_days:
            shutil.rmtree(_year_dir(scratch, year), ignore_errors=True)
            logger.info('scratch for %d removed', year)
