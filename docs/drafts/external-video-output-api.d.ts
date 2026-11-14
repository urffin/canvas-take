/** Research contract only. No CanvasTake package export or implementation promise. */
export interface PositionedDestination<Handle> {
    /** Wait for capacity. Observe the supplied signal and release readiness listeners/timers. */
    ready?(signal: AbortSignal): Promise<void> | void;
    /** Receiver owns a snapshot. Resolve when this write no longer uses the supplied bytes. */
    writeAt(position: number, data: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<void> | void;
    truncate(size: number): Promise<void> | void;
    /** Publish/close the complete output. Durability/fsync and overwrite policy are destination-specific. */
    commit(): Promise<Handle> | Handle;
    /** Idempotently release/remove owned partial output, after non-cancellable physical writes settle. */
    abort(reason: unknown): Promise<void> | void;
}
export interface ExternalOutputReceipt<Handle> {
    readonly kind: 'external-output';
    readonly type: 'video/mp4' | 'video/webm';
    readonly size: number;
    readonly handle: Handle;
}
export interface ReceiverLimits {
    readonly maxOutputBytes: number;
    readonly maxWriteBytes: number;
}
/** Possible future overload/result specialization; existing Blob result stays unchanged. */
export interface ExternalVideoResult<Handle> {
    readonly output: ExternalOutputReceipt<Handle>;
    readonly mimeType: string;
    readonly extension: string;
    readonly durationUs: number;
    readonly videoFrames: number;
    readonly audioPresentationSamples?: number;
    readonly videoCodec: string;
    readonly audioCodec?: string;
}
