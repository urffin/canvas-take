/** PUBLIC DESIGN ONLY. No public runtime exports; the private controller is verified separately. */
import type {
    Awaitable, CodecEvent, FrameTiming, MuxerConfig, MuxerContext, MuxerFactory,
    OfflineVideoExporter, OfflineVideoOptions, OfflineVideoState, Support, TimelineSummary
} from '@grundyjs/canvas-take/video';

export type ExternalVideoContainer = 'mp4' | 'webm';
export type ExternalVideoFormat<C extends ExternalVideoContainer = ExternalVideoContainer> = {
    mp4: { readonly mimeType: 'video/mp4'; readonly extension: 'mp4' };
    webm: { readonly mimeType: 'video/webm'; readonly extension: 'webm' };
}[C];

/** error = atomic create-new; replace = create if absent, atomically replace if present. */
export type ExternalVideoIfExists = 'error' | 'replace';
export interface ExternalVideoDestinationRequest {
    readonly format: ExternalVideoFormat;
    readonly ifExists: ExternalVideoIfExists;
    /** Resolved from the existing maxPendingBytes option, not a new user option. */
    readonly maxWriteBytes: number;
    readonly maxOutputBytes?: number;
}
export interface ExternalVideoDestinationContext extends ExternalVideoDestinationRequest {
    /** Library-owned pre-commit work signal; never aborted after commit admission. */
    readonly signal: AbortSignal;
}

export type ExternalVideoCommit<Value> =
    | { readonly status: 'committed'; readonly value: Value }
    | { readonly status: 'not-committed'; readonly reason: unknown }
    | { readonly status: 'indeterminate'; readonly reason: unknown; readonly recovery?: unknown };

export interface ExternalVideoReleaseContext {
    /** Owner's classification, including exceptions/malformed commit outcomes. */
    readonly publication: 'committed' | 'not-committed' | 'indeterminate';
}

export interface ExternalVideoTransaction<Value> {
    /** Capacity only. No publication. Observe the supplied pre-commit signal. */
    ready?(signal: AbortSignal): Awaitable<void>;
    /** All-or-reject positioned write. Borrow this exact owned view until physical settlement. */
    writeAt(position: number, data: Uint8Array<ArrayBuffer>, signal: AbortSignal): Awaitable<void>;
    truncate(size: number, signal: AbortSignal): Awaitable<void>;
    /** Non-cancellable publication attempt. Throw/reject is conservatively indeterminate. */
    commit(): Awaitable<ExternalVideoCommit<Value>>;
    /** Discard private uncommitted staging only. Never delete/restore a published target. */
    abort(reason: unknown): Awaitable<void>;
    /** Always attempted once; preserve published content and any indeterminate recovery state. */
    release(context: ExternalVideoReleaseContext): Awaitable<void>;
}

export interface ExternalVideoDestination<Value> {
    readonly kind: 'positioned-transactional';
    /** Read-only exact-request preflight; no probes, prompts, journals, writers or mutation.
     * Scoped profile evidence is not a reservation; create revalidates identity/availability.
     * Production diagnostics/recovery refinement: external-video-destination-contract.md. */
    checkSupport(request: ExternalVideoDestinationRequest): Awaitable<Support>;
    /** Fresh isolated transaction each call. Clean up unreturned resources if creation rejects. */
    create(context: ExternalVideoDestinationContext): Awaitable<ExternalVideoTransaction<Value>>;
}

/** Controller-owned snapshot/pressure boundary. Muxers cannot commit or abort a destination. */
export interface ExternalVideoWriteSink {
    readonly size: number;
    writeAt(position: number, data: Uint8Array): Promise<void>;
    fail(reason: unknown): void;
}
export interface ExternalVideoMuxerContext extends MuxerContext {
    readonly output: ExternalVideoWriteSink;
}
export interface ExternalVideoContainerResult<C extends ExternalVideoContainer = ExternalVideoContainer> {
    readonly kind: 'external-container';
    readonly mimeType: ExternalVideoFormat<C>['mimeType'];
    readonly size: number;
}
export interface ExternalVideoMuxer<C extends ExternalVideoContainer = ExternalVideoContainer> {
    write(event: CodecEvent): Promise<void>;
    /** Drain/close the container writer; return metadata only. Does not publish or return a Blob. */
    finalize(timeline: TimelineSummary): Promise<ExternalVideoContainerResult<C>>;
    /** Await cancellation of owned writer work; never owns the destination transaction. */
    dispose(): Awaitable<void>;
}
export interface ExternalVideoMuxerFactory<C extends ExternalVideoContainer = ExternalVideoContainer> {
    readonly outputKind: 'external';
    readonly format: ExternalVideoFormat<C>;
    checkSupport(config: MuxerConfig): Promise<Support>;
    create(config: MuxerConfig, context: ExternalVideoMuxerContext): Awaitable<ExternalVideoMuxer<C>>;
}

