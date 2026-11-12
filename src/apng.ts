/** Offline transparent APNG export with a caller-selected encoder. */
export { createApngController as createApngExporter } from './internal/apng-controller.js';
export type {
    ApngFrame, ApngEncoderContext, ApngFrameEncoder, ApngEncoderFactory,
    ApngExportState, ApngExportProgress, ApngExportOptions, ApngExporter
} from './internal/apng-types.js';
