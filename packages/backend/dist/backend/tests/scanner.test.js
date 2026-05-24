"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_1 = require("../src/db/client");
const migrate_1 = require("../src/db/migrate");
const bootstrap_1 = require("../src/bootstrap");
const scanner_1 = require("../src/services/scanner");
const schema_1 = require("../src/db/schema");
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
async function insertLibrary(db, nodeId, rootPath) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.insert(schema_1.libraries).values({
        id,
        node_id: nodeId,
        name: 'Test Movies',
        kind: 'movies',
        root_path: rootPath,
        scan_status: 'idle',
        created_at: now,
        updated_at: now,
    });
    return {
        id,
        node_id: nodeId,
        name: 'Test Movies',
        kind: 'movies',
        root_path: rootPath,
        scan_status: 'idle',
        created_at: now,
        updated_at: now,
    };
}
(0, vitest_1.describe)('scanner', () => {
    let testDir;
    let mediaDir;
    let db;
    let localNodeId;
    (0, vitest_1.beforeEach)(async () => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `helix-test-${crypto.randomUUID()}`);
        mediaDir = (0, path_1.join)(testDir, 'media');
        (0, fs_1.mkdirSync)(mediaDir, { recursive: true });
        db = createTestDb(testDir);
        localNodeId = await (0, bootstrap_1.bootstrap)(db, testDir);
    });
    (0, vitest_1.afterEach)(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('scans and creates media items and files for mkv and mp4', async () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(mediaDir, 'The Matrix (1999).mkv'), '');
        (0, fs_1.writeFileSync)((0, path_1.join)(mediaDir, 'Inception.2010.mp4'), '');
        const library = await insertLibrary(db, localNodeId, mediaDir);
        const counts = await (0, scanner_1.scanLibrary)(library, localNodeId, db);
        (0, vitest_1.expect)(counts.added).toBe(2);
        (0, vitest_1.expect)(counts.skipped).toBe(0);
        const items = await db.select().from(schema_1.mediaItems);
        (0, vitest_1.expect)(items.length).toBe(2);
        const files = await db.select().from(schema_1.mediaFiles);
        (0, vitest_1.expect)(files.length).toBe(2);
        const titles = items.map((i) => i.title).sort();
        (0, vitest_1.expect)(titles).toContain('The Matrix');
        (0, vitest_1.expect)(titles).toContain('Inception');
        const years = items.map((i) => i.year);
        (0, vitest_1.expect)(years).toContain(1999);
        (0, vitest_1.expect)(years).toContain(2010);
    });
    (0, vitest_1.it)('does not create duplicates on second scan', async () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(mediaDir, 'The Matrix (1999).mkv'), '');
        const library = await insertLibrary(db, localNodeId, mediaDir);
        const first = await (0, scanner_1.scanLibrary)(library, localNodeId, db);
        (0, vitest_1.expect)(first.added).toBe(1);
        const second = await (0, scanner_1.scanLibrary)(library, localNodeId, db);
        (0, vitest_1.expect)(second.added).toBe(0);
        (0, vitest_1.expect)(second.skipped).toBe(1);
        const items = await db.select().from(schema_1.mediaItems);
        (0, vitest_1.expect)(items.length).toBe(1);
        const files = await db.select().from(schema_1.mediaFiles);
        (0, vitest_1.expect)(files.length).toBe(1);
    });
    (0, vitest_1.it)('handles nested directories', async () => {
        const subDir = (0, path_1.join)(mediaDir, 'subdir');
        (0, fs_1.mkdirSync)(subDir, { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.join)(subDir, 'Dune (2021).mkv'), '');
        const library = await insertLibrary(db, localNodeId, mediaDir);
        const counts = await (0, scanner_1.scanLibrary)(library, localNodeId, db);
        (0, vitest_1.expect)(counts.added).toBe(1);
        const items = await db.select().from(schema_1.mediaItems);
        (0, vitest_1.expect)(items[0].title).toBe('Dune');
        (0, vitest_1.expect)(items[0].year).toBe(2021);
    });
});
//# sourceMappingURL=scanner.test.js.map