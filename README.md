# Helix

A self-hosted media hub. Simpler than Plex, prettier than Jellyfin. Scans your local library, enriches it from TMDB, plays directly in the browser, and tracks your watch progress — all on your own hardware, with no cloud required.

**Helix is a private media mesh for households and trusted circles — stream your own library, and securely share shelves with people you trust.**

> **Status:** pre-1.0, actively developed. Core playback, metadata enrichment, Radarr/Sonarr read-only integrations, and trusted-home catalog sharing are fully functional.

---

## Non-goals

Helix is intentionally scoped. It does not and will not:

- Provide public server discovery or a global federation network
- Have a social feed, activity streams, or public profiles
- Require a cloud account or phone-home
- Replace Radarr/Sonarr — integrations are strictly read-only (no download management)
- Provide hub-proxy or NAT traversal for remote playback — your browser connects directly to the source home

---

## Features

- **Direct play** — streams any video your browser supports straight from the file; no transcoding server required
- **File scanner** — walks library directories, parses titles/years from filenames, detects local artwork
- **TMDB enrichment** — movie and TV show metadata, posters, and backdrops via The Movie Database (optional, graceful if not configured)
- **TV hierarchy** — full Show → Season → Episode model with season tabs, episode rows, and continue-watching
- **Watch progress** — position and completion tracked per user per item; "Continue Watching" row on the dashboard
- **Up-next auto-advance** — 10-second countdown after an episode ends, navigates automatically to the next
- **Multi-user auth** — bcrypt passwords, HTTP-only session cookies, admin and user roles
- **Per-library access control** — admins grant view and/or play permissions per user per library; normal users only see the libraries they have been granted access to
- **Signed streaming URLs** — media stream and artwork URLs are HMAC-signed per user with a configurable TTL; tokens are validated on every request so shared URLs cannot be used by another account
- **Radarr / Sonarr integration** — read-only: surfaces monitored status and quality profile on media detail pages
- **Webhook auto-sync** — Radarr/Sonarr push events (MovieAdded, Download, Rename, etc.) trigger instant catalog sync; Helix never sends write commands
- **Background enrichment queue** — new items from library scans and Arr syncs are automatically queued for TMDB enrichment; visible in the admin UI with retry logic and failure reporting
- **API key encryption** — AES-256-GCM at rest; the browser never receives a plaintext key
- **Trusted Homes** — register other Helix homes, sync their read-only shared libraries, and browse remote items alongside your own; direct playback streams from the source home to your browser without passing through a hub; shared libraries are read-only with no write access between homes

---

## Screenshots

> _Screenshots coming soon — run locally and explore at `http://localhost:5173`._

---

## Quick start

### Prerequisites

- **Node.js 20+**
- **pnpm 9+** — install with `npm i -g pnpm`

### Install and run (development)

```bash
git clone https://github.com/YOUR_USERNAME/helix.git
cd helix
pnpm install
pnpm dev
```

- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173` (Vite proxy forwards `/api` to the backend)

### First-run setup

1. Open `http://localhost:5173` in your browser.
2. The setup wizard appears automatically on first launch — create your admin account.
3. Add a media library: click **Libraries → Add Library**, enter a name and an absolute path to your files (e.g. `/media/movies`), choose the type, and click **Add**.
4. Click **Scan Library** — Helix walks the directory, parses filenames, and builds the catalog.
5. Optional: configure TMDB (see below) and click **Settings → Metadata → Enrich** to pull posters and overviews.

### Production build

```bash
pnpm build          # compiles shared → backend → frontend
pnpm start          # runs the compiled backend on :3001
```

Serve `packages/frontend/dist/` as static files behind a reverse proxy (nginx, Caddy) pointing `/api` at the backend port.

---

## Configuration

