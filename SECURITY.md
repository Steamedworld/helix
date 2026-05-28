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

**Federation tokens and invite flow**
- Each node generates an access token (random 32 bytes → 64 hex chars) on demand. The token is hashed with SHA-256 before storage; the raw token is shown exactly once and never persisted.
- When a consumer node stores a remote node's token, it is encrypted at rest with AES-256-GCM (same key as integration API keys). The plaintext is only decrypted in-process for health checks and catalog syncs.
- The federation HTTP endpoints (`/api/v1/federation/health`, `/api/v1/federation/catalog`) accept only Bearer token auth. Session cookies are explicitly rejected so admin browser sessions cannot be reused by cross-origin requests.
- Token comparison uses `timingSafeEqual` to prevent timing attacks.
- The federation catalog export strips all local filesystem paths. Remote consumers receive `has_poster`/`has_backdrop` booleans rather than `poster_path`/`backdrop_path` strings.
- Remote files are stored with sentinel paths (`remote://<nodeId>/<fileId>`) — no real filesystem paths from a remote node are ever written to the local database.
- **Invite tokens:** shown exactly once at generation time. Only the SHA-256 hash is stored in the `trusted_home_invites` table. The raw token never appears in the database, log output, or list responses. The invite string must be treated as a secret.
  - **One-time use:** enforced on the source home. The `POST /api/v1/federation/invites/verify` endpoint rejects invites with `used_at` set. On successful node creation, `POST /api/v1/federation/invites/consume` marks the invite as used. Used invites cannot be reused.
  - **Expiry:** enforced at connection time by the source home. Expired invites (`expires_at` in the past) are rejected by both verify and consume.
  - **Revocation:** admins can revoke any invite at any time. Revoked invites are permanently blocked. Invite rows are never deleted — `revoked_at` is set and the row kept for audit.
  - **Lifecycle:** `verify` is called before node creation; `consume` is called after node creation. A consume failure produces a warning but does not roll back the node — the node is still connected and functional.
  - **On compromise:** revoke the invite immediately from the invite history list on the source home. The raw token is not recoverable — issue a new invite.
- Invite list responses expose only `id`, `label`, dates, and status. The `token_hash` and raw token are never returned.
- Accepting an invite calls `verify` on the source home before creating any database entry. If the source home cannot be reached, the connection is rejected with 502. The raw token is encrypted before being written to the `nodes` table.
- Connecting via invite does not grant normal users access to any libraries. Library access must be explicitly granted by an admin in Library settings.

**No telemetry**
- Helix makes no outbound connections except to configured metadata providers (TMDB), integrations (Radarr/Sonarr), and federated Helix nodes, all at user direction. There is no analytics, crash reporting, or phoning home.
