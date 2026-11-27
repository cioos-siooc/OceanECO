"""scripts/backup.sh (ClickHouse + SSC tiles → the backup host) as a Prefect flow on a schedule.

    python flows.py        # serve the deployment, poll for runs

One flow run per backup; the script's output (rsync totals per table and for
the images) is the run's log, and a non-zero exit marks the run Failed.
Overlapping runs are cancelled (`CANCEL_NEW`): a second rsync of the same
parts would only compete with the first. No retries — the next night is the
retry, and a run that dies leaves nothing behind (the script unfreezes on exit
and again at its start).

`serve()` re-applies `BACKUP_SCHEDULE_PAUSED` on every start, so the UI's pause
toggle lasts only until the container restarts; stop `backup-scheduler` for a
pause that holds.
"""

import os
import subprocess

from prefect import flow

SCRIPT = '/app/scripts/backup.sh'
DEFAULT_CRON = '0 3 * * *'


@flow(name='oceaneco-backup', log_prints=True)
def backup(dry_run: bool = False) -> None:
    """Back up the API machine's ClickHouse tables and SSC tiles (`dry_run`:
    rsync --dry-run, report what would change)."""
    env = {**os.environ, **({'DRY': '1'} if dry_run else {})}
    proc = subprocess.Popen(['bash', SCRIPT], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, env=env)
    for line in proc.stdout:
        print(line.rstrip())
    if proc.wait():
        raise RuntimeError(f'backup.sh exited {proc.returncode}')


if __name__ == '__main__':
    # Serve the flow as imported by module name, not `__main__`'s copy (see sensors/flows.py).
    from prefect import serve
    from prefect.client.schemas.objects import ConcurrencyLimitConfig, ConcurrencyLimitStrategy
    from prefect.deployments.runner import EntrypointType

    import flows

    serve(flows.backup.to_deployment(
        name='OceanECO-backup',
        tags=['oceaneco'],
        description='API machine ClickHouse + SSC tiles -> backup host (ocean-acidification-dashboard)',
        cron=os.environ.get('BACKUP_CRON', DEFAULT_CRON),
        paused=os.getenv('BACKUP_SCHEDULE_PAUSED', 'false').strip().lower() in ('1', 'true', 'yes', 'on'),
        concurrency_limit=ConcurrencyLimitConfig(limit=1, collision_strategy=ConcurrencyLimitStrategy.CANCEL_NEW),
        entrypoint_type=EntrypointType.MODULE_PATH,
    ))
