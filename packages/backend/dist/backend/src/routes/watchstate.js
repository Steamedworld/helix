"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchStateRoutes = watchStateRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const schema_1 = require("../db/schema");
const response_1 = require("../lib/response");
const drizzle_orm_2 = require("drizzle-orm");
async function watchStateRoutes(app, opts) {
    const { db } = opts;
    // PUT /watchstate/:media_item_id
    app.put('/:media_item_id', async (req, reply) => {
        const { user_id, position_seconds, duration_seconds, completed } = req.body;
        if (!user_id || position_seconds === undefined) {
            reply.status(400);
            return (0, response_1.err)('user_id and position_seconds are required');
        }
        const now = new Date().toISOString();
        const mediaItemId = req.params.media_item_id;
        // Check if a watch state already exists
        const [existing] = await db
            .select()
            .from(schema_1.watchStates)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.watchStates.user_id, user_id), (0, drizzle_orm_1.eq)(schema_1.watchStates.media_item_id, mediaItemId)))
            .limit(1);
        if (existing) {
            await db
                .update(schema_1.watchStates)
                .set({
                position_seconds,
                duration_seconds: duration_seconds ?? existing.duration_seconds,
                completed: completed ?? existing.completed,
                updated_at: now,
            })
                .where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, existing.id));
            const [updated] = await db
                .select()
                .from(schema_1.watchStates)
                .where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, existing.id));
            return (0, response_1.ok)(updated);
        }
        else {
            const id = crypto.randomUUID();
            await db.insert(schema_1.watchStates).values({
                id,
                user_id,
                media_item_id: mediaItemId,
                position_seconds,
                duration_seconds: duration_seconds ?? null,
                completed: completed ?? false,
                updated_at: now,
            });
            const [created] = await db
                .select()
                .from(schema_1.watchStates)
                .where((0, drizzle_orm_1.eq)(schema_1.watchStates.id, id));
            return (0, response_1.ok)(created);
        }
    });
    // GET /watchstate/continue-watching
    app.get('/continue-watching', async (req, reply) => {
        const { user_id, limit = '20' } = req.query;
        if (!user_id) {
            reply.status(400);
            return (0, response_1.err)('user_id is required');
        }
        const rows = await db
            .select({
            watchState: schema_1.watchStates,
            mediaItem: schema_1.mediaItems,
        })
            .from(schema_1.watchStates)
            .innerJoin(schema_1.mediaItems, (0, drizzle_orm_1.eq)(schema_1.watchStates.media_item_id, schema_1.mediaItems.id))
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.watchStates.user_id, user_id), (0, drizzle_orm_1.eq)(schema_1.watchStates.completed, false)))
            .orderBy((0, drizzle_orm_2.sql) `${schema_1.watchStates.updated_at} DESC`)
            .limit(parseInt(limit, 10));
        const items = rows.map(({ watchState, mediaItem }) => ({
            ...mediaItem,
            watch_state: watchState,
        }));
        return (0, response_1.ok)(items);
    });
}
//# sourceMappingURL=watchstate.js.map