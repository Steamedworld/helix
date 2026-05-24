# Helix

A self-hosted media hub. Simpler than Plex, prettier than Jellyfin. Scans your local library, enriches it from TMDB, plays directly in the browser, and tracks your watch progress — all on your own hardware, with no cloud required.

> **Status:** pre-1.0, actively developed. Core playback, metadata enrichment, and Radarr/Sonarr read-only integrations are fully functional.

---

## Features

- **Direct play** — streams any video your browser supports straight from the file; no transcoding server required
- **File scanner** — walks library directories, parses titles/years from filenames, detects local artwork
- **TMDB enrichment** — movie and TV show metadata, posters, and backdrops via The Movie Database (optional, graceful if not configured)
- **TV hierarchy** — full Show → Season → Episode model with season tabs, episode rows, and continue-watching
- **Watch progress** — position and completion tracked per user per item; "Continue Watching" row on the dashboard
- **Up-next auto-advance** — 10-second countdown after an episode ends, navigates automatically to the next
- **Multi-user auth** — bcrypt passwords, HTTP-only session cookies, admin and user roles
- **Radarr / Sonarr integration** — read-only: surfaces monitored status and quality profile on media detail pages
- **API key encryption** — AES-256-GCM at rest; the browser never receives a plaintext key
- **Federation-ready** — architecture and DB schema designed for future multi-node support; seams are stubbed and documented

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

### Security

API keys are encrypted at rest with AES-256-GCM. The browser only ever sees a masked key (`ab••••••yz`). See [SECURITY.md](SECURITY.md) for details.

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
pnpm test             # run all Vitest tests (381 tests)
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
│   │   ├── drizzle/      # SQL migrations (5 files)
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
                         (5 migrations, 9 tables)
```

The DB schema is federation-aware from day one: every `media_file` carries a `node_id`. When multi-node support ships, remote nodes register files without schema changes. Five federation seams are stubbed in `packages/backend/src/services/federation/`.

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
| GET/POST | `/api/v1/libraries` | List / create libraries |
| GET/PUT/DELETE | `/api/v1/libraries/:id` | Get / update / delete |
| POST | `/api/v1/libraries/:id/scan` | Trigger scan |
| GET | `/api/v1/media` | List items (`kind?`, `q?`, `limit?`, `offset?`) |
| GET | `/api/v1/media/:id` | Item detail with versions and files |
| GET | `/api/v1/media/:id/playback-source` | Best playback source for this client |
| GET | `/api/v1/media/:id/artwork/poster` | Stream poster image |
| GET | `/api/v1/media/:id/artwork/backdrop` | Stream backdrop image |
| GET | `/api/v1/stream/:fileId` | Range-request video stream |

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
- **No background enrichment** — trigger `POST /api/v1/metadata/enrich` manually or from the UI.
- **No TVDB** — TV metadata is TMDB-only; `external_tvdb_id` is reserved in the schema for a future provider.
- **No music enrichment** — MusicBrainz is not yet integrated.
- **No episode still caching** — episode thumbnails are resolved from TMDB but not downloaded to disk.
- **Single-node only** — federation seams are stubbed; multi-node support is a future milestone.

---

## Roadmap

- [ ] Background metadata enrichment (scheduled or event-driven)
- [ ] Episode still image download and caching
- [ ] MusicBrainz provider for music libraries
- [ ] TVDB provider for alternate TV metadata
- [ ] Subtitle support (OpenSubtitles / local .srt/.ass)
- [ ] Multi-node federation (catalog sync, remote playback signing)
- [ ] User request management (non-admin users request missing content)
- [ ] Lidarr integration for music
- [ ] Webhook-driven auto-sync from Arr events

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
