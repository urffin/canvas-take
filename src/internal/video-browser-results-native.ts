/** Browser adapter for the private managed result store. No browser globals are read at import. */
import {openBrowserResultStore} from './video-browser-results.js';
import type {
    BrowserResultDownloadPort, BrowserResultLockPort, BrowserResultMetadataPort,
    BrowserResultObjectPort, BrowserResultStoreOptions, BrowserResultWriterPort, ManagedState, MetadataCommit
} from './video-browser-results-ports.js';

const backendId = 'canvastake-opfs-managed-v2';
const catalogueStore = 'catalogue';
const objectStore = 'objects';
const maxAttempts = 256;
const maxExplicitHolds = 512;
type Scope = BrowserResultStoreOptions['scope'];
interface Catalogue {
    directory: FileSystemDirectoryHandle;
    marker: string;
    state: ManagedState;
}
interface ObjectRecord {
    owner: string;
    handle: FileSystemFileHandle;
}

const missing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
const invalid = (message: string) => new DOMException(message, 'InvalidStateError');

export function managedBrowserResultNamespace(scopeId: string): string {
    if (typeof scopeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scopeId)) {
        throw new TypeError('A dedicated managed browser namespace UUID is required');
    }
    return `${backendId}-${scopeId}`;
}

function browserCapabilities() {
    if (typeof navigator === 'undefined' || typeof indexedDB === 'undefined' ||
        typeof File === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks?.request ||
        typeof FileSystemFileHandle === 'undefined' || !FileSystemFileHandle.prototype.createWritable) {
        throw new DOMException('Managed browser storage requires OPFS, IndexedDB, Web Locks and File', 'NotSupportedError');
    }
}

function nativeLocks(manager: LockManager): BrowserResultLockPort {
    return {
        sharedExclusive: true,
        tryAcquire(name, mode) {
            return new Promise((resolve, reject) => {
                let unlock!: () => void;
                const held = new Promise<void>(done => { unlock = done; });
                const request = manager.request(name, {mode, ifAvailable: true}, lock => {
                    if (!lock) return;
                    resolve({release() { unlock(); return request; }});
                    return held;
                });
                void request.then(() => resolve(undefined), reject);
            });
        }
    };
}

function nativeDownload(): BrowserResultDownloadPort {
    const page = typeof document === 'undefined' ? undefined : document;
    return {
        available: () => !!page?.defaultView && !!page.body && typeof URL.createObjectURL === 'function',
        hasActivation: () => page?.defaultView?.navigator.userActivation?.isActive === true,
        createURL: file => URL.createObjectURL(file),
        revokeURL: url => URL.revokeObjectURL(url),
        request(url, fileName) {
            const anchor = page!.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.hidden = true;
            page!.body.append(anchor);
            try { anchor.click(); } finally { anchor.remove(); }
        }
    };
}

function openCatalogue(name: string, initial?: Catalogue): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = initial ? indexedDB.open(name, 2) : indexedDB.open(name);
        let rejected = false;
        let initialized = false;
        let upgradeError: unknown;
        request.onblocked = () => { rejected = true; reject(invalid('Managed catalogue open blocked')); };
        request.onupgradeneeded = event => {
            const tx = request.transaction!;
            if (rejected || !initial || event.oldVersion !== 0) {
                upgradeError = invalid('Missing managed catalogue or attempted upgrade of an existing database');
                tx.abort();
                return;
            }
            try {
                request.result.createObjectStore(catalogueStore).add(initial, 'state');
                request.result.createObjectStore(objectStore);
                initialized = true;
            } catch (error) {
                upgradeError = error;
                tx.abort();
            }
        };
        request.onerror = () => reject(upgradeError ?? request.error);
        request.onsuccess = () => {
            const db = request.result;
            if (rejected || (initial && !initialized) || db.version !== 2 || db.objectStoreNames.length !== 2 ||
                !db.objectStoreNames.contains(catalogueStore) || !db.objectStoreNames.contains(objectStore)) {
                db.close();
                reject(invalid('Managed catalogue schema or provisioning state mismatch'));
                return;
            }
            db.onversionchange = () => db.close();
            resolve(db);
        };
    });
}

