from datetime import date

from modules.sync_hourly import prune_hourly


class FakeResult:
    def __init__(self, rows):
        self.result_rows = rows


class FakeClient:
    def __init__(self, newest, partitions):
        self.newest = newest
        self.partitions = partitions
        self.commands = []

    def query(self, sql, parameters=None):
        if 'SalishSeaCast_sync_log' in sql:
            return FakeResult([(self.newest,)])
        return FakeResult([(p,) for p in self.partitions])

    def command(self, sql, **kwargs):
        self.commands.append(sql)


def _tiles(root, names):
    for var in ('temperature', 'ph_total'):
        for n in names:
            d = root / var / n
            d.mkdir(parents=True)
            (d / '0.5.webp').write_bytes(b'x')


def test_prunes_whole_months_and_hourly_tiles_before_cutoff(tmp_path):
    # newest 2026-12-01, 92 days -> first date kept 2026-09-01
    client = FakeClient(date(2026, 12, 1), ['202607', '202608', '202609', '202612', 'tuple()'])
    _tiles(tmp_path, ['2026-08-31T233000', '2026-09-01T003000', '2026-08-31',
                      '2026-08', '2026-08-31T23:30:00'])
    (tmp_path / 'README').write_text('not a variable dir')

    out = prune_hourly(client, retention_days=92, image_dir=str(tmp_path))

    assert out == {'cutoff': '2026-09-01', 'partitions': ['202607', '202608'], 'tile_dirs': 4}
    assert client.commands == [
        "ALTER TABLE SalishSeaCast_hourly DROP PARTITION ID '202607'",
        "ALTER TABLE SalishSeaCast_hourly DROP PARTITION ID '202608'",
    ]
    for var in ('temperature', 'ph_total'):
        left = sorted(p.name for p in (tmp_path / var).iterdir())
        # daily and monthly folders stay; hourly ones on/after the cutoff stay
        assert left == ['2026-08', '2026-08-31', '2026-09-01T003000']


def test_keeps_partial_month_at_cutoff(tmp_path):
    # first date kept 2026-09-15: September stays whole, August goes
    client = FakeClient(date(2026, 12, 15), ['202608', '202609'])
    out = prune_hourly(client, retention_days=92, image_dir=str(tmp_path))
    assert out['partitions'] == ['202608']


def test_disabled_or_empty_log_does_nothing(tmp_path):
    _tiles(tmp_path, ['2020-01-01T003000'])
    client = FakeClient(date(2026, 12, 1), ['202001'])
    assert prune_hourly(client, retention_days=0, image_dir=str(tmp_path)) is None
    empty = FakeClient(date(1970, 1, 1), ['202001'])
    assert prune_hourly(empty, retention_days=92, image_dir=str(tmp_path)) is None
    assert client.commands == [] and empty.commands == []
    assert (tmp_path / 'temperature' / '2020-01-01T003000').exists()
