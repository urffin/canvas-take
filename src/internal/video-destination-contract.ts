/** Shared adapter capability and recovery contracts. */
import type {Awaitable} from '../video.js';
import type {ExternalVideoDestination,ExternalVideoDestinationRequest,ExternalVideoIfExists} from './video-external-types.js';

/** Backend-scoped IDs, not paths, file handles, credentials or proof by themselves. */
export interface DestinationScope {
    readonly backendId: string;
    readonly scopeId: string;
    /** Revision of the provisioned capability evidence, not a reservation or target revision. */
    readonly profileRevision: string;
}
export type DestinationRequest<P extends ExternalVideoIfExists> =
    Omit<ExternalVideoDestinationRequest,'ifExists'> & {readonly ifExists:P};
export interface DestinationGuarantees<P extends ExternalVideoIfExists> {
    readonly scope: DestinationScope;
    readonly policy: P;
    readonly positionedWrites: 'all-or-reject';
    readonly staging: 'isolated-unpublished';
    readonly truncate: 'exact-before-publication';
    readonly publication: 'atomic-at-target';
    readonly recovery: 'journal-before-publication';
    /** A scoped platform profile must document stronger claims separately. */
    readonly durability: 'no-portable-crash-guarantee';
}
export type DestinationUnsupportedCode =
    | 'permission-required' | 'permission-denied' | 'unknown-scope' | 'stale-profile'
    | 'unsupported-policy' | 'unsupported-io' | 'unsupported-limits' | 'recovery-unavailable';
/** Rich diagnostics belong to the adapter. Core still receives the existing Support shape. */
export type DestinationSupport<P extends ExternalVideoIfExists> =
    | {readonly supported:true; readonly request:DestinationRequest<P>; readonly guarantees:DestinationGuarantees<P>}
    | {readonly supported:false; readonly code:DestinationUnsupportedCode; readonly reason:string};

/** Known to the application before starting the exporter, even if commit throws. */
export interface DestinationRecoveryKey {
    readonly version: 1;
    readonly backendId: string;
    readonly scopeId: string;
    readonly attemptId: string;
}
export type RecoveredReceipt<Value> =
    | {readonly status:'available'; readonly value:Value}
    | {readonly status:'unavailable'; readonly reason:unknown};
/** Historical publication, independent of who owns the current target name. */
export type ReconciledPublication<Value> =
    | {readonly status:'committed'; readonly receipt:RecoveredReceipt<Value>}
    | {readonly status:'not-committed'; readonly reason:unknown}
    | {readonly status:'indeterminate'; readonly reason:unknown};
interface RecoveryObservation {
    readonly key: DestinationRecoveryKey;
    /** Opaque backend recovery revision used to reject stale cleanup requests. */
    readonly revision: string;
    /** Observation only: may change immediately after inspection. */
    readonly currentTarget:'this-attempt'|'other-publication'|'absent'|'unknown';
    readonly staging:'retained'|'absent'|'unknown';
}
export type DestinationRecoverySnapshot<Value> = RecoveryObservation & (
    | {readonly quiescent:false; readonly publication:{readonly status:'indeterminate';readonly reason:unknown}}
    | {readonly quiescent:true; readonly publication:ReconciledPublication<Value>}
);
export type DestinationRecoveryCleanup =
    | {readonly status:'cleaned'|'already-clean'}
    | {readonly status:'blocked'; readonly reason:unknown};
export interface DestinationRecoveryService<Value> {
    /** Read-only. No republish, target mutation, implicit cleanup or permission prompt. */
    inspect(key:DestinationRecoveryKey):Awaitable<DestinationRecoverySnapshot<Value>>;
    /** Revalidate revision, quiescence, outcome and artifact ownership; never touch the target. */
    cleanup(key:DestinationRecoveryKey,request:{readonly expectedRevision:string}):Awaitable<DestinationRecoveryCleanup>;
}
/** One application attempt; construct a fresh binding for retry.  */
export interface DestinationAttemptBinding<Value> {
    readonly key:DestinationRecoveryKey;
    readonly destination:ExternalVideoDestination<Value>;
    /** Independent of transaction/codec handles and available after exporter.closed. */
    readonly recovery:DestinationRecoveryService<Value>;
}
