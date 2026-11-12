/** DESIGN ONLY. Not a package entry point or an implemented API. */
export interface ApngFrame {
    readonly width: number;
    readonly height: number;
    /** Owned full-frame, straight-alpha sRGB RGBA8. May be retained/transferred by the encoder. */
    readonly data: Uint8ClampedArray;
    /** Proposed initial subset: integer milliseconds in 1..65535, without GIF rounding. */
    readonly durationMs: number;
}
export interface ApngEncoderContext {
    readonly signal: AbortSignal;
    /** Inclusive cumulative admitted RGBA bytes, including pending input; not total memory. */
    readonly maxInputBytes: number;
    readonly maxOutputBytes?: number;
}
export interface ApngFrameEncoder {
    /** Acknowledges acceptance, not compression; may retain owned data until terminal cleanup. */
    addFrame(frame: ApngFrame): void | Promise<void>;
    /** Complete APNG, including animation metadata for a single accepted frame. */
    finish(): Uint8Array | Promise<Uint8Array>;
    /** Idempotent; release retained inputs and terminate owned work even while finish is pending. */
    dispose(): void;
}
/** Synchronously returns one fresh owned instance; no shared instance/pool or async acquisition. */
export type ApngEncoderFactory = (
    options: { readonly plays: number }, context: ApngEncoderContext
) => ApngFrameEncoder;
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
    /** Total plays: 0 = infinite, 1 = once. Proposed default: 0. Not GIF's repeat count. */
    readonly plays?: number;
    readonly signal?: AbortSignal;
    readonly totalFrames?: number;
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationMs?: number;
    /** Proposed default: 64 MiB; inclusive cumulative frame bytes, independent of codec scratch. */
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    /** Synchronous observer; exceptions ignored, snapshots frozen, counts describe acceptance. */
    readonly onProgress?: (progress: ApngExportProgress) => void;
}
export interface ApngExporter {
    readonly state: ApngExportState;
    /** Capture the complete canvas before the first yield. Await before the next operation. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    /** Cached identity while finalizing/finished; Blob MIME image/apng, suggested extension .apng. */
    finish(): Promise<Blob>;
    dispose(): void;
}
export declare function createApngExporter(options: ApngExportOptions): ApngExporter;
