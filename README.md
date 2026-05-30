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
| `TRUSTED_HOME_SYNC_ENABLED` | `true` | Enable background auto-sync for Trusted Homes. |
| `TRUSTED_HOME_SYNC_INTERVAL_MS` | `21600000` (6 h) | How often to sync all remote Trusted Home catalogs. |
| `TRUSTED_HOME_SYNC_STAGGER_MS` | `30000` (30 s) | Delay between each node's background sync start (avoids thundering herd). |
| `TRUSTED_HOME_SYNC_ON_STARTUP` | `false` | If true, syncs all remote nodes immediately on server startup. |

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

- **Invite string** — bundles the server address, a one-time access token, and metadata into a base64url-encoded JSON blob. The raw token is included exactly once (at generation time) and never stored on the generating home — only the SHA-256 hash is kept. Treat the invite string as a secret and exchange it over a private channel.
- **Access token** — a cryptographically random 32-byte (64-hex-char) token. On the source home the raw token is never stored — only its SHA-256 hash. On the connecting home the raw token is encrypted at rest with AES-256-GCM (same key as integration API keys) and only decrypted in-process during health checks and catalog syncs. The plaintext never reaches the browser.
- **Invite expiry** — invites can be created with a 7 / 30 / 90-day expiry or no expiry. Revoke a compromised invite immediately from the invite history list on the source home.
- **No public sharing** — there is no public discovery, central relay, or cloud account. Connections are point-to-point between two homes on a private or routed network.
- Remote nodes have no write access — the federation API is read-only (health check + catalog export).
- Session cookies are not accepted on the federation endpoints; only the federation Bearer token works.
- Connecting via invite does NOT automatically grant normal users access. Library access must be explicitly granted per user in Library settings.

### Invite flow (recommended)

The invite flow is the standard way to connect two Helix homes. It bundles the server address and access token into a single string that the other admin pastes on their end.

**On the home you want others to access (the "source home"):**

1. Go to **Admin → Trusted Homes → This Home**.
2. Click **Create invite**.
3. Set an optional label (e.g. "For living-room Helix") and expiry (7 / 30 / 90 days or no expiry).
4. Click **Generate invite** — a compact invite string is displayed.
5. Copy it and send it to the other home's admin over a private channel (message, email, etc.). **Treat it like a password — do not post it publicly. Revoke immediately if exposed.**

**On the home that will connect (the "connecting home"):**

1. Go to **Admin → Trusted Homes → Connect using invite**.
2. Click **Paste invite and connect**.
3. Paste the invite string — a preview shows the home name, server address, and expiry.
4. Optionally check **Sync catalog after connecting** (default: on) to import the remote catalog immediately.
5. Click **Connect**. Helix verifies the invite with the source home, confirms it has not expired, been revoked, or already been used, then creates the connection.
6. After connecting, go to **Library settings** to choose which libraries users can access from this home.

**Invite lifecycle enforcement:**

- **Expiry:** expired invites are rejected by the source home before a node is created on the connecting side. Expiry is enforced at connection time, not just locally.
- **One-time use:** each invite can only be accepted once. After a successful connection, the source home marks the invite as Used — further attempts with the same invite string will be rejected.
- **Revocation:** admins can revoke any unused invite at any time from the invite history list. Revoked invites cannot be used.
- **Audit trail:** used invites remain in the invite history with Used status, recording which home used them.
- **On compromise:** revoke the invite immediately from the invite history list, then re-issue a new invite.

**Sync on connect:**

Checking "Sync catalog after connecting" (default: on) fetches the remote catalog immediately after the node is created. If sync fails, a warning is shown but the node remains connected — use the Sync button in the Trusted Homes panel to retry.

**After connecting:**

Connecting via invite does not automatically grant normal users access to any libraries. An admin must explicitly grant per-user access. See the Post-connection workflow section below.

### Post-connection workflow

After connecting a Trusted Home, remote libraries appear in the Trusted Homes panel but normal users cannot access them until an admin explicitly grants permissions.

