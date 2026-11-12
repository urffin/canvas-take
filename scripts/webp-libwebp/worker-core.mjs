import { encode, stats } from './backend.mjs';
export function run(module, job, shared) {
    const flags = shared ? new Int32Array(shared) : undefined;
    let calls = 0, paused = false, bytes, error;
    try {
        bytes = encode(module, job, { nativeProgress(percent) {
            calls++;
            if (flags && percent >= 1) {
                // Executed from WebPPicture.progress_hook inside WebPEncode's native stack.
                Atomics.store(flags, 0, 1); Atomics.add(flags, 3, 1); Atomics.notify(flags, 0);
                try {
                    if (!paused) { paused = true; Atomics.wait(flags, 2, 0, 15000); }
                    return Atomics.load(flags, 1) === 0;
                } finally { Atomics.store(flags, 0, 0); }
            }
            return true;
        } });
    } catch (value) { error = { name: value.name, message: value.message }; }
    return { bytes, error, calls, stats: stats(module) };
}
