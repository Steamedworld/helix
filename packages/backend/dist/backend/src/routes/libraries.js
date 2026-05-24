"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.libraryRoutes = libraryRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const schema_1 = require("../db/schema");
const response_1 = require("../lib/response");
const scanner_1 = require("../services/scanner");
const drizzle_orm_2 = require("drizzle-orm");
async function libraryRoutes(app, opts) {
    const { db, localNodeId } = opts;
    // GET /libraries
    app.get('/', async () => {
        const rows = await db.select().from(schema_1.libraries);
        return (0, response_1.ok)(rows);
    });
    // POST /libraries
    app.post('/', async (req, reply) => {
        const { name, kind, root_path } = req.body;
        if (!name || !kind || !root_path) {
            reply.status(400);
            return (0, response_1.err)('name, kind, and root_path are required');
        }
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        await db.insert(schema_1.libraries).values({
            id,
            node_id: localNodeId,
            name,
            kind,
            root_path,
            scan_status: 'idle',
            created_at: now,
            updated_at: now,
        });
        const [created] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, id));
        reply.status(201);
        return (0, response_1.ok)(created);
    });
    // GET /libraries/:id
    app.get('/:id', async (req, reply) => {
        const [lib] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        if (!lib) {
            reply.status(404);
            return (0, response_1.err)('Library not found');
        }
        return (0, response_1.ok)(lib);
    });
    // PUT /libraries/:id
    app.put('/:id', async (req, reply) => {
        const [existing] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        if (!existing) {
            reply.status(404);
            return (0, response_1.err)('Library not found');
        }
        const now = new Date().toISOString();
        await db
            .update(schema_1.libraries)
            .set({ ...req.body, updated_at: now })
            .where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        const [updated] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        return (0, response_1.ok)(updated);
    });
    // DELETE /libraries/:id
    app.delete('/:id', async (req, reply) => {
        const [existing] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        if (!existing) {
            reply.status(404);
            return (0, response_1.err)('Library not found');
        }
        await db.delete(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        return (0, response_1.ok)({ deleted: true });
    });
    // POST /libraries/:id/scan
    app.post('/:id/scan', async (req, reply) => {
        const [lib] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        if (!lib) {
            reply.status(404);
            return (0, response_1.err)('Library not found');
        }
        // Set scan status to scanning
        const now = new Date().toISOString();
        await db
            .update(schema_1.libraries)
            .set({ scan_status: 'scanning', updated_at: now })
            .where((0, drizzle_orm_1.eq)(schema_1.libraries.id, lib.id));
        // Run scan async
        const libraryForScan = { ...lib, scan_status: 'scanning' };
        (0, scanner_1.scanLibrary)(libraryForScan, localNodeId, db)
            .then(async () => {
            const done = new Date().toISOString();
            await db
                .update(schema_1.libraries)
                .set({ scan_status: 'idle', updated_at: done })
                .where((0, drizzle_orm_1.eq)(schema_1.libraries.id, lib.id));
        })
            .catch(async () => {
            const done = new Date().toISOString();
            await db
                .update(schema_1.libraries)
                .set({ scan_status: 'error', updated_at: done })
                .where((0, drizzle_orm_1.eq)(schema_1.libraries.id, lib.id));
        });
        return (0, response_1.ok)({ started: true });
    });
    // GET /libraries/:id/scan-status
    app.get('/:id/scan-status', async (req, reply) => {
        const [lib] = await db.select().from(schema_1.libraries).where((0, drizzle_orm_1.eq)(schema_1.libraries.id, req.params.id));
        if (!lib) {
            reply.status(404);
            return (0, response_1.err)('Library not found');
        }
        const [{ item_count }] = await db
            .select({ item_count: (0, drizzle_orm_2.count)() })
            .from(schema_1.mediaItems)
            .where((0, drizzle_orm_1.eq)(schema_1.mediaItems.library_id, lib.id));
        return (0, response_1.ok)({ scan_status: lib.scan_status, item_count });
    });
}
//# sourceMappingURL=libraries.js.map