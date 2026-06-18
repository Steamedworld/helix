# Production Configuration

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` for production deployments |
| `DB_PATH` | Recommended | Path to the SQLite database file (default: `./data/helix.db`) |
| `DATA_DIR` | Recommended | Path to the data directory (default: `./data`) |
| `BASE_URL` | Recommended | Public-facing base URL (e.g. `https://media.example.com`) — required for Trusted Home direct playback |

## Secrets

Set these before first run. Helix will refuse to start in production if a required signing secret is absent.

| Variable | Classification | Description |
|---|---|---|
| `MEDIA_TOKEN_SECRET` | **Required for production** | HMAC-SHA256 key for signing media stream tokens. Also the derivation base for the two keys below when their dedicated vars are unset. Generate: `openssl rand -hex 32` |
| `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` | **Recommended explicit secret** (required for production unless `MEDIA_TOKEN_SECRET` is set) | HMAC-SHA256 key for signing playback refresh tokens. Falls back to a domain-separated key derived from `MEDIA_TOKEN_SECRET`. |
| `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` | **Recommended explicit secret** (required for production *only if* per-user identity is enabled) | HMAC-SHA256 key for deriving opaque per-user viewer identity hashes. Falls back to a domain-separated key derived from `MEDIA_TOKEN_SECRET`. |
| `TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET` | **Optional** (rotation only) | The prior viewer identity secret, set temporarily during a key rotation so user-mode reads can still find per-user rows written under the old key. Explicit-only (no `MEDIA_TOKEN_SECRET` derivation). Remove after the rotation window. |

### Secret health classification

Each signing key resolves to one of four states, surfaced in admin diagnostics (`secretsHealth`) and as UI warnings — the state label is exposed, never the value:

| State | Meaning | Safe for production? |
|---|---|---|
| `explicit_secret` | The dedicated env var is set. | ✅ Best — explicit key isolation |
| `derived_fallback` | Derived (domain-separated) from `MEDIA_TOKEN_SECRET`. | ⚠️ Acceptable, but set the explicit var for isolation |
| `dev_random` | Development-only fallback (playback refresh = random per-process; viewer identity = deterministic dev key). | ❌ Dev only — see rotation impact below |
| `missing` | No secret available in production. | ❌ Unsafe — startup fails for required keys |

**Never** rely on `dev_random` in production. For the playback refresh key it is random per process, so refresh tokens do not survive restarts and active playback sessions break. For the viewer identity key it is a deterministic dev key shared across all dev installs — not a secret.

## Secret rotation impact

Rotating a signing secret is a deliberate operational event. Effects:

| Secret rotated | Effect |
|---|---|
| `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` | All outstanding playback refresh URLs (`?rt=`) become invalid immediately. Active players transparently request a fresh token on next refresh; worst case is a single retry. Low blast radius (TTL is ~3 min). |
| `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` | Per-user continuity resets: previously derived per-user hashes no longer match, so per-user resume points appear to disappear. Prior per-user rows remain on the **source** home as orphan opaque hashes (never reversible) and age out via normal/audit retention. Node-aggregate progress is unaffected. Use the rotation procedure below (with `TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET`) to avoid losing continuity immediately. |
| `MEDIA_TOKEN_SECRET` | Highest blast radius. Invalidates signed media stream tokens **and** any key derived from it — i.e. if either dedicated secret above is unset, rotating `MEDIA_TOKEN_SECRET` also rotates those derived keys, compounding the two effects above. Prefer setting all three explicitly so each can rotate independently. |

### Viewer identity secret rotation procedure

Rotating `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` without `TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET` immediately orphans all per-user rows on source homes. To rotate with continuity:

1. Set the **old** secret as `TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET`.
2. Set the **new** secret as `TRUSTED_HOME_VIEWER_IDENTITY_SECRET`.
3. Deploy. Pushes immediately use the new (current) secret. User-mode reads try the current key first, then fall back to the previous key on a miss — so existing resume points keep working.
4. Let users naturally resume and watch. Each new progress write creates/updates a row under the current secret. There is **no** bulk migration.
5. After a defined rotation window (long enough for active users to have written fresh progress), remove `TRUSTED_HOME_VIEWER_IDENTITY_PREVIOUS_SECRET`.

Old opaque rows written under the previous key are never reversible and simply age out via progress retention (see Phase 2 retention). Admin diagnostics show `secretsHealth.viewerIdentitySecret.previousSecretConfigured: true` and a "remove after the rotation window" recommendation while a previous secret is configured.

## Optional tuning

