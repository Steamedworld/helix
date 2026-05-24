"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
exports.getMigrationsFolder = getMigrationsFolder;
const migrator_1 = require("drizzle-orm/better-sqlite3/migrator");
const path_1 = require("path");
function runMigrations(db, migrationsFolder) {
    (0, migrator_1.migrate)(db, { migrationsFolder });
}
function getMigrationsFolder() {
    // In production (compiled), migrations are relative to the dist folder
    // In development, they're relative to the src folder
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) {
        return (0, path_1.join)(__dirname, '../../drizzle');
    }
    return (0, path_1.join)(__dirname, '../drizzle');
}
//# sourceMappingURL=migrate.js.map