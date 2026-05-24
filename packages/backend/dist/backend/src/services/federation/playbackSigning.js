"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signPlaybackUrl = signPlaybackUrl;
function signPlaybackUrl(nodeBaseUrl, fileId, _userId) {
    // TODO: multi-node federation — generate signed playback URL for a remote node
    // For now: return a direct local path stub
    return `${nodeBaseUrl}/api/v1/stream/${fileId}`;
}
//# sourceMappingURL=playbackSigning.js.map