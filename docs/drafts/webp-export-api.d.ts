/** DESIGN ONLY, 2026-11-13. No implementation or package export is declared available. */
export interface WebpFrame {
    readonly width: number;
    readonly height: number;
    /** Exclusive, full-span, nonshared straight-alpha sRGB RGBA8 snapshot. */
    readonly data: Uint8ClampedArray;
    /** Exact integer milliseconds in 1..16777215. */
    readonly durationMs: number;
}
export interface WebpExportLimits {
    readonly maxFramePixels: number;
    readonly maxFrames: number;
    readonly maxDurationMs: number;
    readonly maxInputBytes: number;
    readonly maxOutputBytes: number;
}
export interface WebpEncoderContext {
    readonly signal: AbortSignal;
    /** Frozen normalized logical budgets; cumulative raw bytes are not peak memory. */
    readonly limits: Readonly<WebpExportLimits>;
}
export interface WebpFrameEncoder {
    /** Takes exclusive ownership at invocation; acknowledgement means accepted, not compressed. */
    addFrame(frame: WebpFrame): void | Promise<void>;
    /** Complete animated WebP, including ANIM/ANMF for one frame; independent nonshared bytes. */
    finish(): Uint8Array | Promise<Uint8Array>;
    /** Idempotent, nonblocking teardown; callable while initialization/add/finish is pending. */
    dispose(): void;
}
/** Synchronously acquire one fresh owned encoder; asynchronous work belongs inside its methods. */
export type WebpEncoderFactory = (
    options: { readonly plays: number }, context: WebpEncoderContext
) => WebpFrameEncoder;
export type WebpExportState = 'ready' | 'adding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
export interface WebpExportProgress {
    readonly phase: 'collecting' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
    readonly framesAccepted: number;
    readonly durationMs: number;
    readonly inputBytesAccepted: number;
    /** A hint, omitted when unset; not a limit or an encoded-frame count. */
    readonly totalFrames?: number;
    /** Present only on the successful finished snapshot. */
    readonly outputBytes?: number;
}
export interface WebpExportOptions {
    readonly encoder: WebpEncoderFactory;
    /** Total plays, 0 infinite (default), 1 once, maximum 65535. */
    readonly plays?: number;
    readonly signal?: AbortSignal;
    readonly totalFrames?: number;
    /** Defaults: 4194304 pixels, 1000 frames, 2147483647 ms, 64 MiB raw, 32 MiB output. */
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationMs?: number;
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    /** Synchronous observer of fresh frozen admission snapshots; synchronous exceptions ignored. */
    readonly onProgress?: (progress: WebpExportProgress) => void;
}
export interface WebpExporter {
    readonly state: WebpExportState;
    /** Fixed-size, complete owned snapshot before the first yield; await each operation. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    /** Cached identity while finalizing/finished; image/webp Blob, suggested extension .webp. */
    finish(): Promise<Blob>;
    dispose(): void;
}
/** Proposed PRIVATE controller name; this is not an import from @grundyjs/canvas-take. */
export declare function createWebpController(options: WebpExportOptions): WebpExporter;

export interface WebpWorkerOptions {
    /** Proposed module Worker asset override; does not change wasmUrl implicitly. */
    readonly workerUrl?: string | URL;
    /** Proposed separate WASM asset override, resolved on the calling thread. */
    readonly wasmUrl?: string | URL;
    /** Per init/frame/finish request, default 30000 ms; not a whole-export deadline. */
    readonly timeoutMs?: number;
    /** Supplied libwebp configuration belongs to the adapter, not the controller. */
    readonly lossless?: boolean;
    readonly quality?: number;
    readonly method?: number;
}
/** Proposed PRIVATE factory helper. Each encoder invocation owns one dedicated Worker. */
export declare function createWebpWorkerEncoder(options?: WebpWorkerOptions): WebpEncoderFactory;
