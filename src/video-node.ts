import {provisionNodeVideoDestination as provision} from './internal/video-file-node.mjs';
import type {NodeVideoDestination as InternalDestination} from './internal/video-file-node.mjs';

export type {NodeVideoReceipt} from './internal/video-file-node.mjs';
export type {
    DestinationScope, DestinationRequest, DestinationGuarantees, DestinationSupport, DestinationUnsupportedCode,
    DestinationRecoveryKey, DestinationRecoverySnapshot, DestinationRecoveryCleanup, DestinationRecoveryService,
    ReconciledPublication, RecoveredReceipt, DestinationAttemptBinding
} from './internal/video-destination-contract.js';

export interface NodeVideoDestinationOptions {
    readonly trust: 'controlled-local-directory';
    readonly maxWriteBytes?: number;
    readonly maxAttempts?: number;
}

export type NodeVideoDestination = Omit<InternalDestination, 'stats' | 'invalidate'>;

/** Provision a receiver in a caller-owned controlled local directory on supported Node platforms. */
export async function provisionNodeVideoDestination(directory: string, options: NodeVideoDestinationOptions): Promise<NodeVideoDestination> {
    const {trust, maxWriteBytes, maxAttempts} = options;
    const {stats: _diagnostics, invalidate: _invalidate, ...destination} = await provision(directory, {trust, maxWriteBytes, maxAttempts});
    return Object.freeze(destination);
}
