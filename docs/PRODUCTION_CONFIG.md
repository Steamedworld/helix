# Production Configuration

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` for production deployments |
| `DB_PATH` | Recommended | Path to the SQLite database file (default: `./data/helix.db`) |
| `DATA_DIR` | Recommended | Path to the data directory (default: `./data`) |
| `BASE_URL` | Recommended | Public-facing base URL (e.g. `https://media.example.com`) — required for Trusted Home direct playback |

## Recommended secrets

Set these before first run. Helix will refuse to start in production if signing secrets are absent.

| Variable | Required in production | Description |
|---|---|---|
| `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` | **Yes** | HMAC-SHA256 key for signing playback refresh tokens. Generate: `openssl rand -hex 32` |
| `MEDIA_TOKEN_SECRET` | Yes | HMAC-SHA256 key for signing media stream tokens. If `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` is not set, this is used as a derivation base. |

**Never** use `dev_random` mode in production — refresh tokens will not survive server restarts, breaking active playback sessions.

## Optional tuning

| Variable | Default | Description |
|---|---|---|
| `TRUSTED_HOME_PLAYBACK_PROXY_ENABLED` | `true` | Enable/disable the proxy playback feature |
| `TRUSTED_HOME_PROXY_REQUEST_TIMEOUT_MS` | `30000` | Upstream request timeout for proxy streams (ms) |
| `TRUSTED_HOME_PLAYBACK_REFRESH_TOKEN_TTL_MS` | `180000` | Lifetime of each playback refresh token (ms, default 3 min) |
| `MEDIA_TOKEN_TTL_SECONDS` | `14400` | Lifetime of direct stream tokens (seconds, default 4 h) |
| `TRUSTED_HOME_SYNC_ENABLED` | `true` | Enable background catalog sync |
| `TRUSTED_HOME_SYNC_INTERVAL_MS` | `21600000` | Background sync interval (ms, default 6 h) |
| `TOMBSTONE_RETENTION_DAYS` | `90` | How long to retain deletion records for incremental sync safety |
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |

## Production checklist

- [ ] `NODE_ENV=production` set
- [ ] `MEDIA_TOKEN_SECRET` set to a strong random value
- [ ] `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` set to a strong random value
- [ ] `BASE_URL` set to the public HTTPS URL (required for Trusted Home direct playback)
- [ ] SQLite `data/` directory has a persistent volume (not ephemeral container storage)
- [ ] HTTPS reverse proxy (Caddy, nginx) terminating TLS — Helix listens on HTTP internally
- [ ] Only the reverse proxy port is publicly exposed — never expose `DB_PATH`, Redis, or Meilisearch directly

## Health endpoint monitoring

`GET /api/v1/health` returns aggregate status without per-node details. Key fields:

```json
{
  "status": "ok",
  "trustedHomeSync": {
    "syncStatus": "ok | degraded | unknown",
    "failing": 0,
    "stale": 0
  }
}
```

Alert on `syncStatus === "degraded"` for sync failures.

## Admin diagnostics

`GET /api/v1/admin/sync-diagnostics` (admin auth required) returns:
- `secretsHealth` — state labels for all signing keys (never exposes values)
- `playbackDiagnostics` — proxy status, failure histogram, token health
- `trustedHomeSync` — per-home sync status and next-sync estimate

## Known unsafe defaults

| Default | Risk | Fix |
|---|---|---|
| No `MEDIA_TOKEN_SECRET` | Token signing uses a derived or random key | Set `MEDIA_TOKEN_SECRET` |
| No `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` | Refresh tokens use derived or random key | Set `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` |
| `BASE_URL` not set or loopback | Direct playback broken for remote browsers | Set `BASE_URL` to LAN/VPN/HTTPS URL |
| `TRUSTED_HOME_PLAYBACK_PROXY_ENABLED=false` | Proxy playback disabled | Only disable intentionally |
