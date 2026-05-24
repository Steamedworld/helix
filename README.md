# Helix

A modern, lightweight, self-hosted media hub. Simpler than Plex, prettier than Jellyfin. Local playback first with a federation-ready architecture built in from day one.

---

## Quick start

### Prerequisites

- Node.js 20+
- pnpm 9+

### Install dependencies

```bash
pnpm install
```

### Development (hot reload)

```bash
pnpm dev
# Backend: http://localhost:3001
# Frontend: http://localhost:5173
```

### Production build

```bash
pnpm build          # compiles shared → backend → frontend
pnpm start          # runs the built backend on :3001
```

`pnpm start` is equivalent to:
```bash
cd packages/backend
node dist/backend/src/index.js
```

The backend must run from `packages/backend/` as its working directory so that the `drizzle/` migrations folder is found correctly.

### First-run setup

On first start the server prints `setupRequired: true` from `GET /api/v1/auth/status`.  
Open the frontend at `http://localhost:5173` (or serve `packages/frontend/dist/` behind a reverse proxy) and complete the setup wizard to create the admin account.

### Environment variables

Copy `.env.example` to `packages/backend/.env` and fill in your values:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend listen port |
| `HOST` | `0.0.0.0` | Backend listen host |
| `NODE_ENV` | `development` | Set to `production` for prod |
| `DB_PATH` | `./data/helix.db` | SQLite database path (relative to `packages/backend/`) |
| `DATA_DIR` | `./data` | Root data directory |
| `TMDB_READ_ACCESS_TOKEN` | *(unset)* | TMDB API Read Access Token (preferred) |
| `TMDB_API_KEY` | *(unset)* | TMDB API key v3 (fallback if token not set) |
| `METADATA_CACHE_DIR` | `./data/metadata_cache` | Artwork/metadata download cache |
| `METADATA_ENRICHMENT_ENABLED` | `true` | Set to `false` to disable TMDB enrichment |

The app runs fully without TMDB credentials — enrichment is simply disabled.

### Data directories

On startup the backend automatically creates:
- `packages/backend/data/` — SQLite database and WAL files
- `packages/backend/data/metadata_cache/` — downloaded artwork cache

**Do not commit these directories.** They are covered by `.gitignore`.

---

## What works in this phase

- Create and manage media libraries (movies, TV, music, photos)
- File-system scanner discovers media files and parses titles/years from filenames
- Full catalog stored in SQLite via Drizzle ORM with typed schema
- REST API: libraries, media items, watch states, nodes, playback sessions, streaming, artwork
- Watch state tracking (position, completion) per user per item
- React frontend: Dashboard, Libraries list, Library detail, Add Library form, Media detail, TV Shows, Show Detail, Settings
- Node status indicator in sidebar (polls `/api/v1/health`)
- Bootstrap: first-launch creates local node + admin user automatically
- Federation seams: all multi-node hooks are stubbed and documented
- **Phase 6 — TMDB-TV metadata enrichment:**
  - `MetadataProvider` interface extended with optional TV methods: `searchShows`, `getShowDetails`, `getSeasonDetails`, `getEpisodeDetails`, `getShowArtwork`
  - TMDB provider now covers `movie`, `show`, `season`, `episode` — single provider, both capabilities
  - `enrichShow()`: searches TMDB TV, scores candidates (same 0.85 threshold), fetches show details, caches artwork, and automatically enriches child seasons
  - `enrichSeason()`: fetches season overview, air date, and poster from TMDB — called automatically during show enrichment
  - `enrichEpisode()`: requires parent show to be `matched`; fetches episode title, overview, air date, runtime, and absolute episode number from TMDB
  - `enrichMediaItem()` dispatches by kind: `movie` → existing path, `show` → `enrichShow`, `episode` → `enrichEpisode`, `season` → skip-with-message
  - `enrichBatch()` processes shows before episodes so parent is always matched first
  - `applyMatch()` for shows: calls `getShowDetails`, writes fields, enriches child seasons
  - `GET /api/v1/media/:id/metadata/search`: show items → `searchShows`; episode/season items → returns guidance message; movies unchanged
  - `POST /api/v1/metadata/providers`: TMDB now lists `supportedKinds: ['movie', 'show', 'season', 'episode']`
  - Show detail API (`GET /api/v1/shows/:id`) now returns `metadataStatus` and season `overview`
  - Episode detail API (`GET /api/v1/episodes/:id`) now returns `metadataStatus`, `showMetadataStatus`, `airDate`
  - Frontend ShowDetail: "Refresh Metadata" button, "Needs Review" amber banner, full match-candidate panel for shows
  - Frontend ShowDetail: season overview displayed when available
  - Frontend MediaDetail: episode refresh shows amber "Match parent show first" message when parent is unmatched
  - Registry: `deregister(id)` method added for clean test isolation
