"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.config = {
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    dbPath: process.env.DB_PATH ?? './data/helix.db',
    dataDir: process.env.DATA_DIR ?? './data',
    nodeEnv: process.env.NODE_ENV ?? 'development',
};
//# sourceMappingURL=config.js.map