Copy `.env.example` to `packages/backend/.env` and fill in the values you need. Everything has a sensible default — TMDB and the encryption key are the only variables you are likely to set.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend listen port |
| `HOST` | `0.0.0.0` | Backend bind address |
| `NODE_ENV` | `development` | Set to `production` for prod |
| `DB_PATH` | `./data/helix.db` | SQLite database path (relative to `packages/backend/`) |
| `DATA_DIR` | `./data` | Root data directory |
| `TMDB_READ_ACCESS_TOKEN` | — | TMDB API Read Access Token v4 (preferred) |
| `TMDB_API_KEY` | — | TMDB API Key v3 (fallback if no read token) |
| `METADATA_CACHE_DIR` | `./data/metadata_cache` | Artwork download cache directory |
| `METADATA_ENRICHMENT_ENABLED` | `true` | Set to `false` to disable TMDB enrichment |
| `HELIX_ENCRYPTION_KEY` | — | Master key for AES-256-GCM encryption of stored API keys. Auto-generated and saved to `data/.helix_key` if unset. |
| `ENRICHMENT_JOB_STALE_AFTER_MS` | `600000` (10 min) | Jobs stuck in `running` state longer than this are reset to `pending` on startup. |
| `ENRICHMENT_PERIODIC_ENABLED` | `true` | Periodically re-enqueue unenriched items in the background. |
| `ENRICHMENT_PERIODIC_INTERVAL_MS` | `21600000` (6 h) | How often the periodic enqueue runs. |
| `MEDIA_TOKEN_SECRET` | (random per-process) | HMAC-SHA256 secret for signed stream and artwork tokens. Set a stable value in production so tokens survive server restarts. |
| `MEDIA_TOKEN_TTL_SECONDS` | `14400` (4 h) | Lifetime of signed media stream and artwork tokens. |

---

## TMDB setup (optional)

TMDB enrichment is disabled gracefully when no credentials are provided — the app works without it.

