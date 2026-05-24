import * as schema from './schema';
export type DrizzleDB = ReturnType<typeof createDb>;
export declare function createDb(dbPath: string): import("drizzle-orm/better-sqlite3").BetterSQLite3Database<typeof schema>;
//# sourceMappingURL=client.d.ts.map