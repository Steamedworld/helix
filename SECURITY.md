# Security Policy

## Supported versions

Helix is pre-1.0. Security fixes are applied to the `master` branch only; no backport releases are made.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email a description of the issue to the maintainer. Include:

- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- The potential impact
- Any suggested remediation

You should receive an acknowledgement within 72 hours and a resolution timeline within 7 days.

## Security design notes

**Authentication**
- Passwords are hashed with bcrypt (cost factor 12) — plaintext passwords are never stored or logged.
- Sessions use HTTP-only, `SameSite=Lax` cookies. Session tokens are stored in the database as SHA-256 hashes — the raw token is never persisted.
- Sessions expire after 30 days.

**API key encryption**
- Radarr/Sonarr API keys are encrypted at rest with AES-256-GCM before writing to the database.
- The encryption key is derived from `HELIX_ENCRYPTION_KEY` (if set) or from a random 32-byte key stored in `data/.helix_key`.
- The decrypted key is never returned to the browser — only a masked form (`ab••••••yz`).

**Path traversal**
- Artwork served from `GET /api/v1/media/:id/artwork/*` is validated against known library roots before streaming. Paths outside all registered library directories are rejected with 403.
- Metadata artwork downloads are validated against the cache root before write.

**Local-network scope**
- Helix is designed for trusted local-network deployment. There is no built-in HTTPS, reverse-proxy, or remote-access hardening. Do not expose port 3001 to the public internet without a hardening layer (nginx/Caddy with TLS).

**Federation tokens**
- Each node generates a federation token (random 32 bytes → 64 hex chars) on demand. The token is hashed with SHA-256 before storage; the raw token is shown exactly once and never persisted.
- When a consumer node stores a remote node's token, it is encrypted at rest with AES-256-GCM (same key as integration API keys). The plaintext is only decrypted in-process for health checks and catalog syncs.
- The federation HTTP endpoints (`/api/v1/federation/health`, `/api/v1/federation/catalog`) accept only Bearer token auth. Session cookies are explicitly rejected so admin browser sessions cannot be reused by cross-origin requests.
- Token comparison uses `timingSafeEqual` to prevent timing attacks.
- The federation catalog export strips all local filesystem paths. Remote consumers receive `has_poster`/`has_backdrop` booleans rather than `poster_path`/`backdrop_path` strings.
- Remote files are stored with sentinel paths (`remote://<nodeId>/<fileId>`) — no real filesystem paths from a remote node are ever written to the local database.

**No telemetry**
- Helix makes no outbound connections except to configured metadata providers (TMDB), integrations (Radarr/Sonarr), and federated Helix nodes, all at user direction. There is no analytics, crash reporting, or phoning home.
