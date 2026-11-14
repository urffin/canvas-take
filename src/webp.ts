/** Offline animated WebP export with a caller-selected encoder. */
export { createWebpController as createWebpExporter } from './internal/webp-controller.js';
export type {
    WebpFrame, WebpExportLimits, WebpEncoderContext, WebpFrameEncoder, WebpEncoderFactory,
    WebpExportState, WebpExportProgress, WebpExportOptions, WebpExporter
} from './internal/webp-types.js';
