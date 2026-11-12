import { createApngBatchEncoder } from './apng-batch.js';
import type { ApngFrameEncoder, ApngFrame } from './apng-types.js';

// Dedicated APNG protocol; never sent to existing GIF/AAC Worker files.
const scope = self as unknown as { postMessage(data: unknown, transfer?: Transferable[]): void; close(): void;
    onmessage: ((event: MessageEvent) => void) | null };
let encoder: ApngFrameEncoder | undefined, initialized = false, terminal = false, lastId = 0;
scope.onmessage = ({ data }) => {
    if (terminal) return;
    const id = data?.id, action = data?.action;
    try {
        if (!Number.isSafeInteger(id) || id <= lastId || data.version !== 1) throw new TypeError('Invalid APNG Worker request');
        lastId = id;
        if (action === 'init') {
            if (initialized) throw new Error('APNG Worker already initialized');
            const { plays, maxInputBytes, maxOutputBytes } = data.value;
            encoder = createApngBatchEncoder({ plays }, { signal: new AbortController().signal, maxInputBytes, maxOutputBytes });
            initialized = true;
            scope.postMessage({ version: 1, id, action });
        } else {
            if (!initialized || !encoder) throw new Error('APNG Worker not initialized');
            if (action === 'frame') { encoder.addFrame(data.value as ApngFrame); scope.postMessage({ version: 1, id, action }); }
            else if (action === 'finish') {
                const bytes = encoder.finish() as Uint8Array;
                terminal = true; encoder.dispose(); encoder = undefined;
                scope.postMessage({ version: 1, id, action, bytes }, [bytes.buffer as ArrayBuffer]); scope.close();
            } else throw new TypeError('Unknown APNG Worker action');
        }
    } catch (error) {
        terminal = true; encoder?.dispose(); encoder = undefined;
        scope.postMessage({ version: 1, id, action, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } });
        scope.close();
    }
};
