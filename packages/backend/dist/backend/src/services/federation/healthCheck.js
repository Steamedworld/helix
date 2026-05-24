"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkNodeHealth = checkNodeHealth;
async function checkNodeHealth(node) {
    // TODO: multi-node federation — HTTP health check to remote node
    // For now: local node is always 'online'
    if (node.kind === 'local')
        return 'online';
    return 'unknown';
}
//# sourceMappingURL=healthCheck.js.map