"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const config_1 = require("./config");
const health_1 = require("./routes/health");
const libraries_1 = require("./routes/libraries");
const media_1 = require("./routes/media");
const nodes_1 = require("./routes/nodes");
const watchstate_1 = require("./routes/watchstate");
const response_1 = require("./lib/response");
function buildServer(db, localNodeId) {
    const app = (0, fastify_1.default)({
        logger: config_1.config.nodeEnv === 'development'
            ? {
                level: 'info',
                transport: {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'HH:MM:ss',
                        ignore: 'pid,hostname',
                    },
                },
            }
            : { level: 'warn' },
    });
    // CORS — allow all in dev
    app.register(cors_1.default, {
        origin: true,
        credentials: true,
    });
    // Routes
    app.register(health_1.healthRoutes, { prefix: '/api/v1' });
    app.register(libraries_1.libraryRoutes, {
        prefix: '/api/v1/libraries',
        db,
        localNodeId,
    });
    app.register(media_1.mediaRoutes, {
        prefix: '/api/v1/media',
        db,
    });
    app.register(nodes_1.nodeRoutes, {
        prefix: '/api/v1/nodes',
        db,
    });
    app.register(watchstate_1.watchStateRoutes, {
        prefix: '/api/v1/watchstate',
        db,
    });
    // Global error handler
    app.setErrorHandler((error, _req, reply) => {
        reply.status(error.statusCode ?? 500).send((0, response_1.err)(error.message, error.validation));
    });
    return app;
}
//# sourceMappingURL=server.js.map