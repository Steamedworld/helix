import type { FastifyInstance } from 'fastify';
import type { DrizzleDB } from '../db/client';
export declare function libraryRoutes(app: FastifyInstance, opts: {
    db: DrizzleDB;
    localNodeId: string;
}): Promise<void>;
//# sourceMappingURL=libraries.d.ts.map