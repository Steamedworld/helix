"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_1 = require("../src/db/client");
const migrate_1 = require("../src/db/migrate");
const bootstrap_1 = require("../src/bootstrap");
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
(0, vitest_1.describe)('bootstrap', () => {
    let testDir;
    let db;
    (0, vitest_1.beforeEach)(() => {
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `helix-test-${crypto.randomUUID()}`);
        db = createTestDb(testDir);
    });
    (0, vitest_1.it)('creates one local node and one admin user on first run', async () => {
        await (0, bootstrap_1.bootstrap)(db, testDir);
        const nodeRows = await db.select().from(schema_1.nodes);
        const userRows = await db.select().from(schema_1.users);
        (0, vitest_1.expect)(nodeRows).toHaveLength(1);
        (0, vitest_1.expect)(nodeRows[0].kind).toBe('local');
        (0, vitest_1.expect)(nodeRows[0].name).toBe('Helix Local');
        (0, vitest_1.expect)(nodeRows[0].status).toBe('online');
        (0, vitest_1.expect)(userRows).toHaveLength(1);
        (0, vitest_1.expect)(userRows[0].display_name).toBe('Admin');
        (0, vitest_1.expect)(userRows[0].role).toBe('admin');
    });
    (0, vitest_1.it)('does not create duplicates on second run', async () => {
        await (0, bootstrap_1.bootstrap)(db, testDir);
        await (0, bootstrap_1.bootstrap)(db, testDir);
        const nodeRows = await db.select().from(schema_1.nodes);
        const userRows = await db.select().from(schema_1.users);
        (0, vitest_1.expect)(nodeRows).toHaveLength(1);
        (0, vitest_1.expect)(userRows).toHaveLength(1);
    });
    (0, vitest_1.it)('returns the local node id', async () => {
        const nodeId = await (0, bootstrap_1.bootstrap)(db, testDir);
        (0, vitest_1.expect)(typeof nodeId).toBe('string');
        (0, vitest_1.expect)(nodeId.length).toBeGreaterThan(0);
        const nodeRows = await db.select().from(schema_1.nodes);
        (0, vitest_1.expect)(nodeRows[0].id).toBe(nodeId);
    });
});
//# sourceMappingURL=bootstrap.test.js.map