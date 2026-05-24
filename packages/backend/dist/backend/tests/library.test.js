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
(0, vitest_1.describe)('library CRUD', () => {
    let testDir;
    let db;
    let localNodeId;
    (0, vitest_1.beforeEach)(async () => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `helix-test-${crypto.randomUUID()}`);
        db = createTestDb(testDir);
        localNodeId = await (0, bootstrap_1.bootstrap)(db, testDir);
    });
    (0, vitest_1.it)('creates and lists a library', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.libraries).values({
            id,
            node_id: localNodeId,
            name: 'My Movies',
            kind: 'movies',
            root_path: '/media/movies',
            scan_status: 'idle',
            created_at: now,
            updated_at: now,
        });
        const rows = await db.select().from(schema_1.libraries);
        (0, vitest_1.expect)(rows).toHaveLength(1);
        (0, vitest_1.expect)(rows[0].name).toBe('My Movies');
        (0, vitest_1.expect)(rows[0].kind).toBe('movies');
    });
    (0, vitest_1.it)('updates a library', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.libraries).values({
            id,
            node_id: localNodeId,
            name: 'Old Name',
            kind: 'movies',
            root_path: '/media/old',
            scan_status: 'idle',
            created_at: now,
            updated_at: now,
        });
        await db
            .update(schema_1.libraries)
            .set({ name: 'New Name', updated_at: new Date().toISOString() })
            .where((0, drizzle_orm_1.eq)(schema_1.libraries.id, id));
        const [updated] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, id));
        (0, vitest_1.expect)(updated.name).toBe('New Name');
    });
    (0, vitest_1.it)('deletes a library', async () => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.libraries).values({
            id,
            node_id: localNodeId,
            name: 'To Delete',
            kind: 'tv',
            root_path: '/media/tv',
            scan_status: 'idle',
            created_at: now,
            updated_at: now,
        });
        await db.delete(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, id));
        const rows = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, id));
        (0, vitest_1.expect)(rows).toHaveLength(0);
    });
});
//# sourceMappingURL=library.test.js.map