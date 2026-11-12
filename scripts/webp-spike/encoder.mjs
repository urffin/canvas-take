// Unmodified upstream binary; direct generated-module API bypasses its ESM packaging issue.
// Deleting the Embind vector here does NOT repair native cleanup gaps in encodeAnimation.
export async function loadEncoder(url, wasmBinary) {
    const { default: factory } = await import(url);
    return factory({ wasmBinary });
}
export function encode(module, job) {
    const vector = new module.VectorWebPAnimationFrame();
    try {
        for (const frame of job.frames) vector.push_back({ data: frame.data, duration: frame.duration,
            has_config: true, config: { lossless: Number(job.lossless), quality: job.quality } });
        const bytes = module.encodeAnimation(job.width, job.height, true, vector);
        if (!(bytes instanceof Uint8Array)) throw new Error('Upstream encodeAnimation returned no bytes');
        return bytes;
    } finally { vector.delete(); }
}