1. Create a free account at [themoviedb.org](https://www.themoviedb.org).
2. Go to **Settings → API**.
3. Copy the **API Read Access Token** (preferred — Bearer auth) or the **API Key v3**.
4. Add to `packages/backend/.env`:

```bash
# Preferred
TMDB_READ_ACCESS_TOKEN=eyJhbGciO...

# Alternative
TMDB_API_KEY=your_key_here
```

---

## Radarr / Sonarr integration (optional)

Helix is the player, not an Arr console. The integration is **strictly read-only**: no queue management, no search, no grabs — only surfacing monitored status and quality profile alongside your catalog.

### Setup

1. Open Radarr → **Settings → General → Security** and copy the API Key.
2. In Helix: **Settings → Integrations → Add Integration**.
3. Choose **Radarr**, enter the base URL (e.g. `http://localhost:7878`) and paste the API key.
4. Click **Test** to verify the connection, then **Sync** to map your catalog.
5. Repeat for **Sonarr** (default port `8989`).

### What you see

On movie and show detail pages, a subtle badge shows:
- **Managed by Radarr/Sonarr**
- Monitored status (green = monitored)
- Quality profile name

### Webhook auto-sync

Instead of periodic polling, you can configure Radarr/Sonarr to push events to Helix so the catalog syncs instantly when something changes.

**Setup (Radarr example — Sonarr is identical):**

1. In Helix → **Integrations**, find your Radarr entry and click **Generate secret**.
2. Copy the webhook URL shown — it looks like:
   ```
   http://your-helix-host:3001/api/v1/webhooks/{integrationId}/{token}
   ```
3. In Radarr → **Settings → Connect → + → Webhook**:
   - Notification triggers: enable all (or at minimum: _On Download_, _On Movie Added_, _On Movie Delete_, _On Rename_)
   - URL: paste the Helix webhook URL
   - Method: **POST**
   - Click **Test** (Radarr sends a Test event; Helix responds 204 and records it)
   - Click **Save**

The token is shown **exactly once**. If you lose it, click **Regenerate secret** to issue a new one (the old URL stops working immediately).

**Supported Radarr events:** `MovieAdded`, `MovieDelete`, `Download`, `Rename`, `Test`

**Supported Sonarr events:** `SeriesAdd`, `SeriesDelete`, `EpisodeFileDelete`, `Download`, `Rename`, `Test`

**Read-only guarantee:** Helix never sends add, search, grab, or download commands to Radarr or Sonarr. Webhooks only trigger Helix to fetch the current catalog state.

**Debounce:** if multiple webhook events arrive while a sync is already running, Helix queues one additional sync to run after the current one finishes — no duplicate syncs pile up.

**Troubleshooting:**
- `401` — token is wrong or the URL was regenerated; re-copy the webhook URL from Helix.
- `403 Webhook not enabled` — toggle **Enable webhook** back on in the integration card.
- `403 Integration is disabled` — re-enable the integration.
- The **Last webhook** timestamp and event type are displayed in the integration card.

### Security

API keys are encrypted at rest with AES-256-GCM. The browser only ever sees a masked key (`ab••••••yz`). Webhook tokens are SHA-256 hashed before storage and never retrievable after creation. See [SECURITY.md](SECURITY.md) for details.

---

## Trusted Homes (multi-node)

Trusted Homes let two Helix instances share catalog data so you can browse another home's shared library alongside your own. Remote items appear in search and browse views with posters and backdrops proxied transparently through the local hub. Direct playback streams the file from the source home to your browser without passing through the hub — the browser must be able to reach the source home directly.

### Security model

- **Federation token** — a random 64-hex-char token generated by the node being shared. It is hashed (SHA-256) before storage; the raw token is shown exactly once and never stored.
- **Remote token** — when you add a remote node to your instance you paste its token. Helix encrypts it at rest with AES-256-GCM using the same key as integration API keys. The plaintext is only decrypted in-process during health checks and catalog syncs.
- Remote nodes have no write access — the federation API is read-only (health check + catalog export).
- Session cookies are not accepted on the federation endpoints; only the federation Bearer token works.

### Setup

**On the home you want to share (the "source home"):**

1. Go to **Admin → Trusted Homes**.
2. Under **This Home**, click **Generate Token**.
3. Copy the token — it is shown only once.

**On the home doing the browsing (the "browsing home"):**

1. Go to **Admin → Trusted Homes → Add Trusted Home**.
2. Enter the home's name, its server address (e.g. `http://helix-living-room:3001`), and paste the sharing token.
3. Click **Add Trusted Home**, then **Test** to verify connectivity.
4. Click **Sync** to import the shared catalog. Items from the trusted home appear in your libraries.

### Capability advertisement

Each node advertises what it supports via `GET /api/v1/federation/capabilities`. The consumer hub fetches and caches this during every **Test** and **Sync** operation, storing it in `capabilities_json` on the node row. The current capability set:

| Field | Value | Meaning |
|-------|-------|---------|
| `supportsCatalogSync` | `true` | Catalog export endpoint is available |
| `supportsArtworkProxy` | `true` | Artwork streaming endpoint is available |
| `supportsRemotePlayback` | `true` | Cross-node playback via signed direct URLs |
| `supportedPlaybackModes` | `["direct"]` | Browser streams directly from the remote node |
| `supportsSignedPlaybackUrls` | `true` | Remote node generates HMAC-signed per-file tokens |
| `directPlaybackUrlTtlSeconds` | `14400` | Signed URL lifetime (controlled by `MEDIA_TOKEN_TTL_SECONDS`) |
| `federationProtocolVersion` | `"1"` | Protocol version for backward compatibility checks |

The playback-source endpoint (`GET /api/v1/media/:id/playback-source`) reads the cached capabilities and returns one of four codes:

| Code | Meaning |
|------|---------|
| `local_playable` | File is local; signed stream URL included |
| `remote_direct` | File is on a remote node; short-lived direct stream URL returned |
| `remote_available` | Remote node claims playback support but intent fetch failed |
| `remote_playback_unsupported` | File is on a remote node that does not support playback |
| `unavailable` | No source found on any node |

For `remote_direct`, the response shape is `{ source: { code, sourceType, nodeId, nodeName, streamUrl, expiresAt, mediaFileId, contentType, container } }`. The `streamUrl` is an absolute URL pointing directly to the remote node's stream endpoint — the browser fetches it without going through the hub.

For `remote_playback_unsupported`, the response includes `nodeName`, `nodeId`, and `nodeKind` so the UI can show "Available on Living Room — remote playback is not supported by this node."

### Federated direct playback

When a remote node supports playback (i.e. `supportsRemotePlayback: true`, `supportsSignedPlaybackUrls: true`), the hub's `GET /api/v1/media/:id/playback-source` endpoint will:

1. Decrypt the stored federation token server-side (never sent to the browser).
2. POST to the remote node's `/api/v1/federation/playback-intent` with the media item ID.
3. The remote node verifies it owns the file, generates a short-lived HMAC-signed stream URL, and returns it.
4. The hub forwards the `{ sourceType: "remote_direct", streamUrl, expiresAt, ... }` shape to the browser.
5. The browser's `<video>` element streams directly from the remote node using the signed URL.

**Remote node reachability:** The browser must be able to reach the remote node directly (same LAN or routed network). No NAT traversal or hub-proxy is provided. If the remote node is behind a NAT, direct playback will fail — the hub will fall back to an unavailable response.

**Browser and direct-play assumptions:**
- The signed stream URL is an HTTP byte-range endpoint — all modern browsers support it natively via `<video src=...>`.
- CORS is not required because `<video src=...>` is not a CORS-restricted fetch; the browser requests video bytes directly.
- Only browser-native codecs are playable (H.264/AAC in MP4/MKV, WebM/VP9, etc.). No transcoding is performed.

**Security model:**
- The federation token is decrypted in-process on the hub; it never reaches the browser.
- The remote node generates a short-lived HMAC-signed token bound to the specific file ID and a synthetic caller identity. The token cannot be used for any other file.
- The signed URL TTL is controlled by `MEDIA_TOKEN_TTL_SECONDS` on the remote node (default 4 h).
- No filesystem paths are exposed in any response.

**Watch-state:** Progress is tracked on the hub only. The hub's `PUT /api/v1/watchstate/:mediaItemId` is called as the video plays. Watch state is never synced back to the remote node. "Continue Watching" reflects remote playback position.

### What is deferred

- **Hub video proxy** — the browser streams directly from the remote node. No hub-side buffering or re-streaming.
- **Remote transcoding** — no server-side codec conversion; only formats the browser natively supports play.
- **NAT traversal** — direct playback requires the browser to reach the remote node. Nodes behind NAT that cannot be reached directly will show an unavailable message.
- **Cross-node watch-state sync** — watch progress is hub-local only.
- **Shared authentication** — users are local to each node; no SSO or shared user database.
- **Incremental sync** — the `?since=<unix_ms>` parameter is supported by the catalog endpoint but the UI sync button always does a full import (idempotent via upsert).

---

## Development

```bash
pnpm install          # install all workspace dependencies
pnpm dev              # start backend + frontend with hot reload
pnpm build            # production build (all packages)
pnpm start            # run built backend
```

### Testing

```bash
cd packages/backend
pnpm test             # run all Vitest tests
pnpm test -- --run tests/auth.test.ts   # run a single test file
```

### Type checking

```bash
pnpm -r run check     # type-check all packages
```

### Project layout

```
helix/
├── packages/
│   ├── backend/          # Fastify API server
│   │   ├── drizzle/      # SQL migrations (9 files)
│   │   ├── src/
│   │   │   ├── routes/   # HTTP route handlers
│   │   │   ├── services/ # Business logic (scanner, metadata, auth, integrations)
│   │   │   └── db/       # Drizzle schema + client
│   │   └── tests/        # Vitest integration tests
│   ├── frontend/         # React + Vite SPA
│   │   └── src/
│   │       ├── api/      # Typed fetch wrappers
│   │       ├── components/
│   │       └── pages/
│   └── shared/           # TypeScript types shared by backend and frontend
├── .env.example
├── LICENSE
└── SECURITY.md
```

---

## Architecture

```
Browser (React + Vite :5173)
  └── /api/* ──────────────────────► Fastify backend (:3001)
                                         │
                             ┌───────────┼───────────┐
                         Scanner      Metadata     Auth
                         (fs walk)    (TMDB)       (bcrypt + sessions)
                             │
                         SQLite via Drizzle ORM
                         (9 migrations, 11 tables)
```

The DB schema is federation-aware: every `media_file` carries a `node_id`. Remote files are stored with sentinel paths (`remote://<nodeId>/<fileId>`) — no real filesystem paths are ever recorded for remote content. Libraries and catalog items imported from a remote node cascade-delete when that node is removed.

---

## API reference

### Core

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Server status and version |
| GET | `/api/v1/auth/status` | Setup required? Authenticated? |
| POST | `/api/v1/auth/setup` | Create first admin account |
| POST | `/api/v1/auth/login` | Authenticate |
| POST | `/api/v1/auth/logout` | Invalidate session |
| GET | `/api/v1/auth/me` | Current user |

### Libraries and media

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/libraries` | List / create libraries (list filtered by user permissions) |
| GET/PUT/DELETE | `/api/v1/libraries/:id` | Get / update / delete |
| POST | `/api/v1/libraries/:id/scan` | Trigger scan |
| GET | `/api/v1/libraries/:id/permissions` | List user access grants for a library (admin only) |
| PUT | `/api/v1/libraries/:id/permissions/:userId` | Grant or update access for a user (admin only) |
| DELETE | `/api/v1/libraries/:id/permissions/:userId` | Revoke access for a user (admin only) |
| GET | `/api/v1/media` | List items (`kind?`, `q?`, `limit?`, `offset?`) — filtered by user permissions |
| GET | `/api/v1/media/:id` | Item detail with versions and files |
| GET | `/api/v1/media/:id/playback-source` | Best playback source (returns signed stream URL) |
| GET | `/api/v1/media/:id/artwork/poster` | Stream poster image (signed URL or session auth) |
| GET | `/api/v1/media/:id/artwork/backdrop` | Stream backdrop image (signed URL or session auth) |
| GET | `/api/v1/media-files/:fileId/stream` | Range-request video stream (signed URL or session + can_play) |

### TV

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/shows` | List shows |
| GET | `/api/v1/shows/:id` | Show detail with seasons |
| GET | `/api/v1/seasons/:id/episodes` | Episodes for a season |
| GET | `/api/v1/episodes/:id` | Episode detail |
| GET | `/api/v1/episodes/:id/next` | Next episode (for auto-advance) |

### Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/metadata/providers` | List providers and config status |
| POST | `/api/v1/metadata/enrich` | Bulk-enrich up to 20 unmatched items |
| POST | `/api/v1/media/:id/metadata/refresh` | Force re-enrich a single item |
| GET | `/api/v1/media/:id/metadata/search` | Search providers (no commit) |
| POST | `/api/v1/media/:id/metadata/match` | Commit a specific candidate |

### Integrations (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/v1/integrations` | List / create |
| GET/PATCH/DELETE | `/api/v1/integrations/:id` | Get / update / delete |
| POST | `/api/v1/integrations/:id/test` | Test connection |
| POST | `/api/v1/integrations/:id/sync` | Run sync |
| POST | `/api/v1/integrations/:id/webhook-secret` | Generate (or regenerate) webhook secret — returns token once |

### Trusted Homes / federation (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/nodes` | List all nodes (local + remote) |
| POST | `/api/v1/nodes` | Add a remote node (`name`, `base_url`, `api_token`) |
| GET | `/api/v1/nodes/:id` | Node detail |
| PATCH | `/api/v1/nodes/:id` | Update name, base_url, or api_token |
| DELETE | `/api/v1/nodes/:id` | Remove remote node (cascades to imported catalog) |
| POST | `/api/v1/nodes/:id/test` | Test connection health |
| POST | `/api/v1/nodes/:id/sync` | Sync remote catalog |
| GET | `/api/v1/federation/token` | Check if federation token is set |
| POST | `/api/v1/federation/token` | Generate (or regenerate) federation token — returns raw token once |
| DELETE | `/api/v1/federation/token` | Revoke federation token |

### Remote artwork proxy (session auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/nodes/:nodeId/media/:mediaId/artwork/:kind` | Proxy poster or backdrop from a remote node; requires session auth and view permission on the item's library. The remote federation token is used server-side and never sent to the browser. |

### Federation API (federation token auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/federation/health` | Health check (used by remote nodes to test connectivity) |
| GET | `/api/v1/federation/capabilities` | Advertise what this node supports (catalog sync, artwork, playback) |
| GET | `/api/v1/federation/catalog` | Export full catalog (`?since=<unix_ms>` for incremental) |
| GET | `/api/v1/federation/media/:id/artwork/:kind` | Stream a local artwork file to a remote hub; accepts only items owned by this node |
| POST | `/api/v1/federation/playback-intent` | Playback intent: verifies item ownership, generates signed stream URL; returns `{ status, mode, streamUrl, expiresAt, mediaFileId, contentType, container }` or `{ status: "unavailable" \| "unsupported" }` |

### Enrichment queue (admin only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/enrichment-queue/stats` | Counts by status + recent failures + startup recovery count |
| POST | `/api/v1/enrichment-queue/clear` | Remove all done/failed jobs |
| POST | `/api/v1/enrichment-queue/enqueue` | Enqueue all unenriched items across all libraries |
| POST | `/api/v1/enrichment-queue/retry-failed` | Reset all failed jobs to pending for retry |

### Webhooks (public, token-authenticated)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/webhooks/:integrationId/:token` | Radarr/Sonarr push endpoint; triggers read-only sync |

### Watch state

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/api/v1/watchstate/:mediaItemId` | Upsert position and completion |
| GET | `/api/v1/watchstate/continue-watching` | In-progress items for current user |

---

## Known limitations

- **No transcoding** — only formats the browser natively supports play. H.264/AAC in MP4 or MKV works in most browsers; H.265 and AV1 depend on browser support.
- **No HTTPS built in** — designed for LAN deployment. Put it behind nginx or Caddy for external access.
- **No mobile or TV apps** — the React frontend is responsive but there are no native apps.
- **No bulk manual enrichment shortcut** — TMDB enrichment runs automatically in the background queue; use `POST /api/v1/enrichment-queue/enqueue` or the admin UI to trigger a manual pass.
- **No TVDB** — TV metadata is TMDB-only; `external_tvdb_id` is reserved in the schema for a future provider.
- **No music enrichment** — MusicBrainz is not yet integrated.
- **No episode still caching** — episode thumbnails are resolved from TMDB but not downloaded to disk.
- **Remote playback requires direct browser reachability** — the browser streams directly from the remote node; nodes behind NAT that cannot be reached by the client browser will show an unavailable message rather than playing. No hub proxy or NAT traversal is provided.
- **No remote transcoding** — remote playback only supports direct stream (no codec conversion); only browser-native formats play.
- **Permissions are library-level only** — no per-item or per-collection access control; no parental controls or age-based content filtering.
- **Signed tokens are not revocable** — tokens are stateless JWS-like tokens; invalidating a user's access requires revoking the library permission and waiting for existing tokens to expire (default 4 h). Set `MEDIA_TOKEN_TTL_SECONDS` to a shorter value if tighter revocation is needed.
- **No OAuth or SSO** — authentication is local username/password only.

---

## Roadmap

- [x] Background metadata enrichment (event-driven queue after scan and Arr sync)
- [x] Webhook-driven auto-sync from Arr events
- [x] Per-library access permissions with signed stream and artwork URLs
- [x] Trusted Homes foundation — home registration, sharing token auth, catalog sync, remote items in UI
- [x] Remote artwork proxy — poster and backdrop images from trusted homes proxied through the local hub; sharing token never reaches the browser
- [x] Trusted Home capability contract — capability advertisement endpoint, hub-side capability caching, structured playback-source codes, playback-intent placeholder
- [x] Direct playback signing — source home generates HMAC-signed stream URLs; browser streams directly without hub proxy; sharing token never exposed
- [ ] Episode still image download and caching
- [ ] MusicBrainz provider for music libraries
- [ ] TVDB provider for alternate TV metadata
- [ ] Subtitle support (OpenSubtitles / local .srt/.ass)
- [ ] Multi-node federation (catalog sync, remote playback signing)
- [ ] User request management (non-admin users request missing content)
- [ ] Lidarr integration for music
- [ ] Parental controls / per-profile content rating filters

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including the
contribution license agreement required for dual-licensing compatibility.

---

## License

Helix is dual-licensed.

**Community license — AGPL-3.0-or-later**

Community use is available under the [GNU Affero General Public License v3.0 or
later](LICENSE). If your use case is compatible with the AGPL — including the
requirement to make source code available when you run a modified version as a
network service — no additional agreement is needed.

**Commercial license**

A separate commercial license is available for use cases that require terms
outside the AGPL: closed-source distribution, proprietary embedding, or hosted
commercial offerings without AGPL source-availability obligations. Commercial
rights are only granted through a signed written agreement with the copyright
holder. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for contact
information.

**Prior MIT releases**

Versions of Helix published at or before commit `b7a56a19` ("Prepare repository
for publication") were released under the MIT License. Those releases remain
available under MIT. The dual-license model applies from the transition commit
forward.

*This is not legal advice. Consult a qualified attorney to determine which
license applies to your situation.*
