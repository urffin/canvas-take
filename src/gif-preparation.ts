import { blendRange } from './internal/rgba.js';

// Internal preparation only: public adapters still receive opaque, owned frames.
const blockPixels = 16384;
const taskPixels = 1048576;
const budgetMs = 4;

export function createFramePreparation() {
    let pixels: Uint8ClampedArray | undefined;
    let cancelTask: (() => void) | undefined;
    let rejectTask: ((reason: unknown) => void) | undefined;
    let closed = false;
    function yieldTask(initial = false): Promise<void> {
        return new Promise((resolve, reject) => {
            rejectTask = reject;
            const done = () => {
                if (rejectTask !== reject) return; // Ignore a stale callback after disposal.
                cancelTask?.();
                cancelTask = undefined; rejectTask = undefined;
                resolve();
            };
            if (!initial && typeof MessageChannel !== 'undefined') {
                const channel = new MessageChannel();
                cancelTask = () => { channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); };
                channel.port1.onmessage = done;
                channel.port2.postMessage(null);
            } else {
                const timer = setTimeout(done, 0);
                cancelTask = () => clearTimeout(timer);
            }
        });
    }
    return {
        capture(data: Uint8ClampedArray, expectedBytes: number): void {
            if (closed) throw new Error('GIF preparation is disposed');
            pixels = new Uint8ClampedArray(data);
            if (pixels.length !== expectedBytes) throw new Error('Invalid canvas pixel data');
        },
        async prepare(background: readonly number[], active: () => void,
            tryRaw?: (data: Uint8ClampedArray) => Promise<'declined' | 'encoded'>): Promise<boolean> {
            // Always yield once after the immediate snapshot, even for tiny/opaque frames.
            await yieldTask(true); active();
            if (tryRaw) {
                const outcome = await tryRaw(pixels!);
                active();
                if (outcome === 'encoded') { pixels = undefined; return true; }
                if (outcome !== 'declined') throw new Error('Invalid GIF raw preparation outcome');
            }
            let offset = 0;
            while (pixels && offset < pixels.length / 4) {
                const deadline = performance.now() + budgetMs;
                const endTask = Math.min(offset + taskPixels, pixels.length / 4);
                do {
                    const end = Math.min(offset + blockPixels, endTask);
                    blendRange(pixels, offset, end, background);
                    offset = end;
                } while (offset < endTask && performance.now() < deadline);
                if (offset < pixels.length / 4) { await yieldTask(); active(); }
            }
            return false;
        },
        take(): Uint8ClampedArray {
            if (!pixels || closed) throw new Error('GIF preparation has no frame');
            const owned = pixels; pixels = undefined;
            return owned;
        },
        dispose(): void {
            closed = true;
            pixels = undefined;
            cancelTask?.(); cancelTask = undefined;
            const reject = rejectTask; rejectTask = undefined;
            reject?.(new DOMException('GIF preparation disposed', 'AbortError'));
        }
    };
}
