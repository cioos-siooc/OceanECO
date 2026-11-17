"""Load SalishSeaCast_hourly into the archive ClickHouse from per-day NetCDF
(SSC_NC_DIRS roots), via ingest.ingest_day (hourly rows only). Each finished
day is logged in rebuild_hourly_log, so a rerun resumes; ingest_day replaces
the rows of a day interrupted mid-insert.
"""
from __future__ import annotations

import logging
import time as _time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, timedelta

from shared.ssc_schema import HOURLY_TABLE, hourly_sql

from .ingest import ingest_day
from .rebuild_daily import nc_dirs

logger = logging.getLogger('SalishSeaCast.rebuild_hourly')

TABLE = HOURLY_TABLE
LOG_TABLE = 'rebuild_hourly_log'


def schema_sql() -> list[str]:
    return [
        hourly_sql(),
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


def load_day(d: date) -> tuple[date, int, list[str], float]:
    from .db import get_client
    t0 = _time.monotonic()
    client = get_client()
    try:
        if client.query(f"SELECT count() FROM {LOG_TABLE} FINAL WHERE date = '{d}'").result_rows[0][0]:
            return d, 0, [], 0.0
        n_rows, missing = ingest_day(client, d, nc_dirs(), daily=False)
        client.insert(LOG_TABLE, [[d, n_rows, missing]], column_names=['date', 'n_rows', 'missing'])
        return d, n_rows, missing, _time.monotonic() - t0
    finally:
        client.close()


def rebuild_range(start: date, end: date, workers: int = 4) -> list[str]:
    """Load start..end (inclusive). Returns the days that failed."""
    days = [start + timedelta(i) for i in range((end - start).days + 1)]
    logger.info('hourly %s..%s: %d days, %d workers', start, end, len(days), workers)
    t0, rows, failed = _time.monotonic(), 0, []
    import multiprocessing as mp
    with ProcessPoolExecutor(workers, mp_context=mp.get_context('fork')) as pool:
        futs = {pool.submit(load_day, d): d for d in days}
        for k, f in enumerate(as_completed(futs), 1):
            try:
                d, n, missing, sec = f.result()
            except Exception as e:
                logger.error('%s failed: %s', futs[f], e)
                failed.append(str(futs[f]))
                continue
            rows += n
            logger.info('%s: %d rows in %.0f s (missing: %s) [%d/%d, %.0f rows/s overall]',
                        d, n, sec, ','.join(missing) or '-', k, len(days),
                        rows / max(_time.monotonic() - t0, 1e-9))
    logger.info('hourly done: %d rows in %.0f s, %d failed %s', rows, _time.monotonic() - t0,
                len(failed), failed)
    return failed
