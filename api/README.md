uv is used to install packages only.
Packages are installed system-wide inside the container.

## Cloudflare Tunnel (public ingress)

The API machine (API + ClickHouse) sits behind a firewall and isn't publicly
reachable. The `tunnel` service in `docker-compose.prod.api.yml` (cloudflared,
token in `CLOUDFLARE_TUNNEL_TOKEN`) is its only public ingress; the `api`
container's host port is bound to `127.0.0.1`. It serves:

- the frontend can reach the API for every request, and
- the PROCESS machine can call `POST /admin/syncHourly` after rsyncing a
  date's Native-format export over (the rsync itself goes over a *separate*
  SSH tunnel/Cloudflare Access app under a different Cloudflare account — see
  `process/README.md` / `SSC/sync.py`'s `cloudflared access ssh` usage).

The tunnel is remotely managed: its public hostname's service is set in the
Cloudflare dashboard and must be `http://api:4000` (the compose service name —
`localhost` points at the cloudflared container itself).

```bash
docker compose -f docker-compose.prod.api.yml --env-file .env up -d tunnel
docker compose -f docker-compose.prod.api.yml --env-file .env logs -f tunnel
```

It replaces the old host systemd unit `cloudflared-api-oceaneco.service`.
Once the container's connections show as healthy in the dashboard, retire it
(`sudo systemctl disable --now cloudflared-api-oceaneco`) — a second connector
with the same token joins as a replica, and the systemd one points at
`localhost:$API_PORT`, which still works, so a forgotten unit silently keeps
serving traffic.