/** Settle only on native transaction events. Never await inside a transaction callback. */
function transaction<T>(db: IDBDatabase, name: string, mode: IDBTransactionMode,
    body: (store: IDBObjectStore, finish: (value: T) => void, run: (action: () => void) => void) => void
): Promise<MetadataCommit<T>> {
    return new Promise(resolve => {
        let tx: IDBTransaction;
        try { tx = db.transaction(name, mode); }
        catch (reason) { resolve({status: 'aborted', reason}); return; }
        let value: T;
        let settled = false;
        let failed = false;
        let reason: unknown;
        const run = (action: () => void) => {
            try { action(); }
            catch (error) {
                failed = true;
                reason = error;
                try { tx.abort(); } catch { /* A complete event still cannot confirm this operation. */ }
            }
        };
        tx.oncomplete = () => resolve(settled && !failed
            ? {status: 'committed', value}
            : {status: 'indeterminate', reason: failed ? reason : invalid('Missing transaction result')});
        tx.onabort = () => resolve({status: 'aborted', reason: failed ? reason : tx.error ?? invalid('Transaction aborted')});
        run(() => body(tx.objectStore(name), result => { value = result; settled = true; }, run));
    });
}

async function committed<T>(outcome: Promise<MetadataCommit<T>>): Promise<T> {
    const result = await outcome;
    if (result.status !== 'committed') throw result.reason;
    return result.value;
}

function lookup<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
    return committed(transaction<T | undefined>(db, store, 'readonly', (records, finish, run) => {
        const req = records.get(key);
        req.onsuccess = () => run(() => finish(req.result));
    }));
}

function boundedReason(reason: unknown): unknown {
    if (typeof reason === 'string') return reason.slice(0, 512);
    if (reason == null || typeof reason === 'boolean' || typeof reason === 'number') return reason;
    try {
        if (typeof reason === 'object' && reason && 'message' in reason && typeof reason.message === 'string') {
            const name = 'name' in reason && typeof reason.name === 'string' ? reason.name : 'Error';
            return {name: name.slice(0, 64), message: reason.message.slice(0, 512)};
        }
    } catch { /* Diagnostics must not prevent a negative outcome from being stored. */ }
    return {name: 'Error', message: 'Application supplied a non-serializable reason'};
}

function nativeMetadata(db: IDBDatabase, verifyDirectory: () => Promise<void>): BrowserResultMetadataPort {
    function access<T>(mode: IDBTransactionMode, body: (s: ManagedState) => T) {
        return transaction<T>(db, catalogueStore, mode, (records, finish, run) => {
            const request = records.get('state');
            request.onsuccess = () => run(() => {
                const catalogue = request.result as Catalogue | undefined;
                if (!catalogue) throw invalid('Missing managed catalogue state');
                const {state} = catalogue;
                const value = body(state);
                if (mode === 'readwrite') {
                    if (state.attempts.size > maxAttempts || state.holds.size - state.versions.size > maxExplicitHolds) {
                        throw new DOMException('Managed catalogue history limit reached', 'QuotaExceededError');
                    }
                    for (const attempt of state.attempts.values()) {
                        if (Object.hasOwn(attempt, 'reason')) attempt.reason = boundedReason(attempt.reason);
                    }
                    records.put(catalogue, 'state');
                }
                finish(value);
            });
        });
    }
    return {
        atomic: true,
        read: async body => { await verifyDirectory(); return committed(access('readonly', body)); },
        async transact(_label, body) {
            try { await verifyDirectory(); } catch (reason) { return {status: 'aborted', reason}; }
            return access('readwrite', body);
        },
        async close() { db.close(); }
    };
}

function nativeWriter(stream: FileSystemWritableFileStream): BrowserResultWriterPort {
    const writer = stream.getWriter();
    void writer.closed.catch(() => {});
    const end = async (close: boolean, reason?: unknown) => {
        if (close) await writer.close(); else await writer.abort(reason);
        writer.releaseLock();
    };
    return {
        ready: () => writer.ready,
        writeAt: (position, data) => writer.write({type: 'write', position, data}),
        truncate: size => writer.write({type: 'truncate', size}),
        close: () => end(true),
        abort: reason => end(false, reason)
    };
}

