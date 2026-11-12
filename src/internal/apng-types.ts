/** Internal implementation contracts. No public APNG package entry exists yet. */
export interface ApngFrame {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    readonly durationMs: number;
}
export interface ApngEncoderContext {
    readonly signal: AbortSignal;
    readonly maxInputBytes: number;
    readonly maxOutputBytes?: number;
}
export interface ApngFrameEncoder {
    addFrame(frame: ApngFrame): void | Promise<void>;
    finish(): Uint8Array | Promise<Uint8Array>;
    dispose(): void;
}
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
    readonly plays?: number;
    readonly signal?: AbortSignal;
    readonly totalFrames?: number;
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationMs?: number;
    readonly maxInputBytes?: number;
    readonly maxOutputBytes?: number;
    readonly onProgress?: (progress: ApngExportProgress) => void;
}
export interface ApngExporter {
    readonly state: ApngExportState;
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    finish(): Promise<Blob>;
    dispose(): void;
}
