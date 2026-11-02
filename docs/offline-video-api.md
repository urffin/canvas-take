# Offline video API and adapter protocol

Status: controller and first real video-only adapters implemented, unreleased (2026-11-02). `src/video.ts` and `/video` implement this protocol. Separate `/video/webcodecs` and `/video/mp4` providers export actual H.264 Baseline MP4 without audio; see [adapter usage, limits and verification](offline-video-adapters.md). The [contract reference](drafts/offline-video-api.d.ts) re-exports the canonical declarations; the [narrated usage example](drafts/offline-video-example.ts) remains compile-only because actual offline audio is still future work. This is an API specification, not the personal development roadmap.

## Goal and scope

Export a supplied timeline to a complete video file, with optional prepared audio, regardless of rendering/encoding speed. The first integration target is portrait MP4 H.264/AAC for Shorts; WebM VP8/Opus follows using the same controller. Codec and container implementations are separate, caller-selected adapters. There is no implicit codec choice, real-time capture, audio device or MediaRecorder dependency in the offline controller.

The existing recorder and GIF APIs keep their own lifecycles. `/video` is the controller entry point and bundles no codec, muxer, FFmpeg or Worker implementation. `/video/webcodecs` supplies a native video encoder factory; `/video/mp4` separately bundles Mediabunny 1.65.0 as a video-only MP4 writer. These remain optional, independently replaceable factories. Real audio encoding/container trim integration remains future work.

The first version accepts fixed-size 2D HTMLCanvasElement/OffscreenCanvas frames and one prepared PCM audio track. Native VideoFrame input, multiple tracks, mixing, resampling, arbitrary gaps, B-frame reordering, streaming file sinks and HDR are deferred. This bounds the first implementation without tying the adapter interfaces to WebCodecs objects.

## Main API

```ts
const exporter = await createOfflineVideoExporter({
    video: { encoder: myVideoEncoderFactory, config: videoConfig },
    audio: { encoder: myAudioEncoderFactory, config: audioConfig,
        source: preparedNarration, endPolicy: 'trim-or-pad' }, // optional
    muxer: myMp4MuxerFactory,
    signal,
    maxFramePixels: 1080 * 1920,
    maxFrames: 300,
    maxDurationUs: 10_000_000
});
try {
    for (let i = 0; i < 300; i++) {
        draw(i);
        const start = Math.round(i * 1_000_000 / 30);
        const end = Math.round((i + 1) * 1_000_000 / 30);
        await exporter.addFrame(canvas, { timestampUs: start, durationUs: end - start });
    }
    const result = await exporter.finish();
    // result: blob, MIME, extension, actual codec strings, durationUs, frame/sample counts.
} finally {
    exporter.dispose();
}
```

Initialization is asynchronous because support checks, Worker startup or codec configuration may be asynchronous. `addFrame` returns a promise but snapshots the canvas before its first asynchronous yield, as the GIF API does. Await each operation before the next one. There is no `start`, `pause`, `resume`, timer-driven duration limit or automatic finish: the producer controls time by submitting intervals and finishes explicitly. A UI may simply stop feeding frames without adding time to the output.

One exporter owns one file. `finish()` drains and finalizes; repeated calls return the same promise/result, including while finalizing. It rejects for zero frames. Once finish is requested, adding frames rejects. Concurrent addFrame calls or finish during an addFrame reject without cancelling the accepted operation. A failed/aborted/disposed session cannot be restarted; a fresh session is required.

## Timeline rules

- All `*Us` fields are integer microseconds; input timestamps are nonnegative safe integers, durations are positive safe integers, and every sum must stay safe. GIF's 10 ms rounding is not used.
- The first video frame starts at zero; later timestamps must equal the preceding frame's end. Reject gaps, overlaps, resizes or invalid sums before reading pixels. No implicit black frames, trimming or re-timing.
- Variable frame durations are part of the contract. `frameRateHint` is an encoder hint, not a source of timestamps. A long final hold is the last frame's explicit duration; adapters unable to preserve it must reject rather than invent a duration. A future CFR helper can explicitly render repeated frames instead.
- For fractional rates use absolute rounded boundaries, e.g. `round(i * 1e6 * denominator / numerator)`, then subtract adjacent boundaries. Validate the arithmetic; do not repeatedly add a rounded frame duration.
- Requested presentation duration is the final video frame's end. Muxers rescale absolute boundaries to container ticks and derive their deltas, avoiding cumulative rounding. Container duration must agree within one chosen container tick, with at most one audio sample of end quantization. Distinct positive frame intervals must remain positive after rescaling; if a container timescale cannot represent them, fail rather than collapse them. Encoder priming and padding must not create visible startup/tail material.
- Runtime speed and CPU load may change completion time and compressed bytes, but not the supplied presentation timeline. Bit-identical encoding across machines or hardware codecs is not promised.