export interface ExternalVideoOptions<Value, C extends ExternalVideoContainer = ExternalVideoContainer>
    extends Omit<OfflineVideoOptions, 'muxer'> {
    readonly muxer: ExternalVideoMuxerFactory<C>;
    readonly destination: ExternalVideoDestination<Value>;
    /** Default error. No in-place/append fallback. */
    readonly ifExists?: ExternalVideoIfExists;
}

export interface ExternalVideoOutput<Value, C extends ExternalVideoContainer = ExternalVideoContainer> {
    readonly kind: 'external';
    readonly mimeType: ExternalVideoFormat<C>['mimeType'];
    readonly size: number;
    /** Caller-owned after publication. Opaque: never cloned, frozen, closed or deleted by the exporter. */
    readonly value: Value;
}
/** Keep MIME/extension/receipt correlated even when C is the full container union. */
export type ExternalVideoResult<Value, C extends ExternalVideoContainer = ExternalVideoContainer> = {
    [K in C]: TimelineSummary & ExternalVideoFormat<K> & {
        readonly output: ExternalVideoOutput<Value, K>;
        readonly videoCodec: string;
        readonly audioCodec?: string;
    }
}[C];
export interface ExternalVideoCleanupIssue {
    readonly operation: 'muxer.dispose' | 'encoder.dispose' | 'destination.abort' | 'destination.release' | 'late-acquire' | 'protocol';
    readonly reason: unknown;
}
export type ExternalVideoCloseReport<Value, C extends ExternalVideoContainer = ExternalVideoContainer> =
    | { readonly publication: 'committed'; readonly output: ExternalVideoOutput<Value, C>;
        readonly cleanupIssues: readonly ExternalVideoCleanupIssue[] }
    | { readonly publication: 'not-committed'; readonly reason: unknown;
        readonly cleanupIssues: readonly ExternalVideoCleanupIssue[] }
    | { readonly publication: 'indeterminate'; readonly reason: unknown; readonly recovery?: unknown;
        readonly cleanupIssues: readonly ExternalVideoCleanupIssue[] };

export type ExternalVideoOutputPhase = 'waiting' | 'writing' | 'committing' | 'settling' | 'settled';
export interface ExternalVideoExporter<Value, C extends ExternalVideoContainer = ExternalVideoContainer> {
    readonly state: 'initializing' | OfflineVideoState;
    /** Stable Promise; resolves once initialization completes. Rejects promptly on failure/abort. */
    readonly ready: Promise<void>;
    /** Stable, never-rejecting lifetime fence, including late acquisitions and cleanup attempts. */
    readonly closed: Promise<ExternalVideoCloseReport<Value, C>>;
    readonly outputPhase: ExternalVideoOutputPhase;
    /** Same snapshots/timeline rules as offline video. Await ready first. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, timing: FrameTiming): Promise<void>;
    /** Stable accepted finish Promise. Only a committed outcome produces a result; no blob property. */
    finish(): Promise<ExternalVideoResult<Value, C>>;
    /** Cancels before commit admission; during commit defers disposal without cancelling publication. */
    dispose(): void;
}

/** Proposed new /video export. Synchronous handle; validation/pre-abort can throw before any acquisition. */
export declare function createExternalVideoExporter<Value, C extends ExternalVideoContainer>(
    options: ExternalVideoOptions<Value, C>
): ExternalVideoExporter<Value, C>;

/** Existing /video function remains unchanged. These declarations permit compile-only comparison. */
export declare function createOfflineVideoExporter(options: OfflineVideoOptions): Promise<OfflineVideoExporter>;
/** Existing zero-argument /video/mp4 and /video/webm overloads remain unchanged. */
export declare function createMp4Muxer(): MuxerFactory;
export declare function createMp4Muxer(options: { readonly output: 'external' }): ExternalVideoMuxerFactory<'mp4'>;
export declare function createWebmMuxer(): MuxerFactory;
export declare function createWebmMuxer(options: { readonly output: 'external' }): ExternalVideoMuxerFactory<'webm'>;
