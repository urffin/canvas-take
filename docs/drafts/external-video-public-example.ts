// DESIGN ONLY: compile with --noEmit. These proposed functions have no runtime implementation.
import {createExternalVideoExporter,createMp4Muxer,createWebmMuxer} from './external-video-public-api.js';
import type {ExternalVideoDestination,ExternalVideoCloseReport} from './external-video-public-api.js';
import type {OfflineVideoOptions} from '@grundyjs/canvas-take/video';

type Inputs = Omit<OfflineVideoOptions, 'muxer' | 'signal'>;

// The application supplies a tested transactional factory bound to its chosen target.
// No file-picker, fs.rename wrapper or in-place writer is implemented by this example.
export async function saveMp4(
    inputs: Inputs,
    destination: ExternalVideoDestination<FileSystemFileHandle>,
    canvas: HTMLCanvasElement,
    draw: (index: number) => void,
    signal: AbortSignal
) {
    // A synchronous throw here means validation/pre-abort; no transaction was acquired.
    const exporter = createExternalVideoExporter({
        ...inputs, muxer: createMp4Muxer({output:'external'}), destination,
        ifExists:'error', signal
    });
    try {
        await exporter.ready;
        const boundary = (index: number) => Math.round(index * 1e6 / 30);
        for (let i = 0; i < 60; i++) {
            draw(i);
            await exporter.addFrame(canvas, {timestampUs:boundary(i), durationUs:boundary(i+1)-boundary(i)});
        }
        const result = await exporter.finish();
        const file: File = await result.output.value.getFile();
        // The caller may read/download it; exporter disposal will not remove the committed file.
        console.log(file.size, result.output.size);
        return result;
    } finally {
        // Also runs if draw() throws before library code has failed the session.
        exporter.dispose();
        const closed = await exporter.closed;
        if (closed.cleanupIssues.length) console.warn('Output cleanup issues', closed.cleanupIssues);
        if (closed.publication === 'indeterminate') console.warn('Reconcile publication before retry', closed.recovery);
    }
}

export interface SavedObject { readonly key: string; readonly readUrl: string }
export function beginReplacement(inputs: Inputs, destination: ExternalVideoDestination<SavedObject>, signal: AbortSignal) {
    // This factory must separately support positioned staging and the requested replacement policy.
    return createExternalVideoExporter({
        ...inputs, muxer:createWebmMuxer({output:'external'}), destination,
        ifExists:'replace', signal
    });
}

export function inspectPublication(report: ExternalVideoCloseReport<SavedObject, 'webm'>): string {
    switch (report.publication) {
        case 'committed': return report.output.value.readUrl;
        case 'not-committed': return 'The owned transaction did not publish; inspect cleanup before retry.';
        case 'indeterminate': return 'Ask the destination backend to reconcile the outcome; do not overwrite automatically.';
    }
}
