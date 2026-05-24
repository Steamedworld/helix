# Helix

A modern, lightweight, self-hosted media hub. Simpler than Plex, prettier than Jellyfin. Local playback first with a federation-ready architecture built in from day one.

---

## What works in this phase

- Create and manage media libraries (movies, TV, music, photos)
- File-system scanner discovers media files and parses titles/years from filenames
- Full catalog stored in SQLite via Drizzle ORM with typed schema
- REST API: libraries, media items, watch states, nodes
- Watch state tracking (position, completion) per user per item
- React frontend: Dashboard, Libraries list, Library detail, Add Library form, Media detail
- Node status indicator in sidebar (polls `/api/v1/health`)
- Bootstrap: first-launch creates local node + admin user automatically
- Federation seams: all multi-node hooks are stubbed and documented

## What is intentionally NOT implemented

- Remote access / reverse proxy / HTTPS setup
- Video/audio transcoding (clean FFmpeg seams left for future use)
- Native mobile or TV apps
- Downloads or DVR
- Intro skipping or AI-assisted features
- Cloud relay or peer-to-peer streaming
- Authentication / multi-user login (default user assumed)
- Actual video playback (placeholder area present in Media Detail)
- Metadata enrichment from TMDB / TVDB / MusicBrainz (IDs stored, enrichment not wired)

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

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./data/helix.db` | SQLite database file |
| `DATA_DIR` | `./data` | Data directory |
| `NODE_ENV` | `development` | Environment |

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

---

## Database schema

| Table | Key columns |
|-------|-------------|
| `nodes` | id, name, kind (local/remote), base_url, status |
| `users` | id, display_name, role (admin/user) |
| `libraries` | id, node_id, name, kind, root_path, scan_status |
| `media_items` | id, library_id, kind, title, sort_title, year, external IDs |
| `media_versions` | id, media_item_id, label, quality_label, resolution, codecs, container, duration |
| `media_files` | id, node_id, library_id, media_item_id, media_version_id, path, filename, extension, size_bytes, file_hash |
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
