"""SalishSeaCast model tables: the one copy of their DDL, used by process/
(ingest writes them) and api/ (sync imports into them).

Each variable is stored as `{var}_q` Nullable(Int32) = round(value / precision),
precision from variable_config.yml, and decoded by ALIAS columns, so readers
keep using the old names: `{var}` in the hourly table, `{var}_mean` in the
daily one (mean only; there are no min/max columns). SELECT * skips ALIAS
columns, so an export carries only the `_q` columns.

The hourly table has no TTL: dropping old months is a separate, explicit step.
"""
from __future__ import annotations

from shared.variable_config import load_variable_config

HOURLY_TABLE = 'SalishSeaCast_hourly'
DAILY_TABLE = 'SalishSeaCast_daily'

# Column order of both tables.
SSC_VARIABLES: list[str] = [
    'temperature', 'salinity', 'total_alkalinity', 'dissolved_oxygen', 'dissolved_inorganic_carbon',
    'ph_total', 'omega_arag', 'omega_cal',
    'nitrate', 'diatoms', 'flagellates',
]


def precision(var: str) -> float:
    meta = load_variable_config()['variables'].get(var)
    if not meta or 'precision' not in meta:
        raise KeyError(f'{var} has no precision in shared/variable_config.yml')
    return float(meta['precision'])


def _q_cols() -> str:
    return ',\n  '.join(f'{v}_q Nullable(Int32) CODEC(T64, ZSTD(6))' for v in SSC_VARIABLES)


def _alias_cols(suffix: str) -> str:
    return ',\n  '.join(f'{v}{suffix} Nullable(Float32) ALIAS toFloat32({v}_q * {precision(v)!r})'
                        for v in SSC_VARIABLES)


def hourly_sql(table: str = HOURLY_TABLE) -> str:
    return f"""CREATE TABLE IF NOT EXISTS {table} (
  time DateTime CODEC(DoubleDelta, ZSTD(4)),
  depth Float32 CODEC(Gorilla(4), ZSTD(4)),
  gridX UInt16 CODEC(DoubleDelta, ZSTD(4)),
  gridY UInt16 CODEC(DoubleDelta, ZSTD(4)),
  {_q_cols()},
  {_alias_cols('')}
) ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (gridX, gridY, depth, time)"""


def daily_sql(table: str = DAILY_TABLE) -> str:
    return f"""CREATE TABLE IF NOT EXISTS {table} (
  time Date,
  depth Float32,
  gridX UInt16,
  gridY UInt16,
  {_q_cols()},
  {_alias_cols('_mean')}
) ENGINE = MergeTree
PARTITION BY toYear(time)
ORDER BY (gridX, gridY, time, depth)"""
