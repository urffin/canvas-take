declare module 'canvastake:apng-codec' {
    const codec: { encodeLL(buffers: ArrayBuffer[], width: number, height: number, colors: number,
        alpha: number, depth: number, delays: number[], metadata: { loop: number; sRGB: number }): ArrayBuffer };
    export default codec;
}