1. After connecting a Trusted Home and syncing its catalog, click **Set up access** (shown in the connection success panel) or open the home's **Manage Access** section in the Connected Trusted Homes list.
2. For each remote library, grant `can_view` and/or `can_play` to specific users using the checkboxes.
3. Click **Save access settings** to apply.
4. Users without explicit grants cannot see or play remote libraries.
5. Admins always have access regardless of grants.
6. Grant access only for media and users you are authorized to manage.

**Access model:**
- `can_view`: user can see the library and browse its contents
- `can_play`: user can play media from the library (requires `can_view`)
- No automatic access is granted by connecting a Trusted Home
- Revoking `can_view` also revokes `can_play`

### Advanced manual setup

The invite flow is preferred. If you need to connect manually (e.g. the other admin already has your token and just needs the address):

**On the source home:**

1. Go to **Admin → Trusted Homes → This Home → Advanced manual setup**.
2. Click **Generate token**.
3. Copy the raw token — it is shown only once.

**On the connecting home:**

1. Go to **Admin → Trusted Homes → Connected Trusted Homes → + Manual setup**.
2. Enter the home's name, its server address (e.g. `http://helix-living-room:3001`), and paste the access token.
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

### Disconnecting a Trusted Home

Disconnecting a Trusted Home removes its synced catalog and all access grants from the local database. It does not affect media or data on the other home.

**What gets removed:**
- All libraries synced from that home
- All media items in those libraries
- All media files linked to those items and that node
- All user access grants (`library_permissions`) for those libraries
- The node record itself