- **Phase 5 — TV show/season/episode hierarchy:**
  - Scanner builds full show → season → episode hierarchy from SxxEyy filename patterns
  - Show, season, episode are distinct `media_items` rows linked by `parent_id`
  - Idempotent: re-scanning never creates duplicate shows, seasons, or episodes
  - Local artwork detection extended to show-level directory (poster.jpg next to season folders)
  - TV API routes: `/api/v1/shows`, `/api/v1/shows/:id`, `/api/v1/shows/:id/seasons`, `/api/v1/seasons/:id/episodes`, `/api/v1/episodes/:id`
  - Source selection guards: show and season containers return an unavailable response with explanation
  - Continue Watching row enriched with showTitle, S01E02 context for episodes
  - Frontend: TV Shows grid, Show Detail page (backdrop hero + season tabs + episode list with progress bars)
  - TV Shows navigation entry in sidebar
- **Phase 3 — Local metadata enrichment:**
  - Enhanced filename parser: extracts title, year, season/episode, quality label (4K/1080p/720p/480p), resolution, video codec (H.264/H.265/AV1/VP9), audio codec (AAC/DTS/FLAC/AC3/TrueHD)
  - Local artwork detection: poster, cover, backdrop, fanart images detected automatically from media directories
  - Artwork served via `/api/v1/media/:id/artwork/poster` and `/api/v1/media/:id/artwork/backdrop`
  - Stale-file detection: files that disappear between scans get `missing_at` set; source selection skips them
  - Media detail shows backdrop hero, poster thumbnail, overview, content rating, release date
  - Media grid shows poster images with graceful text fallback
- **Phase 4 — Metadata provider system with TMDB:**
  - Provider interface + registry: pluggable metadata providers, singleton registry, per-kind lookup
  - TMDB provider: movie search, full movie details (overview, runtime, genres, release dates, content rating), artwork endpoint
  - Candidate scoring: token-overlap + Levenshtein edit distance; `score >= 0.85` → matched, `< 0.85` → needs_review
  - Enrichment service: `enrichMediaItem()` and `enrichBatch()` with skip/force logic
  - Artwork cache: downloads remote poster/backdrop to `data/metadata_cache/{itemId}/{kind}.ext`; local artwork always wins
  - Scanner protection: re-scan never overwrites enriched `overview`, `poster_path`, `backdrop_path`, `content_rating`, `release_date` on matched/needs_review items
  - Metadata API routes: providers list, bulk enrich, per-item refresh, search candidates, select match
  - Frontend: "Refresh Metadata" button, "Needs Review" amber banner, candidate match panel with poster thumbnails
  - Settings page: provider status (configured/unconfigured) with TMDB setup instructions
  - App runs fully without any TMDB credentials (graceful degradation)

---

## Metadata provider system (Phase 4)

### Provider architecture

Providers implement the `MetadataProvider` interface in `packages/backend/src/services/metadata/types.ts`:
- `searchMovies(title, year?)` — returns ranked `MetadataCandidate[]`
- `getMovieDetails(externalId)` — returns `EnrichedMovieMetadata | null`
- `getArtwork?(externalId)` — returns `ArtworkCandidate[]`
- `isConfigured()` — true when credentials are present

Providers register in the singleton `MetadataProviderRegistry` (`registry.ts`) at startup via `setupMetadataProviders()` in `server.ts`.

### TMDB setup

