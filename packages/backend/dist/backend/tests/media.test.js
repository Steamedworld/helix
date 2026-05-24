"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_1 = require("../src/db/client");
const migrate_1 = require("../src/db/migrate");
const bootstrap_1 = require("../src/bootstrap");
const schema_1 = require("../src/db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const path_1 = require("path");
const fs_1 = require("fs");
const os_1 = require("os");
function createTestDb(testDir) {
    (0, fs_1.mkdirSync)(testDir, { recursive: true });
    const dbPath = (0, path_1.join)(testDir, 'test.db');
    const db = (0, client_1.createDb)(dbPath);
    (0, migrate_1.runMigrations)(db, (0, path_1.join)(__dirname, '../drizzle'));
    return db;
}
(0, vitest_1.describe)('media items', () => {
    let testDir;
    let db;
    let localNodeId;
    let libraryId;
    (0, vitest_1.beforeEach)(async () => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `helix-test-${crypto.randomUUID()}`);
        db = createTestDb(testDir);
        localNodeId = await (0, bootstrap_1.bootstrap)(db, testDir);
        const now = new Date().toISOString();
        libraryId = crypto.randomUUID();
        await db.insert(schema_1.libraries).values({
            id: libraryId,
            node_id: localNodeId,
            name: 'Movies',
            kind: 'movies',
            root_path: '/media/movies',
            scan_status: 'idle',
            created_at: now,
            updated_at: now,
        });
    });
    async function insertItem(title, year) {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.mediaItems).values({
            id,
            library_id: libraryId,
            kind: 'movie',
            title,
            sort_title: title.toLowerCase(),
            year,
            external_tmdb_id: null,
            external_tvdb_id: null,
            external_musicbrainz_id: null,
            created_at: now,
            updated_at: now,
        });
        return id;
    }
    (0, vitest_1.it)('lists all media items', async () => {
        await insertItem('The Matrix', 1999);
        await insertItem('Inception', 2010);
        const rows = await db.select().from(schema_1.mediaItems);
        (0, vitest_1.expect)(rows.length).toBe(2);
    });
    (0, vitest_1.it)('searches by title with LIKE', async () => {
        await insertItem('The Matrix', 1999);
        await insertItem('Matrix Reloaded', 2003);
        await insertItem('Inception', 2010);
        const rows = await db
            .select()
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.like)(schema_1.mediaItems.title, '%Matrix%'));
        (0, vitest_1.expect)(rows.length).toBe(2);
        (0, vitest_1.expect)(rows.every((r) => r.title.includes('Matrix'))).toBe(true);
    });
    (0, vitest_1.it)('fetches a single item by id', async () => {
        const id = await insertItem('Dune', 2021);
        const [item] = await db
            .select()
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaItems.id, id));
        (0, vitest_1.expect)(item.title).toBe('Dune');
        (0, vitest_1.expect)(item.year).toBe(2021);
        (0, vitest_1.expect)(item.kind).toBe('movie');
    });
});
//# sourceMappingURL=media.test.js.map