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
(0, vitest_1.describe)('watch states', () => {
    let testDir;
    let db;
    let localNodeId;
    let userId;
    let mediaItemId;
    (0, vitest_1.beforeEach)(async () => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `helix-test-${crypto.randomUUID()}`);
        db = createTestDb(testDir);
        localNodeId = await (0, bootstrap_1.bootstrap)(db, testDir);
        // Get the admin user created by bootstrap
        const [user] = await db.select().from(schema_1.users).limit(1);
        userId = user.id;
        // Create a library and media item
        const now = new Date().toISOString();
        const libraryId = crypto.randomUUID();
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
        mediaItemId = crypto.randomUUID();
        await db.insert(schema_1.mediaItems).values({
            id: mediaItemId,
            library_id: libraryId,
            kind: 'movie',
            title: 'Test Movie',
            sort_title: 'test movie',
            year: 2020,
            external_tmdb_id: null,
            external_tvdb_id: null,
            external_musicbrainz_id: null,
            created_at: now,
            updated_at: now,
        });
    });
    (0, vitest_1.it)('upserts a watch state', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.watchStates).values({
            id,
            user_id: userId,
            media_item_id: mediaItemId,
            position_seconds: 120,
            duration_seconds: 7200,
            completed: false,
            updated_at: now,
        });
        const [ws] = await db
            .select()
            .from(schema_1.watchStates)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.watchStates.user_id, userId), (0, drizzle_orm_1.eq)(schema_1.watchStates.media_item_id, mediaItemId)));
        (0, vitest_1.expect)(ws.position_seconds).toBe(120);
        (0, vitest_1.expect)(ws.completed).toBe(false);
    });
    (0, vitest_1.it)('updates position', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.watchStates).values({
            id,
            user_id: userId,
            media_item_id: mediaItemId,
            position_seconds: 120,
            duration_seconds: 7200,
            completed: false,
            updated_at: now,
        });
        await db
            .update(schema_1.watchStates)
            .set({ position_seconds: 3600, updated_at: new Date().toISOString() })
            .where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, id));
        const [updated] = await db.select().from(schema_1.watchStates).where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, id));
        (0, vitest_1.expect)(updated.position_seconds).toBe(3600);
    });
    (0, vitest_1.it)('marks as completed', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.watchStates).values({
            id,
            user_id: userId,
            media_item_id: mediaItemId,
            position_seconds: 7100,
            duration_seconds: 7200,
            completed: false,
            updated_at: now,
        });
        await db
            .update(schema_1.watchStates)
            .set({ completed: true, updated_at: new Date().toISOString() })
            .where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, id));
        const [updated] = await db.select().from(schema_1.watchStates).where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, id));
        (0, vitest_1.expect)(updated.completed).toBe(true);
    });
});
//# sourceMappingURL=watchstate.test.js.map