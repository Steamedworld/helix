"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
const fs_1 = require("fs");
const schema_1 = require("../db/schema");
const drizzle_orm_1 = require("drizzle-orm");
const logger_1 = require("../lib/logger");
async function bootstrap(db, dataDir) {
    // 1. Ensure data directory exists
    (0, fs_1.mkdirSync)(dataDir, { recursive: true });
    // 2. Check if admin user exists — if not, create one
    const [userCount] = await db.select({ count: (0, drizzle_orm_1.count)() }).from(schema_1.users);
    if (userCount.count === 0) {
        const now = new Date().toISOString();
        await db.insert(schema_1.users).values({
            id: crypto.randomUUID(),
            display_name: 'Admin',
            role: 'admin',
            created_at: now,
            updated_at: now,
        });
        logger_1.logger.info('Bootstrap: created default admin user');
    }
    // 3. Check if local node exists — if not, create one
    const [nodeCount] = await db.select({ count: (0, drizzle_orm_1.count)() }).from(schema_1.nodes);
    if (nodeCount.count === 0) {
        const now = new Date().toISOString();
        const localNodeId = crypto.randomUUID();
        await db.insert(schema_1.nodes).values({
            id: localNodeId,
            name: 'Helix Local',
            kind: 'local',
            base_url: null,
            status: 'online',
            created_at: now,
            updated_at: now,
        });
        logger_1.logger.info('Bootstrap: created local node');
        return localNodeId;
    }
    // Return existing local node ID
    const [localNode] = await db.select({ id: schema_1.nodes.id }).from(schema_1.nodes).limit(1);
    return localNode.id;
}
//# sourceMappingURL=index.js.map