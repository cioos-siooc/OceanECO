"""ClickHouse ingestion step for the SalishSeaCast pipeline.

One date's hourly NetCDF (one file per variable) -> SalishSeaCast_hourly and
SalishSeaCast_daily, both storing `{var}_q` = round(value / precision)
(schema in shared/ssc_schema.py).

Rows: the cells where temperature is valid that hour (not NaN, not the 0.0
seafloor padding); every other variable is sampled at those rows, NaN -> NULL.
A cell's daily row is the mean of its hourly values (cells with at least one
valid hour); a variable's mean skips its NaN hours.

Read BLOCK_HOURS at a time per variable and inserted in ClickHouse Native
format built straight from numpy (clickhouse-connect's insert_df boxes nullable
ints into Python objects, ~19 GB for one day): peak ~5 GB, ~90 s a day.

Rerunnable: the date's existing rows are deleted before it's written.

Picks up dates where all variables are at pending_ingest (set by
db.promote_ready_dates() after all images complete), and renders each date's
daily surface tiles from the rows just written (imaging.image_daily_surface).
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

import netCDF4
import numpy as np
import pandas as pd

from shared.ssc_schema import DAILY_TABLE, HOURLY_TABLE, precision

from .config import (
    ALL_VARIABLES, NC_BASE_DIR,
    STATUS_FAILED_INGEST, STATUS_INGESTING, STATUS_SUCCESS_INGEST,
)
from .db import get_dates_pending_ingest, get_row, mark_failed, mark_running, mark_success
from .imaging import image_daily_surface

logger = logging.getLogger('SalishSeaCast.ingest')

BLOCK_HOURS = 6   # hours read per variable at a time (pH/Ω files are chunked 6 h deep)


# ---------------------------------------------------------------------------
# NetCDF
# ---------------------------------------------------------------------------

def find_nc(variable: str, date_val: date, nc_dirs: list[str]) -> str | None:
    """First of, in each root: {var}/{var}_{YYYYMMDD}.nc, {var}/{YYYY}/{var}_{YYYYMMDD}.nc,
    {var}/{var}_{YYYY}.nc (a yearly file of hourly fields)."""
    ymd = date_val.strftime('%Y%m%d')
    for root in nc_dirs:
        for p in (os.path.join(root, variable, f'{variable}_{ymd}.nc'),
                  os.path.join(root, variable, str(date_val.year), f'{variable}_{ymd}.nc'),
                  os.path.join(root, variable, f'{variable}_{date_val.year}.nc')):
            if os.path.isfile(p):
                return p
    return None


class _DayFile:
    """One variable's time steps on one date. Yearly files aren't always
    monotonic (omega_arag_2012.nc repeats 2012-09-25 after Dec 31): the first
    occurrence of each timestamp is kept."""

    def __init__(self, variable: str, date_val: date, path: str):
        self.path = path
        self.ds = netCDF4.Dataset(path)
        try:
            tv = self.ds.variables[next(d for d in self.ds.dimensions if 'time' in d.lower())]
            times = pd.DatetimeIndex(netCDF4.num2date(
                tv[:], tv.units, getattr(tv, 'calendar', 'standard'),
                only_use_cftime_datetimes=False, only_use_python_datetimes=True))
            on_day = times.normalize() == pd.Timestamp(date_val)
            dup = on_day & times.duplicated(keep='first')
            if dup.any():
                logger.warning('%s: dropped %d repeated time steps on %s (kept the first)',
                               path, int(dup.sum()), date_val)
            self.idx = np.flatnonzero(on_day & ~dup)
            if not len(self.idx):
                raise FileNotFoundError(f'{path} has no time steps on {date_val}')
            self.times = times[self.idx].values.astype('datetime64[s]')
            self.var = self.ds.variables[variable]
            self.var.set_auto_maskandscale(True)
            if self.var.dimensions[1:] != ('depth', 'gridY', 'gridX'):
                raise RuntimeError(f'{path}: unexpected dims {self.var.dimensions}')
        except Exception:
            self.ds.close()
            raise

    def read(self, sel: slice) -> np.ndarray:
        """Hours [sel] of the day as (n_hours, depth * gridY * gridX) float32, fill -> NaN."""
        ix = self.idx[sel]
        t = slice(int(ix[0]), int(ix[-1]) + 1) if np.all(np.diff(ix) == 1) else ix
        arr = np.ma.filled(self.var[t], np.nan).astype(np.float32, copy=False)
        arr[np.abs(arr) >= 1e19] = np.nan
        return arr.reshape(len(ix), -1)


# ---------------------------------------------------------------------------
# ClickHouse Native format
# ---------------------------------------------------------------------------

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _native_block(n_rows: int, cols: list[tuple[str, str, list[np.ndarray]]]) -> bytes:
    """One Native-format block from little-endian numpy columns: (name, type,
    parts), a Nullable column's parts being [null map as uint8, values]."""
    buf = [_varint(len(cols)), _varint(n_rows)]
    for name, typ, parts in cols:
        for txt in (name, typ):
            enc = txt.encode()
            buf += [_varint(len(enc)), enc]
        buf += [np.ascontiguousarray(p).tobytes() for p in parts]
    return b''.join(buf)


