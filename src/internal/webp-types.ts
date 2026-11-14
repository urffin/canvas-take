/** WebP contracts shared by the public controller and supplied Worker adapter. */
export interface WebpFrame {
    readonly width: number;
    readonly height: number;
    /** Exclusive full-span, nonshared, straight-alpha sRGB RGBA8 snapshot. */
    readonly data: Uint8ClampedArray;
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
    readonly limits: Readonly<WebpExportLimits>;
}
export interface WebpFrameEncoder {
    /** Ownership transfers at invocation; acknowledgement describes admission, not compression. */
    addFrame(frame: WebpFrame): void | Promise<void>;
    finish(): Uint8Array | Promise<Uint8Array>;
    dispose(): void;
}
export type WebpEncoderFactory = (options: { readonly plays: number }, context: WebpEncoderContext) => WebpFrameEncoder;
export type WebpExportState = 'ready' | 'adding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
export interface WebpExportProgress {
    readonly phase: 'collecting' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
    readonly framesAccepted: number;
    readonly durationMs: number;
    readonly inputBytesAccepted: number;
    readonly totalFrames?: number;
    readonly outputBytes?: number;
}
export interface WebpExportOptions {
    readonly encoder: WebpEncoderFactory;
    readonly plays?: number;
    readonly signal?: AbortSignal;
    readonly totalFrames?: number;
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationMs?: number;
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    readonly onProgress?: (progress: WebpExportProgress) => void;
}
export interface WebpExporter {
    readonly state: WebpExportState;
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    finish(): Promise<Blob>;
    dispose(): void;
}