Input frames are snapshotted as owned sRGB RGBA8, composited against `background` (default white), with fixed configured dimensions. No implicit resize, rotation, alpha preservation or color-profile conversion beyond the declared SDR policy. The encoder describes its actual output color metadata; the muxer must preserve it. The first MP4 adapter profile must verify SDR color handling, even dimensions where required, and decoder compatibility rather than silently padding/cropping.

## Prepared audio and synchronization

`PreparedAudio` is planar Float32 PCM with equal, nonempty channel lengths and finite samples in [-1, 1]. SharedArrayBuffer-backed or detached PCM input is rejected. The sample rate/channel count must match the explicit audio config; resampling/mixing/normalization belongs to the caller or a future separate helper. The controller validates and copies the entire source synchronously before the first initialization await. Later caller mutations cannot change the export. Live MediaStreamTrack and AudioContext inputs are not accepted.

The first sample starts at timeline zero. A block's exact position is `sampleOffset / sampleRate`; its microsecond timestamp is derived from that absolute sample index, never accumulated from rounded block lengths. The controller owns interleaving: after each accepted video interval it feeds audio up to that interval's end in bounded blocks. Callers do not need to enqueue the whole audio track first or coordinate two producers. The last audio sample count is `round(videoEndUs * sampleRate / 1e6)`; safe arithmetic is required.

The implementation uses integer arithmetic for sample/timestamp rescaling, blocks of at most 2,048 samples, and periodic task yields during long audio intervals. A requested audio track must contain at least one presentation sample by finish.

`endPolicy` is mandatory when audio is present:

| Policy | Behavior |
| --- | --- |
| `error` | Reject if the prepared sample count differs from the sample-quantized video duration. Short audio fails as soon as the next frame would exceed it; extra audio fails at finish. |
| `trim-or-pad` | Discard source samples beyond the video endpoint, or append PCM silence if narration is shorter. These changes are explicit, not inferred from codec availability. |

There is no delayed-track offset in the first version; prepare leading silence externally. Audio encoders report the presentation sample count and leading/trailing discard counts in their end event. The muxer must express those trims in the container and align the first audible input sample with zero. Raw packet timestamps can be signed to represent codec delay; they must not be independently rebased per track. The controller validates that presentation sample counts match its submitted timeline.

An AAC adapter must establish reliable priming/padding behavior before claiming support. If the chosen backend cannot report or otherwise verifiably account for it, that combination is unsupported for this contract. Do not guess zero delay. This is a key integration question for the initial WebCodecs/AAC adapter, not a promise that every browser can produce an exact-audio MP4.

## Encoder and muxer contracts

See the declaration file for all types. Video and audio factories are separate, so an application can combine different implementations. Every successful `create` returns a fresh exclusively owned instance. A supplied factory is caller-owned and is never disposed; its created instances are exporter-owned.

`checkSupport` checks the exact codec string, packet framing, dimensions, rate/channel configuration and applicable protocol guarantees, returning either supported or an explicit reason. The muxer checks the requested combination before instances are allocated. Replacing AAC with Opus or MP4 with WebM is never automatic. A check is not a reservation: resource allocation or later encoding may still fail. Native WebCodecs capability checks alone do not establish container compatibility or priming accuracy.

Initialization order is: validate/snapshot inputs and options; check all providers; create muxer; create video encoder; create audio encoder if requested. The muxer instance exists before encoder callbacks can produce output. No encoder may emit media until its first input is submitted; initial config/error callbacks are allowed. If any create fails, clean up all previously created instances. Factories must clean up their own partially constructed instances when rejecting.

Each encoder gets an `EncoderContext` containing an internal AbortSignal, queue budgets and `CodecOutputSink`. Its event sequence per track is:

```text
config → packet* → end
```

- Config contains the actual codec/framing, decoder description bytes and dimensions or audio parameters. Equivalent config repeats are allowed; incompatible midstream changes fail. Config must precede packets requiring it, including when the first config arrives only with the first encoded output.
- Packets carry owned bytes, track, presentation timestamp, decode timestamp, duration and key/delta type. The first video packet must be a key frame. Initial support requires one access unit per input video frame, no dropped frames, and PTS=DTS with monotonically increasing video timestamps. The explicit decode timestamp field reserves a clear future extension; v1 rejects reordering rather than inventing DTS from frame rate or sorting compressed packets.
- A first encoder profile must establish no-reordering behavior, not infer the absence of B-frames from callback order alone. If native output omits duration, the adapter recovers it from the corresponding submitted frame interval rather than guessing from frameRateHint.
- Audio packets may include declared priming/padding outside the presentation interval; discard counts describe it. Packet time and duration must agree with the encoder's sample accounting. Do not conflate encoded packet duration with audible content duration.
- `encodeFrame`/`encodeAudio` resolve after consuming or independently retaining the input, and honor queue backpressure; they need not have emitted a packet yet. Input buffers cannot be retained after resolve unless independently copied/transferred under adapter ownership. A core-provided frame/block is exclusive, so a Worker adapter may transfer it; retained PCM source planes must never be transferred.
- `flush()` is only an end-of-track operation. It emits every delayed output and exactly one end event, then waits for all output writes to settle. It must not wait for a future frame that the controller can no longer submit.
- Late codec/Worker errors call `output.fail(error)`, even when no public operation is pending. That immediately terminally fails the exporter; a later operation must not hang waiting for a lost callback.