| Variable | Default | Description |
|---|---|---|
| `TRUSTED_HOME_PLAYBACK_PROXY_ENABLED` | `true` | Enable/disable the proxy playback feature |
| `TRUSTED_HOME_PROXY_REQUEST_TIMEOUT_MS` | `30000` | Upstream request timeout for proxy streams (ms) |
| `TRUSTED_HOME_PLAYBACK_REFRESH_TOKEN_TTL_MS` | `180000` | Lifetime of each playback refresh token (ms, default 3 min) |
| `MEDIA_TOKEN_TTL_SECONDS` | `14400` | Lifetime of direct stream tokens (seconds, default 4 h) |
| `TRUSTED_HOME_SYNC_ENABLED` | `true` | Enable background catalog sync |
| `TRUSTED_HOME_SYNC_INTERVAL_MS` | `21600000` | Background sync interval (ms, default 6 h) |
| `TRUSTED_HOME_SYNC_ON_STARTUP` | `false` | Run a catalog sync immediately on startup (in addition to the interval) |
| `TRUSTED_HOME_SYNC_STAGGER_MS` | `30000` | Delay between per-home syncs to avoid thundering-herd on startup |
| `PROGRESS_OUTBOX_WORKER_INTERVAL_MS` | `30000` | Progress push outbox worker poll interval (ms) |
| `PROGRESS_OUTBOX_MAX_ATTEMPTS` | `3` | Max delivery attempts before a progress push job is abandoned (clamped to ≥ 1) |
| `TRUSTED_HOME_AUDIT_RETENTION_DAYS` | `90` | How long to retain Trusted Home audit events before pruning (clamped 1–3650; invalid values fall back to 90) |
| `TRUSTED_HOME_PROGRESS_OUTBOX_RETENTION_DAYS` | `30` | How long to retain **terminal** progress outbox rows (synced/abandoned) before pruning (clamped 1–3650). Pending/in-progress/retrying jobs are never pruned. |
| `TRUSTED_HOME_REMOTE_PROGRESS_RETENTION_DAYS` | `365` | How long to retain remote watch progress rows (by `updated_at`) before pruning (clamped 1–3650) |
| `TOMBSTONE_RETENTION_DAYS` | `90` | How long to retain deletion records for incremental sync safety |
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |

## Production checklist

- [ ] `NODE_ENV=production` set
- [ ] `MEDIA_TOKEN_SECRET` set to a strong random value
- [ ] `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` set to a strong random value (explicit isolation)
- [ ] `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` set if per-user identity will be enabled on any connection
- [ ] `BASE_URL` set to the public HTTPS URL (required for Trusted Home direct playback)
- [ ] Admin diagnostics show every `secretsHealth` entry as `explicit_secret` (or knowingly `derived_fallback`)
- [ ] `TRUSTED_HOME_AUDIT_RETENTION_DAYS` reviewed for your retention policy (default 90)
- [ ] SQLite `data/` directory has a persistent volume (not ephemeral container storage)
- [ ] Pre-upgrade database backup taken (see `docs/TRUSTED_HOME.md` → Backup and restore)
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
- `secretsHealth` — state labels for all signing keys, including `playbackRefreshToken`, `mediaToken`, and `viewerIdentitySecret` (never exposes values)
- `playbackDiagnostics` — proxy status, failure histogram (by code, no node IDs), token health, `homesWithPerUserProgressIdentityAllowed` count
- `auditSummary` — last-24h audit event counts, retention days, prune cutoff, count past cutoff, and last prune status (aggregate only — no payloads, hashes, or IDs)
- `progressRetention` — outbox/remote-progress retention days, prune cutoffs, and last progress-prune status/count (aggregate only — no payloads, hashes, media titles, or IDs)
- `trustedHomeSync` — per-home sync status and next-sync estimate

All diagnostic fields are aggregate or state-label only. They never contain raw URLs, tokens, viewer identity hashes, filesystem paths, request headers, raw upstream errors, stack traces, user IDs, usernames, or emails. `node_id` appears only as an opaque UUID reference.

## Known unsafe defaults

| Default | Risk | Fix |
|---|---|---|
| No `MEDIA_TOKEN_SECRET` | Token signing uses a derived or random key | Set `MEDIA_TOKEN_SECRET` |
| No `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` | Refresh tokens use derived or random key | Set `TRUSTED_HOME_PLAYBACK_REFRESH_SECRET` |
| No `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` with per-user identity enabled | Identity key falls back to derived/dev key; rotation/restart can reset per-user resume | Set `TRUSTED_HOME_VIEWER_IDENTITY_SECRET` |
| `BASE_URL` not set or loopback | Direct playback broken for remote browsers | Set `BASE_URL` to LAN/VPN/HTTPS URL |
| `TRUSTED_HOME_PLAYBACK_PROXY_ENABLED=false` | Proxy playback disabled | Only disable intentionally |

## Linting

`pnpm lint` runs ESLint 9 (flat config in `eslint.config.mjs`) over `packages/*/src`. The first-pass ruleset is intentionally modest — a bug-catching baseline (`@eslint/js` recommended plus `no-constant-condition`) with TypeScript parsing, and React-hooks rules for the frontend. Type-level concerns (unused vars, undefined symbols) are owned by `pnpm typecheck`, not the linter, to avoid duplicate churn.

Lint passes (exit 0) with a small number of **known warnings** that are intentionally not yet promoted to errors to avoid unrelated product churn in this pass:

- `react-hooks/rules-of-hooks` — a conditional `useEffect` in `Integrations.tsx` (admin-gate early return before the hook).
- `react-hooks/exhaustive-deps` — a missing-dependency array in `LibraryDetail.tsx`.

A follow-up "lint hardening" task can fix those findings and promote `react-hooks/rules-of-hooks` to `error`. `pnpm typecheck`, `pnpm test`, and `pnpm build` remain the primary correctness gates.
