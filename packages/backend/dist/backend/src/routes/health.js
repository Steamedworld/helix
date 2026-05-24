"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
const response_1 = require("../lib/response");
async function healthRoutes(app) {
    app.get('/health', async () => {
        return (0, response_1.ok)({
            status: 'ok',
            version: '0.1.0',
            node: 'Helix Local',
        });
    });
}
//# sourceMappingURL=health.js.map