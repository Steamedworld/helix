import type { ApiSuccess, ApiError } from '../../../shared/src/index.js';
export declare function ok<T>(data: T): ApiSuccess<T>;
export declare function err(message: string, details?: unknown): ApiError;
//# sourceMappingURL=response.d.ts.map