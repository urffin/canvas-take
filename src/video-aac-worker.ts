import createModule, { type AacWasm } from 'canvastake:aac-wasm';

// One libavcodec instance per dedicated worker. The only retained PCM is one codec frame.
const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent) => void;
    postMessage(value: unknown, transfer: Transferable[]): void;
};
let module: AacWasm, ctx = 0, frameSize = 0, channels = 0, maxBytes = 0, busy = false;
let sendFrame: ReturnType<AacWasm['cwrap']>, receivePacket: typeof sendFrame, inputPtr: typeof sendFrame;
let packetPtr: typeof sendFrame, packetPts: typeof sendFrame, packetDuration: typeof sendFrame, flush: typeof sendFrame;
scope.onmessage = async ({ data: message }) => {
    const { id, type, data } = message;
    if (busy) { scope.postMessage({ id, error: 'AAC worker command overlap' }, []); return; }
    busy = true;
    try {
        let result: unknown, transfer: Transferable[] = [];
        if (type === 'init') {
            if (ctx) throw new Error('AAC worker already initialized');
            channels = data.channels; maxBytes = data.maxBytes;
            module = await createModule();
            const fn = (name: string, args: string[] = ['number'], result: string | null = 'number') => module.cwrap(name, result, args);
            ctx = fn('init_encoder', ['number','number','number'])(channels, data.sampleRate, data.bitrate);
            if (!ctx) throw new Error('AAC libavcodec initialization failed');
            frameSize = fn('get_encoder_frame_size')(ctx);
            const length = fn('get_encoder_extradata_size')(ctx), pointer = fn('get_encoder_extradata')(ctx);
            if (frameSize !== 1024 || length < 2 || length + 64 > maxBytes) throw new Error('Unsupported AAC frame size/description');
            const description = module.HEAPU8.slice(pointer, pointer + length);
            sendFrame = fn('send_frame', ['number','number']); receivePacket = fn('receive_packet'); inputPtr = fn('get_encode_input_ptr', ['number','number']);
            packetPtr = fn('get_encoded_data'); packetPts = fn('get_encoded_pts'); packetDuration = fn('get_encoded_duration');
            flush = fn('flush_encoder_start', ['number'], null);
            result = { frameSize, description }; transfer = [description.buffer];
        } else {
            if (!ctx) throw new Error('AAC worker not initialized');
            if (type === 'frame') {
                const pcm = data.pcm as Float32Array;
                if (!(pcm instanceof Float32Array) || pcm.length !== frameSize * channels || pcm.byteLength > maxBytes || !Number.isSafeInteger(data.sampleOffset) || data.sampleOffset < 0) throw new Error('Invalid AAC worker PCM');
                const pointer = inputPtr(ctx, pcm.byteLength);
                if (!pointer) throw new Error('AAC input allocation failed');
                module.HEAPU8.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pointer);
                const status = sendFrame(ctx, BigInt(data.sampleOffset));
                if (status < 0) throw new Error(`AAC encode error ${status}`);
            } else if (type === 'flush') flush(ctx);
            else throw new Error('Unknown AAC worker command');
            const packets = []; let size = 0, retained = 0;
            while ((size = receivePacket(ctx)) > 0) {
                retained += size + 64;
                if (retained > maxBytes || packets.length >= 4) throw new RangeError('AAC maxPendingBytes/output count exceeded');
                const pointer = packetPtr(ctx), bytes = module.HEAPU8.slice(pointer, pointer + size);
                packets.push({ sampleOffset: Number(packetPts(ctx)), samples: packetDuration(ctx), data: bytes }); transfer.push(bytes.buffer);
            }
            if (size < 0) throw new Error(`AAC receive error ${size}`);
            result = { packets };
        }
        scope.postMessage({ id, result }, transfer);
    } catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []); }
    finally { busy = false; }
};