function nativeObjects(scope: Scope, db: IDBDatabase, directory: FileSystemDirectoryHandle,
    verifyDirectory: () => Promise<void>): BrowserResultObjectPort {
    function path(id: string, owner: string) {
        if (!/^[A-Za-z0-9_-]{1,128}\.(mp4|webm)$/.test(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(owner)) {
            throw new TypeError('Invalid managed object identity');
        }
        return `video-${owner}.${id}`;
    }
    async function file(name: string) {
        try { return await directory.getFileHandle(name); }
        catch (error) { if (!missing(error)) throw error; }
    }
    async function identify(id: string, owner: string) {
        const name = path(id, owner);
        await verifyDirectory();
        const record = await lookup<ObjectRecord>(db, objectStore, id);
        if (record && record.owner !== owner) return {status: 'foreign'} as const;
        const handle = await file(name);
        if (!handle) return {status: 'absent'} as const;
        if (!record || !(await record.handle.isSameEntry(handle))) return {status: 'foreign'} as const;
        return {status: 'present', name, handle} as const;
    }
    return {
        scopeId: scope.scopeId, directoryId: scope.directoryId, positioned: true,
        async create(id, owner) {
            const name = path(id, owner);
            await verifyDirectory();
            if (await lookup<ObjectRecord>(db, objectStore, id) || await file(name)) throw invalid('Object identity already used');
            // The core owns the exclusive attempt lock and has already reserved this object ID.
            const handle = await directory.getFileHandle(name, {create: true});
            await committed(transaction(db, objectStore, 'readwrite', (records, finish) => {
                records.add({owner, handle} satisfies ObjectRecord, id);
                finish(undefined);
            }));
            return nativeWriter(await handle.createWritable({keepExistingData: false}));
        },
        async stat(id, owner) {
            const current = await identify(id, owner);
            if (current.status !== 'present') return current;
            try { return {status: 'present', size: (await current.handle.getFile()).size}; }
            catch (error) { if (missing(error)) return {status: 'absent'}; throw error; }
        },
        async read(id, owner) {
            const current = await identify(id, owner);
            if (current.status === 'absent') throw new DOMException('Original object missing', 'NotFoundError');
            if (current.status !== 'present') throw invalid('Original object identity is unverified');
            return current.handle.getFile();
        },
        async remove(id, owner, allowMissing) {
            const current = await identify(id, owner);
            if (current.status === 'absent' && allowMissing) return;
            if (current.status !== 'present') throw invalid('Cannot remove an unverified object');
            await directory.removeEntry(current.name);
        }
    };
}

/** The caller persists its namespace UUID. Reopen never creates or upgrades storage. */
export async function openNativeBrowserResultPorts(scopeId: string, mode: 'create' | 'reopen'): Promise<BrowserResultStoreOptions> {
    const name = managedBrowserResultNamespace(scopeId);
    if (mode !== 'create' && mode !== 'reopen') throw new TypeError('Explicit managed storage mode required');
    browserCapabilities();
    const locks = nativeLocks(navigator.locks);
    const root = await navigator.storage.getDirectory();
    const bootstrap = mode === 'create' ? await locks.tryAcquire(`${name}/provision`, 'exclusive') : undefined;
    if (mode === 'create' && !bootstrap) throw invalid('Managed namespace provisioning is already active');
    let db: IDBDatabase | undefined;
    try {
        let initial: Catalogue | undefined;
        if (mode === 'create') {
            try {
                await root.getDirectoryHandle(name);
                throw invalid('Managed OPFS directory already exists');
            } catch (error) { if (!missing(error)) throw error; }
            const directory = await root.getDirectoryHandle(name, {create: true});
            const directoryId = crypto.randomUUID();
            const marker = `directory-${directoryId}`;
            await directory.getFileHandle(marker, {create: true});
            initial = {directory, marker, state: {
                scope: {schema: 2, backendId, scopeId, directoryId, sequence: 0, revision: 0},
                attempts: new Map(), versions: new Map(), names: new Map(), holds: new Map()
            }};
        }
        db = await openCatalogue(name, initial);
        const catalogue = await lookup<Catalogue>(db, catalogueStore, 'state');
        const stored = catalogue?.state?.scope;
        if (!catalogue || !stored || stored.schema !== 2 || stored.backendId !== backendId || stored.scopeId !== scopeId ||
            catalogue.marker !== `directory-${stored.directoryId}` || !catalogue.directory) throw invalid('Unverified managed scope');
        const scope: Scope = Object.freeze({schema: 2, backendId, scopeId, directoryId: stored.directoryId});
        const directory = catalogue.directory;
        async function verifyDirectory() {
            const current = await root.getDirectoryHandle(name);
            if (!(await current.isSameEntry(directory))) throw invalid('Managed directory changed');
            await current.getFileHandle(catalogue!.marker);
        }
        await verifyDirectory();
        return {publication: 'opfs-catalog', trust: 'cooperating-origin-namespace', scope,
            metadata: nativeMetadata(db, verifyDirectory), objects: nativeObjects(scope, db, directory, verifyDirectory),
            locks, download: nativeDownload()};
    } catch (error) {
        db?.close();
        throw error;
    } finally {
        await bootstrap?.release();
    }
}

export async function openNativeBrowserResultStore(scopeId: string, mode: 'create' | 'reopen') {
    const ports = await openNativeBrowserResultPorts(scopeId, mode);
    try { return await openBrowserResultStore(ports); }
    catch (error) { await ports.metadata.close(); throw error; }
}