def _insert(client, table: str, n_rows: int, cols: list) -> None:
    client.raw_insert(table, column_names=[c[0] for c in cols],
                      insert_block=_native_block(n_rows, cols), fmt='Native')


def _q_col(var: str, q: np.ndarray, null: np.ndarray) -> tuple[str, str, list[np.ndarray]]:
    return f'{var}_q', 'Nullable(Int32)', [null.astype(np.uint8), q]


def _quantize(vals: np.ndarray, var: str) -> tuple[np.ndarray, np.ndarray]:
    """(Int32 round(vals / precision) with 0 where NaN, NaN mask)."""
    null = ~np.isfinite(vals)
    q = np.zeros(len(vals), dtype=np.int32)
    q[~null] = np.rint(vals[~null] / precision(var)).astype(np.int32)
    return q, null


# ---------------------------------------------------------------------------
# Core ingestion
# ---------------------------------------------------------------------------

def _delete_existing(client, date_val: date, hourly: bool, daily: bool) -> None:
    start, end = date_val, date_val + timedelta(days=1)
    targets = []
    if hourly:
        targets.append((HOURLY_TABLE, f"time >= '{start}' AND time < '{end}'"))
    if daily:
        targets.append((DAILY_TABLE, f"time = '{start}'"))
    for table, where in targets:
        n = client.query(f'SELECT count() FROM {table} WHERE {where}').result_rows[0][0]
        if n:
            logger.warning('%s: replacing %d existing %s rows', date_val, n, table)
            client.command(f'DELETE FROM {table} WHERE {where}')