`CodecOutputSink.write` returns a promise after serial muxer consumption. Buffers are borrowed until that promise settles: the controller copies a view before deferring work, or otherwise pins its storage, before the adapter can reuse it. A WebCodecs output callback cannot simply return an async promise and expect the browser to await it. The adapter must bridge callbacks to an owned bounded queue, drain it independently, and include those writes in flush/error handling. Do not drop output or wait inside a native callback for the producer to advance.

The controller serializes muxer writes across both tracks. Arrival order across tracks is not guaranteed; the muxer owns interleaving and rescaling. `write()` must consume/copy or buffer within its budget and return without waiting for a future track packet. This prevents an audio/video interleaving deadlock. If an adapter cannot operate within a supplied bound it rejects or fails, never buffers without limit.

The audio/video input scheduler advances in short bounded audio blocks up to the current video interval, with video and audio encoder progress independent of output draining. Empty output from an encode call is valid. Delayed codecs may need later inputs to produce output, so accepting input and waiting for a matching packet must remain separate. An encoder whose minimum look-ahead cannot fit the supplied budgets must reject that configuration rather than wait forever for an input the budget prevents submitting.

## Finish, cancellation and ownership

Finish validates the final timeline/audio policy, supplies any final padded/trimmed audio block, flushes both encoders while continuing output draining, waits for both end events and all serial muxer writes, then calls `muxer.finalize(timeline)`. An implementation may flush encoders concurrently; it must keep the consumer running and preserve per-track order. Finalize receives duration, input video-frame count and presentation audio-sample count, and returns one complete Blob. Validate format/size and return immutable result metadata, then dispose owned instances.

The result reports the requested presentation duration and actual codecs/container; it must never use elapsed wall time or a captured startup offset. A format mismatch is an error, not a renamed extension. `finalize` has no implicit transcode step.

The internal signal is aborted on caller cancellation, disposal or terminal failure. Pending creation, encode, flush and finalization promises race cancellation. Abort settles the public operation promptly with the caller's signal reason (or AbortError); dispose uses AbortError. `dispose()` is synchronous and idempotent. Each acquired instance is disposed once on success/failure/cancellation. Cleanup exceptions do not replace the primary failure.

A factory resolving after cancellation must have its late instance disposed immediately. Suppress late packets/progress and attach rejection handlers to detached work. No partial Blob is returned. Native operations already executing may take time to release internal resources; prompt promise rejection is not a guarantee of instantaneous native cancellation. Caller canvases, PCM arrays and factory objects remain usable. Every temporary canvas snapshot, transferred buffer, codec object, Worker and muxer buffer created for the session has an explicit owner.

## State, progress, limits and errors

| State | Allowed operation |
| --- | --- |
| Before async creation resolves | Caller can abort via signal; no exporter exists yet |
| `ready` | addFrame, finish, dispose |
| `encoding` | dispose/abort; another addFrame or finish rejects |
| `finalizing` | repeat finish returns the same promise; dispose/abort |
| `finished`, `failed`, `aborted` | dispose; finished also permits repeat finish |
| `disposed` | repeat dispose only |

Progress phases are initializing, encoding, finalizing and terminal outcomes. Frozen snapshots report framesAccepted, current video interval end, audioSamplesAccepted, packets successfully consumed by the muxer and encoded payload bytes. Accepted input does not imply encoding/container finalization is complete. Audio progress counts presentation input, excluding codec padding. `totalFrames` is a positive safe-integer display hint, not a limit. `outputBytes` is known only at successful finish in v1. No initial percentage/ETA or finalizing-at-100% guarantee is invented. Observer exceptions are ignored; signal cancellation from an observer is honored.

Limits are positive safe integers, snapshotted at creation. maxFramePixels, maxFrames and maxDurationUs are inclusive; exceeding one rejects before reading/submitting the rejected frame and terminally cleans up. There is no automatic finish at a limit. maxAudioInputBytes validates the source before copying. maxOutputBytes is passed to the muxer and checked against the finalized Blob; a muxer checks its actual growing output when possible, not a guessed compression ratio. It is an output-size bound, not an exact heap bound.