**What is preserved:**
- All local libraries and media items (only the remote home's catalog is removed)
- The other home's invite record (it remains marked as used)
- User accounts

Use the **Disconnect Trusted Home** button in the Connected Trusted Homes panel. A confirmation dialog explains what will be removed. On success, a summary is shown ("Removed 3 libraries, 142 items, 12 access grants.").

### Background sync

Helix automatically syncs connected Trusted Homes in the background so catalogs stay up to date without manual intervention.

- Runs every 6 hours by default (configurable via `TRUSTED_HOME_SYNC_INTERVAL_MS`)
- Uses incremental sync (`?since=<last_sync_at>`) when `last_sync_at` is available; falls back to a full sync if the remote does not support the `?since` parameter
- Nodes are staggered by 30 seconds apart to avoid thundering herd on restarts
- Manual **Sync** and **Full re-sync** buttons remain available for immediate updates
- Per-node locking prevents a background sync and a manual sync from running concurrently for the same node; if a sync is already in progress the manual sync returns `409 Conflict`
- The current sync interval is shown at the top of the Trusted Homes page

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUSTED_HOME_SYNC_ENABLED` | `true` | Enable background auto-sync |
| `TRUSTED_HOME_SYNC_INTERVAL_MS` | `21600000` | Sync interval in ms (default 6 hours) |
| `TRUSTED_HOME_SYNC_STAGGER_MS` | `30000` | Delay between each node's sync start (ms) |
| `TRUSTED_HOME_SYNC_ON_STARTUP` | `false` | Sync immediately on server startup |

**Known limitations:**

- Incremental sync now propagates remote deletions via tombstones. When a Trusted Home removes a catalog item, version, or file, connecting homes receive tombstone records on the next sync and apply the deletion safely. Full re-sync remains available for full reconciliation.

To reconnect after disconnecting, create a new invite on the other home and use Accept invite again.

### Revoking access without disconnecting

Use **Revoke all access** in the Trusted Home row to remove all user access grants for a home's libraries without removing the synced catalog or disconnecting.

**What gets removed:**
- All `library_permissions` rows for that home's libraries

**What is preserved:**
- The connection (node record)
- The synced catalog (libraries, media items)
- User accounts

After revoking, users will no longer see or play from that home's libraries. You can re-grant access at any time using the Manage Access panel or the bulk grant endpoint.

### Incremental sync

After the initial full sync, subsequent **Sync** operations are incremental — only items whose `updated_at` is newer than `last_sync_at` are fetched from the remote. The response envelope includes `"incremental": true` and the `"since"` timestamp used.

Incremental sync (`?since`) detects changes across `media_items`, `media_versions`, and `media_files`. If a version or file record changes (e.g. quality upgrade, file replaced), its parent item is included in the incremental response with full version and file data. Remote deletions are propagated via tombstones in the incremental response (see below).

Tombstones only apply to rows owned by the announcing home; local catalog rows and rows from other Trusted Homes are never affected.

**Sync decision logic:**
- `last_sync_at` is null (first sync or never synced) → full sync, no `?since`
- `last_sync_at` is set → incremental sync with `?since=<last_sync_at as ISO8601>`
- Remote returns 400 for `?since` (older server) → automatic fallback to full sync; `fallbackUsed: true` is included in the response
- Any other remote error → sync fails, `last_sync_at` is NOT updated

**`last_sync_at` is updated only on success.** Failed syncs leave the timestamp unchanged so the next attempt retries from the same baseline.

**Force a full re-sync:** use the **Full re-sync** button next to the Sync button. This ignores `last_sync_at` and fetches the complete catalog. Use this to reconcile stale records after remote items have been deleted.

**Incremental sync and deletions:**
- Incremental sync upserts only the returned items — it does NOT remove remote items that are absent from the partial response.
- Remote deletions are propagated via tombstones in the incremental response. When a Trusted Home deletes a catalog item, version, file, or library, the next incremental sync applies those deletions safely. The sync result includes `tombstonesApplied` and removal counts.
- Full re-sync (`force=true` or **Full re-sync** button) is still available for full reconciliation.
- If the remote catalog seems stale, use **Full re-sync** to reconcile.

**Troubleshooting stale remote catalog:**
- Use **Full re-sync** on the Trusted Home to fetch and re-import the complete catalog.
- If the remote home's URL changed, disconnect and re-invite.

### What is deferred

- **Hub video proxy** — the browser streams directly from the remote node. No hub-side buffering or re-streaming.
- **Remote transcoding** — no server-side codec conversion; only formats the browser natively supports play.
- **NAT traversal** — direct playback requires the browser to reach the remote node. Nodes behind NAT that cannot be reached directly will show an unavailable message.
- **Cross-node watch-state sync** — watch progress is hub-local only.
- **Shared authentication** — users are local to each node; no SSO or shared user database.

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
                         (11 migrations, 12 tables)
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
| DELETE | `/api/v1/nodes/:id` | Disconnect remote node — atomically removes its synced libraries, media items, files, and access grants; returns cleanup summary |
| POST | `/api/v1/nodes/:id/test` | Test connection health |
| POST | `/api/v1/nodes/:id/sync` | Sync remote catalog |
| GET | `/api/v1/federation/token` | Check if access token is set |
| POST | `/api/v1/federation/token` | Generate (or regenerate) access token — returns raw token once |
| DELETE | `/api/v1/federation/token` | Revoke access token |
| POST | `/api/v1/trusted-home-invites` | Create invite (`label?`, `expires_in_days?`) — returns invite object and compact string once |
| GET | `/api/v1/trusted-home-invites` | List invites (no raw token in response) |
| DELETE | `/api/v1/trusted-home-invites/:id` | Revoke invite (sets `revoked_at`, row kept) |
| POST | `/api/v1/trusted-homes/accept-invite` | Accept invite string, test remote health, create node entry |
| GET | `/api/v1/nodes/:id/access-summary` | Per-library grant summary for a remote node; includes grants and ungranted users |
| PUT | `/api/v1/nodes/:id/access` | Bulk upsert library permissions for a remote node (`grants: [{libraryId, userId, canView, canPlay}]`) |
| DELETE | `/api/v1/nodes/:id/access` | Bulk revoke all library_permissions for a remote node's libraries; catalog and node record are kept |

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
- [x] Trusted Home invite flow — create and exchange invite strings to connect homes; no manual token/address copy-paste required; invite history with revocation
- [x] Trusted Home access workflow — per-library, per-user access grants for remote libraries; Manage Access panel in Trusted Homes UI; post-connect "Set up access" flow
- [x] Trusted Home disconnect — safe atomic cleanup of synced catalog and access grants; bulk-revoke endpoint; Disconnect and Revoke all access UI actions with cleanup summary
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
