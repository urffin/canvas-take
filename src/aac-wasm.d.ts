/** ABI of the pinned @mediabunny/aac-encoder 1.65.0 libavcodec build. */
declare module 'canvastake:aac-wasm' {
    export interface AacWasm {
        HEAPU8: Uint8Array;
        cwrap(name: string, result: string | null, args: string[]): (...values: (number | bigint)[]) => number;
    }
    export default function createModule(): Promise<AacWasm>;
}
