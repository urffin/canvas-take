/** Contracts re-exported from @grundyjs/canvas-take/apng. */
export interface ApngFrame {
    readonly width: number;
    readonly height: number;
    /** Owned full-frame straight-alpha sRGB RGBA8; may be retained or transferred. */
    readonly data: Uint8ClampedArray;
    /** Exact integer milliseconds in 1..65535. */
    readonly durationMs: number;
}
export interface ApngEncoderContext {
    readonly signal: AbortSignal;
    /** Inclusive cumulative admitted RGBA budget, not peak memory. */
    readonly maxInputBytes: number;
    readonly maxOutputBytes?: number;
}
export interface ApngFrameEncoder {
    /** Acknowledges acceptance, not compression; receives exclusive ownership of data. */
    addFrame(frame: ApngFrame): void | Promise<void>;
    finish(): Uint8Array | Promise<Uint8Array>;
    /** Idempotently release inputs and terminate pending owned work. */
    dispose(): void;
}
/** Return a fresh owned instance synchronously; no asynchronous acquisition or shared pool. */
export type ApngEncoderFactory = (options: { readonly plays: number }, context: ApngEncoderContext) => ApngFrameEncoder;
export type ApngExportState = 'ready' | 'adding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
export interface ApngExportProgress {
    readonly phase: 'collecting' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
    readonly framesAccepted: number;
    readonly durationMs: number;
    readonly inputBytesAccepted: number;
    readonly totalFrames?: number;
    readonly outputBytes?: number;
}
export interface ApngExportOptions {
    readonly encoder: ApngEncoderFactory;
    /** Total plays: 0 infinite (default), 1 once; maximum 4294967295. */
    readonly plays?: number;
    readonly signal?: AbortSignal;
    readonly totalFrames?: number;
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationMs?: number;
    /** Default 64 MiB; counts cumulative raw frame bytes, not codec scratch or output. */
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    /** Synchronous frozen snapshots; observer exceptions ignored. Counters describe acceptance. */
    readonly onProgress?: (progress: ApngExportProgress) => void;
}
export interface ApngExporter {
    readonly state: ApngExportState;
    /** Snapshot before the first yield. Await each operation before starting the next. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    /** Cached identity while finalizing/finished; result MIME is image/apng. */
    finish(): Promise<Blob>;
    dispose(): void;
}
