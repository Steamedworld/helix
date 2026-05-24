"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaRoutes = mediaRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const schema_1 = require("../db/schema");
const response_1 = require("../lib/response");
async function mediaRoutes(app, opts) {
    const { db } = opts;
    // GET /media
    app.get('/', async (req) => {
        const { library_id, kind, q, limit = '50', offset = '0' } = req.query;
        const conditions = [];
        if (library_id)
            conditions.push((0, drizzle_orm_1.eq)(schema_1.mediaItems.library_id, library_id));
        if (kind)
            conditions.push((0, drizzle_orm_1.eq)(schema_1.mediaItems.kind, kind));
        if (q)
            conditions.push((0, drizzle_orm_1.like)(schema_1.mediaItems.title, `%${q}%`));
        const rows = await db
            .select()
            .from(schema_1.mediaItems)
            .where(conditions.length > 0 ? (0, drizzle_orm_1.and)(...conditions) : undefined)
            .limit(parseInt(limit, 10))
            .offset(parseInt(offset, 10))
            .orderBy((0, drizzle_orm_1.sql) `${schema_1.mediaItems.created_at} DESC`);
        return (0, response_1.ok)(rows);
    });
    // GET /media/:id
    app.get('/:id', async (req, reply) => {
        const [item] = await db
            .select()
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaItems.id, req.params.id));
        if (!item) {
            reply.status(404);
            return (0, response_1.err)('Media item not found');
        }
        const versions = await db
            .select()
            .from(schema_1.mediaVersions)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaVersions.media_item_id, item.id));
        const files = await db
            .select()
            .from(schema_1.mediaFiles)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaFiles.media_item_id, item.id));
        return (0, response_1.ok)({ ...item, versions, files });
    });
    // GET /media/:id/versions
    app.get('/:id/versions', async (req, reply) => {
        const [item] = await db
            .select({ id: schema_1.mediaItems.id })
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaItems.id, req.params.id));
        if (!item) {
            reply.status(404);
            return (0, response_1.err)('Media item not found');
        }
        const versions = await db
            .select()
            .from(schema_1.mediaVersions)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaVersions.media_item_id, req.params.id));
        return (0, response_1.ok)(versions);
    });
    // GET /media/:id/files
    app.get('/:id/files', async (req, reply) => {
        const [item] = await db
            .select({ id: schema_1.mediaItems.id })
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaItems.id, req.params.id));
        if (!item) {
            reply.status(404);
            return (0, response_1.err)('Media item not found');
        }
        const files = await db
            .select()
            .from(schema_1.mediaFiles)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaFiles.media_item_id, req.params.id));
        return (0, response_1.ok)(files);
    });
}
//# sourceMappingURL=media.js.map