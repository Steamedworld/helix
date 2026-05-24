"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const client_1 = require("./db/client");
const migrate_1 = require("./db/migrate");
const bootstrap_1 = require("./bootstrap");
const server_1 = require("./server");
async function main() {
    // Create DB
    const db = (0, client_1.createDb)(config_1.config.dbPath);
    // Run migrations
    const migrationsFolder = (0, migrate_1.getMigrationsFolder)();
    (0, migrate_1.runMigrations)(db, migrationsFolder);
    // Bootstrap (create local node and admin user if needed)
    const localNodeId = await (0, bootstrap_1.bootstrap)(db, config_1.config.dataDir);
    // Build and start the server
    const app = (0, server_1.buildServer)(db, localNodeId);
    try {
        await app.listen({ port: config_1.config.port, host: config_1.config.host });
        console.log(`Helix backend running at http://${config_1.config.host}:${config_1.config.port}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map