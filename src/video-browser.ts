import {openNativeBrowserResultStore} from './internal/video-browser-results-native.js';
import type {BrowserResultStore} from './internal/video-browser-results-types.js';

export type {
    BrowserResultStore, BrowserResultKey, BrowserResultReference, BrowserResultRevision, BrowserResultCursor,
    BrowserOwnerHoldKey, BrowserExplicitHoldKey, BrowserHoldKey, BrowserLifecycleBlockCode, BrowserLifecycleBlocked,
    BrowserAccess, BrowserFileLease, BrowserDownloadRequest, BrowserPreparedDownload, BrowserHoldObservation,
    BrowserHoldMutation, BrowserVersionSnapshot, BrowserVersionPage, BrowserDeleteOutcome, BrowserRecoverySnapshot,
    BrowserRecoveryOutcome, BrowserResultRecoveryService, BrowserManagedAttempt, BrowserLifecycleSupport, BrowserStoreClose
} from './internal/video-browser-results-types.js';

export interface BrowserVideoResultStoreOptions {
    /** Generate a dedicated UUID with crypto.randomUUID() and persist it to reopen this scope. */
    readonly scopeId: string;
    readonly mode: 'create' | 'reopen';
}

/** Open a managed catalogue in private origin storage. Uses browser globals only when called. */
export async function openBrowserVideoResultStore(options: BrowserVideoResultStoreOptions): Promise<BrowserResultStore> {
    const {stats: _diagnostics, ...store} = await openNativeBrowserResultStore(options.scopeId, options.mode);
    return Object.freeze(store);
}
