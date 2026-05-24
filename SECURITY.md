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

**No telemetry**
- Helix makes no outbound connections except to configured metadata providers (TMDB) and integrations (Radarr/Sonarr) at user direction. There is no analytics, crash reporting, or phoning home.
