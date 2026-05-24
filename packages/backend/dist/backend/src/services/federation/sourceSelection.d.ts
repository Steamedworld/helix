export interface PlaybackSource {
    nodeId: string;
    nodeBaseUrl: string;
    fileId: string;
    filePath: string;
    score: number;
}
export declare function selectBestSource(_mediaItemId: string, _userId: string): Promise<PlaybackSource | null>;
//# sourceMappingURL=sourceSelection.d.ts.map