Default maxPendingInputs is 4 per encoder; default maxPendingBytes is 16 MiB per adapter and for the controller's pending output queue. This bounds outstanding work, not total resident memory. Native codec allocations, the retained PCM snapshot and the growing in-memory output are separate. Output retained by a muxer is charged to maxOutputBytes, while not-yet-consumed/interleaving packets count against maxPendingBytes. Caller-raised limits remain finite safe integers. Limits other than those queue defaults are opt-in. A packet exceeding the queue-byte budget fails rather than waiting forever for space that cannot exist.

The controller additionally caps submitted video intervals whose packets have not arrived at maxPendingInputs. When that look-ahead bound is reached, the next frame rejects before readback instead of waiting for an output that might require that very input. Adapters should hold input acceptance while independently drainable work is pending, or require a larger declared look-ahead bound. Audio codec internal input limits remain the audio adapter's responsibility; the controller submits one bounded audio block at a time. The pending output queue charges payload/description bytes plus a 64-byte reservation per event, bounding even empty configuration/end events. A raw RGBA snapshot must itself fit maxPendingBytes before readback. These are conservative work budgets, not native heap accounting.

Invalid arguments use TypeError/RangeError; exceeded limits use RangeError naming the option. As creation is asynchronous, invalid initialization arguments reject its promise. Initialization support failures use NotSupportedError with the failing codec/container and reason. Operational failures identify encoder/muxer/protocol origin and preserve their cause; a concrete exported error class is deferred until implementation. Validation/support failures before allocation leave no instances; mid-session failure is terminal. State misuse rejects without cancelling a valid pending operation. Any first failure wins over cleanup and late callbacks.

## First adapter profile and acceptance criteria

The first target uses caller-selected H.264 (`avc` framing), AAC LC (`aac` framing) and an MP4 muxer. Decoder descriptions must be carried to the muxer, not reconstructed from MIME. Browser-specific resource support, no-reordering output, AAC priming and sample trimming must be independently verified. A preset may return these providers/configs later, but the controller always accepts replacements. A WebM/VP8/Opus combination exercises the same protocol and trim accounting rather than special branches in the controller.

Implementation acceptance checks:

1. Fake delayed encoders/muxers validate zero-output encode calls, final flush output, late config, asynchronous failures, no drops, per-track order, serial muxing, queue caps and no deadlocks.
2. Invalid timestamps, gaps/overlaps, dimension changes, fractional-rate rounding, every inclusive limit and rejection-before-readback are covered. Adding artificial render/encode delays changes wall time but not file sample counts or timestamps.
3. Partial initialization, abort before/during every await, late factory resolutions and abort during finalization release each acquired instance once and settle pending operations. Source PCM/canvas survive success/failure/transfer/disposal; observers cannot corrupt counters.
4. Real files are independently demuxed/decoded: first presentation at zero, exact frame count and supplied frame intervals, final hold, requested container/codecs, presentation audio samples, priming/tail trims, A/V markers, and duration within container/sample quantization. Decode full file including the last chunk; include negative offset/drift controls.
5. Silent video, strict narration mismatch, explicit trimming/padding, 44.1/48 kHz sample boundaries and unsupported AAC are explicit cases. Unsupported formats never silently switch. Full-file/container timing is checked directly, unlike real-time recorder tests that must account for capture startup material.
6. Importing the controller loads no codec/muxer and touches no browser globals. A packed TypeScript consumer, direct browser loading, Worker ownership and a bundled consumer are verified once actual adapters exist.

The controller/protocol is covered by `test/offline-video.test.mjs`, including delayed output, sample-clock timing, explicit trim/pad, bounded queues, protocol failures, byte transfer, late factory resolution and cancellation at all asynchronous stages. Browser fixtures exercise actual canvas readback and disposal in Chromium/Firefox. In addition, `test/browser/offline-video-real.spec.mjs` independently demuxes and decodes real silent H.264/MP4 files using FFmpeg, checks variable/fractional timing, final hold, colors, container duration, native cancellation and retry. The packed consumer checks all three public entries without browser globals. AAC priming accuracy and real audio integration remain the next implementation stage.

## Typecheck and references

```sh
node node_modules/typescript/bin/tsc -p docs/drafts/tsconfig.json
```

The proposal uses microsecond packet time and explicit output draining in line with [WebCodecs](https://www.w3.org/TR/webcodecs/). AVC packet framing/decoder description and AAC framing/priming require codec-specific handling; see the [AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/) and [AAC registration](https://www.w3.org/TR/webcodecs-aac-codec-registration/). These sources specify codec interfaces, not a universally supported MP4 export pipeline. The packet ordering, memory budgets and public controller behavior above are CanvasTake design decisions.