def ingest_day(client, date_val: date, nc_dirs: list[str], variables: list[str] | None = None,
               hourly: bool = True, daily: bool = True) -> tuple[int, list[str]]:
    """Write date_val's rows; returns (hourly row count, variables with no value
    all day). variables: a subset of ALL_VARIABLES including temperature (the
    ocean-cell mask); the others' columns are left NULL. Raises
    FileNotFoundError when a requested variable has no NetCDF for the date."""
    variables = list(variables or ALL_VARIABLES)
    unknown = [v for v in variables if v not in ALL_VARIABLES]
    if unknown:
        raise ValueError(f'Unknown variables: {unknown}')
    if 'temperature' not in variables:
        raise ValueError('variables must include temperature (it supplies the ocean-cell mask)')
    variables = ['temperature'] + [v for v in ALL_VARIABLES if v in variables and v != 'temperature']

    files: dict[str, _DayFile] = {}
    try:
        for v in variables:
            path = find_nc(v, date_val, nc_dirs)
            if path is None:
                raise FileNotFoundError(f'No {v} NetCDF for {date_val} in {nc_dirs}')
            files[v] = _DayFile(v, date_val, path)
        tf = files['temperature']
        for v, f in files.items():
            if not np.array_equal(f.times, tf.times):
                raise RuntimeError(f'{v} {date_val}: time steps differ from temperature')
        n_hours = len(tf.times)
        grid_shape = tf.var.shape[1:]
        n_cell = int(np.prod(grid_shape))
        depth_c = np.asarray(tf.ds.variables['depth'][:], dtype=np.float32)
        gy_c = np.asarray(tf.ds.variables['gridY'][:]).astype(np.uint16)
        gx_c = np.asarray(tf.ds.variables['gridX'][:]).astype(np.uint16)
        logger.info('Ingesting %s: %d hours x %s grid, %d variables%s', date_val, n_hours,
                    grid_shape, len(variables), '' if hourly else ', daily only')

        _delete_existing(client, date_val, hourly, daily)

        hours_valid = np.zeros(n_cell, dtype=np.uint8)              # valid temperature hours per cell
        day_sum = {v: np.zeros(n_cell, dtype=np.float64) for v in variables} if daily else {}
        day_cnt = {v: np.zeros(n_cell, dtype=np.uint8) for v in variables} if daily else {}
        any_value = dict.fromkeys(variables, False)
        n_rows = 0
        for h0 in range(0, n_hours, BLOCK_HOURS):
            sel = slice(h0, min(h0 + BLOCK_HOURS, n_hours))
            q = {}
            for v in variables:                                       # temperature first
                blk = files[v].read(sel)                              # (hours, cells)
                if v == 'temperature':
                    valid = np.isfinite(blk) & (blk != 0)
                    hours_valid += valid.sum(axis=0, dtype=np.uint8)
                    idx = np.flatnonzero(valid.ravel())               # sorted, hour-major
                    bounds = np.searchsorted(idx // n_cell, np.arange(blk.shape[0] + 1))
                    cell = idx % n_cell
                    di, yi, xi = np.unravel_index(cell, grid_shape)
                    depth, grid_y, grid_x = depth_c[di], gy_c[yi], gx_c[xi]
                    del di, yi, xi, cell
                if daily:
                    m = valid & np.isfinite(blk)
                    day_sum[v] += np.where(m, blk, 0).sum(axis=0, dtype=np.float64)
                    day_cnt[v] += m.sum(axis=0, dtype=np.uint8)
                    del m
                vals = blk.ravel()[idx]
                del blk
                any_value[v] |= bool(np.isfinite(vals).any())
                if hourly:
                    q[v] = _quantize(vals, v)
            n_rows += len(idx)
            if not hourly:
                continue
            for h in range(len(bounds) - 1):
                a, b = int(bounds[h]), int(bounds[h + 1])
                if a == b:
                    continue
                t = np.full(b - a, tf.times[h0 + h].astype(np.int64), dtype=np.uint32)
                cols = [('time', 'DateTime', [t]), ('depth', 'Float32', [depth[a:b]]),
                        ('gridX', 'UInt16', [grid_x[a:b]]), ('gridY', 'UInt16', [grid_y[a:b]])]
                cols += [_q_col(v, q[v][0][a:b], q[v][1][a:b]) for v in variables]
                _insert(client, HOURLY_TABLE, b - a, cols)

        if daily:
            rows = np.flatnonzero(hours_valid)
            if not len(rows):
                raise RuntimeError(f'{date_val}: no valid temperature cells')
            di, yi, xi = np.unravel_index(rows, grid_shape)
            n = len(rows)
            day_no = (np.datetime64(date_val, 'D') - np.datetime64('1970-01-01', 'D')).astype(int)
            cols = [('time', 'Date', [np.full(n, day_no, dtype=np.uint16)]),
                    ('depth', 'Float32', [depth_c[di]]),
                    ('gridX', 'UInt16', [gx_c[xi]]), ('gridY', 'UInt16', [gy_c[yi]])]
            for v in variables:
                cnt = day_cnt[v][rows]
                with np.errstate(invalid='ignore', divide='ignore'):
                    mean = day_sum.pop(v)[rows] / cnt
                cols.append(_q_col(v, *_quantize(mean, v)))
            _insert(client, DAILY_TABLE, n, cols)
            logger.info('%s: %d daily rows', date_val, n)
    finally:
        for f in files.values():
            f.ds.close()

    missing = [v for v in variables if not any_value[v]]
    if missing:
        logger.warning('%s: no values at all for %s', date_val, ', '.join(missing))
    logger.info('Ingestion complete for %s: %d hourly rows%s', date_val, n_rows,
                '' if hourly else ' (not inserted, daily only)')
    return n_rows, missing


def ingest_date(client, date_val: date, nc_base_dir: str = NC_BASE_DIR,
                variables: list[str] | None = None, hourly: bool = True) -> int:
    """ingest_day from one NetCDF root; returns the hourly row count."""
    return ingest_day(client, date_val, [nc_base_dir], variables=variables, hourly=hourly)[0]


# ---------------------------------------------------------------------------
# Batch processor
# ---------------------------------------------------------------------------

def process_pending_ingests(client, limit: int = 5, nc_base_dir: str = NC_BASE_DIR) -> None:
    dates = get_dates_pending_ingest(client, limit=limit)
    if not dates:
        logger.info('No pending ingest jobs')
        return

    for date_val in dates:
        for var in ALL_VARIABLES:
            row      = get_row(client, date_val, var) or {}
            attempts = row.get('attempts', 0)
            mark_running(client, date_val, var, STATUS_INGESTING, attempts)

        try:
            n_rows = ingest_date(client, date_val, nc_base_dir=nc_base_dir)
            image_daily_surface(date_val)
            for var in ALL_VARIABLES:
                row      = get_row(client, date_val, var) or {}
                attempts = row.get('attempts', 0)
                mark_success(client, date_val, var, STATUS_SUCCESS_INGEST,
                             nc_path=str(n_rows), attempts=attempts)
            logger.info('Ingest complete for %s: %d rows', date_val, n_rows)
        except Exception as exc:
            logger.exception('Ingest failed for %s', date_val)
            for var in ALL_VARIABLES:
                row      = get_row(client, date_val, var) or {}
                attempts = row.get('attempts', 0)
                mark_failed(client, date_val, var, STATUS_FAILED_INGEST,
                            str(exc), attempts=attempts)
