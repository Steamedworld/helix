import type { DrizzleDB } from '../db/client';
import type { Library } from '../../../shared/src/index.js';
export declare function scanLibrary(library: Library, localNodeId: string, db: DrizzleDB): Promise<{
    added: number;
    updated: number;
    skipped: number;
}>;
//# sourceMappingURL=scanner.d.ts.map