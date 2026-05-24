"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const nodeRegistry_1 = require("../src/services/federation/nodeRegistry");
const catalogSync_1 = require("../src/services/federation/catalogSync");
const sourceSelection_1 = require("../src/services/federation/sourceSelection");
const playbackSigning_1 = require("../src/services/federation/playbackSigning");
const healthCheck_1 = require("../src/services/federation/healthCheck");
const mockLocalNode = {
    id: 'node-1',
    name: 'Helix Local',
    kind: 'local',
    base_url: null,
    status: 'online',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
};
const mockRemoteNode = {
    id: 'node-2',
    name: 'Remote Node',
    kind: 'remote',
    base_url: 'http://remote:3001',
    status: 'unknown',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
};
(0, vitest_1.describe)('federation stubs', () => {
    (0, vitest_1.it)('registerNode does not throw', async () => {
        await (0, vitest_1.expect)((0, nodeRegistry_1.registerNode)(mockLocalNode)).resolves.toBeUndefined();
    });
    (0, vitest_1.it)('discoverNodes returns empty array', async () => {
        const result = await (0, nodeRegistry_1.discoverNodes)();
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)('pushCatalogUpdate does not throw', async () => {
        await (0, vitest_1.expect)((0, catalogSync_1.pushCatalogUpdate)([])).resolves.toBeUndefined();
    });
    (0, vitest_1.it)('pullCatalogUpdates returns empty array', async () => {
        const result = await (0, catalogSync_1.pullCatalogUpdates)('node-2');
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)('selectBestSource returns null', async () => {
        const result = await (0, sourceSelection_1.selectBestSource)('media-1', 'user-1');
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)('signPlaybackUrl returns a stub URL', () => {
        const url = (0, playbackSigning_1.signPlaybackUrl)('http://localhost:3001', 'file-1', 'user-1');
        (0, vitest_1.expect)(url).toBe('http://localhost:3001/api/v1/stream/file-1');
    });
    (0, vitest_1.it)('checkNodeHealth returns online for local node', async () => {
        const status = await (0, healthCheck_1.checkNodeHealth)(mockLocalNode);
        (0, vitest_1.expect)(status).toBe('online');
    });
    (0, vitest_1.it)('checkNodeHealth returns unknown for remote node', async () => {
        const status = await (0, healthCheck_1.checkNodeHealth)(mockRemoteNode);
        (0, vitest_1.expect)(status).toBe('unknown');
    });
});
//# sourceMappingURL=federation.test.js.map