// Private feasibility harness only. This is not a CanvasTake entry point or controller.
export function validate(job) {
    const integer = (value, min, max, name) => { if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(name); };
    integer(job.width, 1, 16383, 'width'); integer(job.height, 1, 16383, 'height');
    integer(job.plays ?? 0, 0, 65535, 'plays');
    integer(job.method ?? 4, 0, 6, 'method');
    if (typeof job.lossless !== 'boolean' || !Number.isFinite(job.quality) || job.quality < 0 || job.quality > 100) throw new RangeError('codec options');
    const limits = { maxPixels: job.maxPixels ?? 4194304, maxFrames: job.maxFrames ?? 1000,
        maxInputBytes: job.maxInputBytes ?? 67108864, maxOutputBytes: job.maxOutputBytes ?? 33554432, maxDurationMs: job.maxDurationMs ?? 2147483647 };
    for (const [name, value] of Object.entries(limits)) integer(value, 1, 2147483647, name);
    const pixels = job.width * job.height;
    if (pixels > limits.maxPixels) throw new RangeError('pixel limit');
    if (!Array.isArray(job.frames) || job.frames.length < 1 || job.frames.length > limits.maxFrames) throw new RangeError('frame limit');
    if (pixels * 4 * job.frames.length > limits.maxInputBytes) throw new RangeError('input byte limit');
    let duration = 0;
    for (const frame of job.frames) {
        integer(frame.duration, 1, 16777215, 'frame duration'); duration += frame.duration;
        if (duration > Math.min(limits.maxDurationMs, 2147483647)) throw new RangeError('duration limit');
        if (!(frame.data instanceof Uint8Array) || frame.data.length !== pixels * 4) throw new RangeError('RGBA buffer');
    }
    return limits;
}
export function stats(module) {
    return { liveBytes: module._ct_live_bytes(), liveAllocations: module._ct_live_allocations(), peakBytes: module._ct_peak_bytes(),
        allocationCalls: module._ct_allocation_calls(), allocatorUsed: module._ct_allocator_used(), wasmCapacity: module.HEAPU8.buffer.byteLength };
}
function nativeError(module) {
    const pointer = module._ct_error(); let end = pointer;
    while (module.HEAPU8[end]) end++;
    return new Error(new TextDecoder().decode(module.HEAPU8.subarray(pointer, end)) || 'Native allocation failed');
}
export function encode(module, job, hooks = {}) {
    hooks.signal?.throwIfAborted();
    const limits = validate(job); let session = 0, input = 0;
    const previous = module.nativeProgress;
    let hookError;
    // Never throw across the C/WASM stack: let native error paths release their pictures.
    module.nativeProgress = percent => {
        try { return hooks.nativeProgress?.(percent) !== false; }
        catch (error) { hookError = error; return false; }
    };
    module._ct_reset_peak();
    try {
        session = module._ct_open(job.width, job.height, job.plays ?? 0, Number(job.lossless), job.quality, job.method ?? 4, limits.maxOutputBytes);
        if (!session) throw nativeError(module);
        input = module._ct_malloc(job.width * job.height * 4);
        if (!input) throw new Error('Input allocation failed');
        for (let i = 0; i < job.frames.length; i++) {
            hooks.signal?.throwIfAborted();
            module.HEAPU8.set(job.frames[i].data, input);
            if (!module._ct_add(session, input, job.frames[i].data.length, job.frames[i].duration)) throw hookError ?? nativeError(module);
            hooks.onFrame?.(i + 1);
        }
        hooks.signal?.throwIfAborted();
        if (!module._ct_finish(session)) throw nativeError(module);
        const start = module._ct_data(session), size = module._ct_size(session);
        if (!start || !size) throw new Error('Missing encoded output');
        return module.HEAPU8.slice(start, start + size);
    } finally {
        module._ct_free(input); module._ct_close(session); module.nativeProgress = previous;
    }
}