1. Create a free account at [themoviedb.org](https://www.themoviedb.org)
2. Go to [Settings → API](https://www.themoviedb.org/settings/api)
3. Copy the **API Read Access Token** (v4 auth, preferred) or the **API Key v3**
4. Add to your backend environment (see `.env.example`):

```bash
# Preferred — Bearer token auth
TMDB_READ_ACCESS_TOKEN=eyJhbGciO...

# Alternative — query param auth (only if no read token)
TMDB_API_KEY=abc123...
```

If neither is set, the TMDB provider reports `unconfigured` and is excluded from all enrichment. Everything else works normally.

### Enrichment flow

1. `enrichMediaItem(db, itemId)` checks `metadata_status` — skips `matched`/`needs_review` unless `force: true`
2. Calls `getEnabledProvidersForKind(item.kind)` from registry — only configured providers
3. Searches each provider with item's title and year
4. `scoreCandidate()` computes 0-1 confidence:
   - Exact title → 0.9 base
   - Token overlap (70%) + normalized edit distance (30%) for title
   - Year exact match +0.3, within ±1 year +0.15
5. `score >= 0.85` → calls `getMovieDetails()`, writes all enriched fields, `metadata_status = 'matched'`
6. `score < 0.85` → `metadata_status = 'needs_review'`, no fields overwritten
7. After matching: downloads poster and backdrop to artwork cache (if not already present locally)

### Artwork cache

- Remote images land in `{METADATA_CACHE_DIR}/{mediaItemId}/{kind}.{ext}` (default: `./data/metadata_cache/`)
- Local artwork (scanner-detected) always wins — cached images are only downloaded if `poster_path`/`backdrop_path` is null
- Path traversal prevention: downloads validated against cache root before write
- The existing `/api/v1/media/:id/artwork/poster` endpoint serves cached images transparently

### Scanner protection

On any re-scan, if a media item's `metadata_status` is `matched` or `needs_review`:
- `overview`, `content_rating`, `release_date`, `original_title`, `runtime_seconds` are **not** updated
- `poster_path` and `backdrop_path` are **not** overwritten if already set (cached/local wins)
- Filename-derived fields (`title`, `year`, `sort_title`) and version/file records update normally

### Metadata API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/metadata/providers` | List registered providers and their status |
| POST | `/api/v1/metadata/enrich` | Bulk enrich up to 20 unmatched items (`body: { limit? }`) |
| POST | `/api/v1/media/:id/metadata/refresh` | Force re-enrich a single item |
| GET | `/api/v1/media/:id/metadata/search` | Return scored candidates without committing |
| POST | `/api/v1/media/:id/metadata/match` | Commit a specific candidate (`body: { providerId, externalId }`) |

### TMDB-TV enrichment (Phase 6)

TMDB now supports TV shows, seasons, and episodes in addition to movies — same single provider, both capabilities.

**Supported TV metadata fields:**

| Item | Fields populated |
|------|-----------------|
| Show | title, originalTitle, overview, firstAirDate/year, contentRating, posterUrl, backdropUrl, genres, status |
| Season | overview, airDate/year, posterUrl |
| Episode | episodeTitle, overview, airDate/year, runtimeSeconds, absoluteEpisodeNumber |

**Enrichment cascade:**

1. Match a show via `POST /api/v1/media/:showId/metadata/refresh` or the "Find show match" panel
2. On high-confidence match (score ≥ 0.85), show fields are written and child seasons are enriched automatically
3. Episode enrichment runs on demand: `POST /api/v1/media/:episodeId/metadata/refresh`
   - Requires parent show `metadata_status = 'matched'` — episodes cannot be enriched without a matched parent
   - Episode data is fetched using the show's TMDB ID + season/episode numbers

**Parent show matching requirement:**

`GET /api/v1/media/:episodeId/metadata/search` and `GET /api/v1/media/:seasonId/metadata/search` return an empty candidates list with a guidance message: "Match the parent show first to enrich episodes automatically." Refreshing an episode whose parent show is unmatched returns `{ status: 'parent_unmatched', message: '...' }` — no DB write occurs.

**Local artwork precedence:**

Downloaded posters/backdrops are only written when `poster_path`/`backdrop_path` is null. Local scanner-detected artwork always wins.

**Scanner protection:**

Re-scanning after enrichment does not overwrite `overview`, `content_rating`, `release_date`, `poster_path`, or `backdrop_path` on `matched` or `needs_review` items.

### Remaining limitations (after Phase 6)

- Music tracks/albums — not enriched (no MusicBrainz yet)
- No scheduled/background enrichment — call `POST /api/v1/metadata/enrich` manually or from UI
- Episode still images (thumbnails) — `stillUrl` is fetched from TMDB but not cached to disk; episode `poster_path` is never set
- No user-uploaded artwork
- TVDB not integrated — `external_tvdb_id` column is reserved for a future provider

### Future providers

The registry is ready to accept additional providers:
- **TVDB** — alternate TV show/episode metadata (richer episode stills, alternate titles)
- **MusicBrainz** — music track and album metadata
- **OpenSubtitles** — subtitle discovery
- Any custom provider implementing `MetadataProvider` (including the optional TV methods)

---

## Metadata and Artwork

### Local-only metadata (filename-derived)

Helix derives metadata entirely from filenames and local artwork files. No external API calls are made.

After scanning, each media item gets `metadata_status = 'local'` and `metadata_source = 'filename'`.

### Filename parsing examples

| Filename | Title | Year | Quality | Codec |
|----------|-------|------|---------|-------|
| `Movie.Name.2020.1080p.BluRay.x264.mkv` | Movie Name | 2020 | 1080p | H.264 |
| `Movie Name (2020).mkv` | Movie Name | 2020 | — | — |
| `Movie.Name.2020.2160p.WEB-DL.mkv` | Movie Name | 2020 | 4K | — |
| `Show.Name.S01E02.Episode.Title.1080p.mkv` | Show Name | — | 1080p | — |
| `Show Name - S01E02 - Episode Title.mkv` | Show Name | — | — | — |

### Supported local artwork naming patterns

The scanner looks in the same directory as the media file for these artwork files (case-insensitive, `.jpg`/`.jpeg`/`.png`):

**Poster** (in priority order):
1. `poster.{ext}`
2. `cover.{ext}`
3. `folder.{ext}`
4. `{title}.{ext}` (title with dots replacing spaces)

**Backdrop**:
1. `backdrop.{ext}`
2. `fanart.{ext}`

Artwork is stored as an absolute filesystem path in the database and served via the artwork endpoint. Raw paths are never exposed to clients.

### Artwork endpoint

```
GET /api/v1/media/:id/artwork/poster
GET /api/v1/media/:id/artwork/backdrop
```

- Returns `404` if no artwork is set or file is missing on disk
- Returns `400` for any `kind` other than `poster` or `backdrop`
- Returns `403` if the stored path is outside all known library roots (path traversal prevention)
- Streams with `fs.createReadStream` — no full-image memory load
- Sets `Content-Type` from file extension (`image/jpeg` or `image/png`)
- Sets `Cache-Control: public, max-age=86400`

The media list and detail responses include `posterUrl` and `backdropUrl` as computed URL strings (or `null`). The raw `poster_path` / `backdrop_path` fields are never included in API responses.

### Stale-file behavior

On every library scan Helix checks all previously-cataloged files:

- **File still on disk**: if `missing_at` was set, it is cleared (file recovered).
- **File absent from disk**: `missing_at` is set to the current Unix timestamp (ms). The file record is **never deleted** from the catalog.

Files with `missing_at` set are excluded from source selection. The media detail page shows a distinct warning (red border + "went missing" message) when a file is marked missing, distinguishing it from "file was never found" unavailability.

To recover, restore the file and re-scan the library.

### Current limitations

- No TMDB, TVDB, or MusicBrainz enrichment yet (IDs stored in schema, ready for future use)
- `overview`, `content_rating`, `release_date`, `original_title`, `runtime_seconds` are only populated if set manually or by future enrichment — filename parsing cannot derive them
- Artwork detection is directory-local; per-file artwork naming (e.g. `MovieName-poster.jpg`) is not yet supported
- `metadata_status` values `matched`, `needs_review`, and `error` are reserved for future enrichment pipeline stages

### What is intentionally not yet implemented

- External metadata enrichment (TMDB / TVDB / MusicBrainz)
- Video fingerprinting or hash-based matching
- Per-episode artwork for TV shows
- Artwork download or caching from external sources
- User-uploaded artwork replacement

## What is intentionally NOT implemented

- Remote access / reverse proxy / HTTPS setup
- Video/audio transcoding (clean FFmpeg seams left for future use)
- Native mobile or TV apps
- Downloads or DVR
- Intro skipping or AI-assisted features
- Cloud relay or peer-to-peer streaming
- Authentication / multi-user login (default user assumed)

---

## How to run dev

```bash
# Install all dependencies (from repo root)
cd /path/to/helix
pnpm install

# Start both backend (port 3001) and frontend (port 5173)
pnpm dev
```

The frontend proxies `/api` to the backend automatically via Vite.

### Environment variables (backend)

Copy `.env.example` at the repo root for a documented template.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./data/helix.db` | SQLite database file |
| `DATA_DIR` | `./data` | Data directory |
| `NODE_ENV` | `development` | Environment |
| `TMDB_READ_ACCESS_TOKEN` | — | TMDB v4 Read Access Token (preferred) |
| `TMDB_API_KEY` | — | TMDB v3 API key (fallback if no read token) |
| `METADATA_CACHE_DIR` | `./data/metadata_cache` | Directory for cached artwork downloads |
| `METADATA_ENRICHMENT_ENABLED` | `true` | Set to `false` to disable enrichment |

---

## How to add a library

1. Open Helix at `http://localhost:5173`
2. Click **Libraries** in the sidebar
3. Click **+ Add Library**
4. Enter a name (e.g. "My Movies"), choose the type (Movies), and enter the absolute path to your files (e.g. `/media/movies`)
5. Click **Add Library** — you'll be taken to the library detail page
6. Click **Scan Library** — Helix walks the directory tree, parses filenames, and creates catalog entries
7. Media items appear in the grid; click any to see detail

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│   React + Vite (port 5173)                              │
│   ┌──────────┐  ┌──────────────┐  ┌─────────────────┐  │
│   │ Sidebar  │  │  Pages       │  │  API Client     │  │
│   │ NodeStatus│  │  Dashboard   │  │  (fetch wrappers│  │
│   │ MediaCard │  │  Libraries   │  │   typed w/      │  │
│   │ PosterGrid│  │  MediaDetail │  │   @helix/shared)│  │
│   └──────────┘  └──────────────┘  └────────┬────────┘  │
└────────────────────────────────────────────┼────────────┘
                                             │ HTTP /api/v1
┌────────────────────────────────────────────▼────────────┐
│                  Fastify Backend (port 3001)             │
│                                                         │
│  Routes: /health, /libraries, /media, /nodes,           │
│          /watchstate                                     │
│                                                         │
│  Services:                                              │
│  ┌───────────┐  ┌──────────────────────────────────┐   │
│  │  Scanner  │  │  Federation stubs (placeholders) │   │
│  │  (fs walk)│  │  nodeRegistry, catalogSync,      │   │
│  └───────────┘  │  sourceSelection, playbackSigning│   │
│                 │  healthCheck                      │   │
│  Bootstrap:     └──────────────────────────────────┘   │
│  local node + admin user on first launch                │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Drizzle ORM + better-sqlite3 (SQLite)            │  │
│  │  8 tables: nodes, users, libraries, media_items,  │  │
│  │  media_versions, media_files, watch_states,       │  │
│  │  playback_sessions                                │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────┐
│  @helix/shared      │
│  TypeScript types   │
│  used by both       │
│  backend + frontend │
└─────────────────────┘
```

---

## API endpoint reference

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Server status, version, node name |

### Libraries
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/libraries` | List all libraries |
| POST | `/api/v1/libraries` | Create library (`name`, `kind`, `root_path`) |
| GET | `/api/v1/libraries/:id` | Get library |
| PUT | `/api/v1/libraries/:id` | Update library (partial) |
| DELETE | `/api/v1/libraries/:id` | Delete library |
| POST | `/api/v1/libraries/:id/scan` | Trigger async scan |
| GET | `/api/v1/libraries/:id/scan-status` | Poll scan status + item count |

### Media
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/media` | List items (`library_id?`, `kind?`, `q?`, `limit?`, `offset?`) |
| GET | `/api/v1/media/:id` | Get item with versions + files |
| GET | `/api/v1/media/:id/versions` | List versions |
| GET | `/api/v1/media/:id/files` | List files |
| GET | `/api/v1/media/:id/playback-source` | Get best available playback source |
| GET | `/api/v1/media/:id/artwork/poster` | Stream poster image |
| GET | `/api/v1/media/:id/artwork/backdrop` | Stream backdrop image |
| POST | `/api/v1/media/:id/metadata/refresh` | Force re-enrich single item |
| GET | `/api/v1/media/:id/metadata/search` | Search providers for candidates (no commit) |
| POST | `/api/v1/media/:id/metadata/match` | Select a specific candidate and commit |

### Metadata
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/metadata/providers` | List providers and their configuration status |
| POST | `/api/v1/metadata/enrich` | Bulk enrich up to 20 unmatched items |

### Watch State
| Method | Path | Description |
|--------|------|-------------|
| PUT | `/api/v1/watchstate/:media_item_id` | Upsert watch state |
| GET | `/api/v1/watchstate/continue-watching` | In-progress items (`user_id`) |

### Nodes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/nodes` | List nodes |
| GET | `/api/v1/nodes/:id` | Get node |

### TV (Phase 5)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/shows` | List shows (`library_id?`) with episode count |
| GET | `/api/v1/shows/:id` | Show detail with seasons list |
| GET | `/api/v1/shows/:id/seasons` | Seasons for a show |
| GET | `/api/v1/seasons/:id/episodes` | Episodes for a season (`user_id?` for watch state) |
| GET | `/api/v1/episodes/:id` | Episode detail (showId, showTitle, seasonId included) |

---

## TV hierarchy (Phase 5)

### Show → Season → Episode model

TV episodes are stored as a three-level hierarchy of `media_items` linked by `parent_id`:

```
Show (kind='show', parent_id=null)
  └── Season 1 (kind='season', parent_id=<show_id>, season_number=1)
        ├── Episode 1 (kind='episode', parent_id=<season_id>, episode_number=1)
        └── Episode 2 (kind='episode', parent_id=<season_id>, episode_number=2)
```

`media_versions` and `media_files` attach to the **episode** item only. Shows and seasons are containers — they cannot be played directly and return a descriptive error from the playback-source endpoint.

### Supported TV filename patterns

| Filename | Show | Season | Episode | Episode Title |
|----------|------|--------|---------|---------------|
| `Breaking.Bad.S01E02.Cats.In.The.Bag.1080p.mkv` | Breaking Bad | 1 | 2 | Cats In The Bag |
| `Show Name - S01E02 - Episode Title.mkv` | Show Name | 1 | 2 | Episode Title |
| `Show.Name.S02E10.mkv` | Show Name | 2 | 10 | — |

Patterns with no SxxEyy are treated as movies.

### Local artwork for shows

The scanner looks for show-level artwork in the **parent directory of the season folder**:

```
/media/
  Breaking Bad/         ← show-level artwork looked up here
    poster.jpg          ← sets show item's poster_path
    Season 1/
      Breaking.Bad.S01E01.mkv
```

Standard artwork names apply: `poster.jpg`, `cover.jpg`, `folder.jpg`, `backdrop.jpg`, `fanart.jpg`.

If episode files are flat (not in season subdirectories), artwork is looked up one level above the library root.

### What is not yet implemented (TV)

- **TVDB integration** — no TVDB provider yet; `external_tvdb_id` column is reserved.
- **Episode still image caching** — `stillUrl` is resolved from TMDB but not downloaded to disk; episodes have no locally-served `poster_path`.
- **Next episode navigation** — no "play next episode" button yet.
- **Cast / crew metadata** — not fetched from any provider.

### Recommended next phase

Phase 7 options:
1. Next-episode continuity (auto-advance to next episode, up-next row on Show Detail)
2. Episode still image download and caching (extend `cacheArtwork` for `still` kind)
3. Music track/album hierarchy (same `parent_id` pattern, using MusicBrainz)
4. TVDB provider (alternate/richer TV data, especially episode stills and alternate titles)

---

## Database schema

| Table | Key columns |
|-------|-------------|
| `nodes` | id, name, kind (local/remote), base_url, status |
| `users` | id, display_name, role (admin/user) |
| `libraries` | id, node_id, name, kind, root_path, scan_status |
| `media_items` | id, library_id, **parent_id**, kind, title, sort_title, year, overview, poster_path, backdrop_path, original_title, release_date, content_rating, runtime_seconds, **season_number**, **episode_number**, **episode_title**, **absolute_episode_number**, metadata_status, metadata_source, metadata_updated_at, external IDs |
| `media_versions` | id, media_item_id, label, quality_label, resolution, video_codec, audio_codec, container, duration |
| `media_files` | id, node_id, library_id, media_item_id, media_version_id, path, filename, extension, size_bytes, file_hash, missing_at |
| `watch_states` | id, user_id, media_item_id, position_seconds, duration_seconds, completed |
| `playback_sessions` | id, user_id, node_id, media_item_id, media_version_id, media_file_id, state |

All IDs are UUID strings. All timestamps are ISO 8601 strings. All tables are migration-managed via Drizzle Kit.

---

## Future federation plan

The five stubs in `packages/backend/src/services/federation/` are the seams for multi-node support:

| File | When it gets real |
|------|-------------------|
| `nodeRegistry.ts` | Nodes broadcast their presence; peers maintain a registry with heartbeat TTL |
| `catalogSync.ts` | Catalog changes push to peers via HTTP; pull on reconnect catches up missed updates |
| `sourceSelection.ts` | Scores all known nodes for a media item (latency, bandwidth, copy count); picks best |
| `playbackSigning.ts` | Generates time-limited signed tokens for cross-node playback URLs |
| `healthCheck.ts` | Periodic HTTP health checks with circuit breaker; updates `nodes.status` in DB |

The DB schema is already federation-aware: every `media_file` carries a `node_id`, so when remote nodes appear they can register their files without schema changes. The `nodes` table distinguishes `local` vs `remote` from day one.
