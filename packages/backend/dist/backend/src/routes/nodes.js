"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeRoutes = nodeRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const schema_1 = require("../db/schema");
const response_1 = require("../lib/response");
async function nodeRoutes(app, opts) {
    const { db } = opts;
    // GET /nodes
    app.get('/', async () => {
        const rows = await db.select().from(schema_1.nodes);
        return (0, response_1.ok)(rows);
    });
    // GET /nodes/:id
    app.get('/:id', async (req, reply) => {
        const [node] = await db.select().from(schema_1.nodes).where((0, drizzle_orm_1.eq)(schema_1.nodes.id, req.params.id));
        if (!node) {
            reply.status(404);
            return (0, response_1.err)('Node not found');
        }
        return (0, response_1.ok)(node);
    });
}
//# sourceMappingURL=nodes.js.map