export const sampledPaletteMode = 'sampled-v1';
export const sampledPaletteAction = 'palette-sample-v1';
export const unsupportedSampledPalette = 'unsupported-sampled-palette';

export const sampledPaletteCodecRequest = Symbol.for('@grundyjs/canvas-take/gif/sampled-palette-codec-request/v1');
export const sampledPaletteInstall = Symbol.for('@grundyjs/canvas-take/gif/sampled-palette-install/v1');
export const sampledPaletteWorkerSource = Symbol.for('@grundyjs/canvas-take/gif/sampled-palette-worker-source/v1');

export function readGifPrivateOption(options: object, key: symbol): PropertyDescriptor | undefined {
    try { return Object.getOwnPropertyDescriptor(options, key); } catch { return undefined; }
}
