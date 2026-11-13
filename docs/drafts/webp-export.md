# WebP controller and Worker adapter: proposed contract

Status: **private controller and libwebp Worker integration implemented**, 2026-11-13, after
`f0bebc1cddcc94575d37f9797ed8d9abb9af6631`. See the [controller verification](webp-controller-verification.md)
and [Worker integration report](webp-worker-verification.md).
The [libwebp backend proof](webp-libwebp-backend.md) establishes limited codec feasibility;
it does not implement this controller, adapter, protocol or asset deployment. The
[draft declarations](webp-export-api.d.ts), [typechecked sketch](webp-export-example.ts) and
[acceptance gates](webp-export-compatibility.md) define the implementation boundary. Controller
contracts, supplied adapter, transport and tagged assets now have private implementations. Local
Chromium/Firefox checks are recorded in the report; installed public WebP/Next gates remain open.
No WebP imports are available through the package
exports in version 0.7.0.

## Responsibilities and selected first implementation

| Component | Owns | Does not own |
| --- | --- | --- |
| Private controller | Canvas snapshot, admission, logical limits/timeline, state, progress, cancellation reason, output-envelope validation and Blob | Codec selection, quality, compression percentage, decoding pixels |
| Required encoder factory | One fresh owned encoder with `addFrame`, `finish`, `dispose`; may be third-party | A shared global session or asynchronous acquisition outside the owned instance |
| Supplied Worker factory | libwebp settings, one dedicated module Worker, request timers, transfer and initialization | Caller buffers, browser tabs, a Worker pool or another export's Worker |
| Worker runtime/backend | Owned batch snapshots, WASM module/native allocations, complete animated WebP | Controller progress or authority to retract a host cancellation |

Follow the existing APNG admission/lifecycle model, keeping WebP policies local. Do not turn
GIF/APNG into a format switch or extract a universal controller/deferred/ownership mechanism.
The calling-thread controller must import no supplied codec, WASM or Worker runtime. A custom
factory can accept/compress incrementally or retain a batch; its acknowledgement always means
acceptance, so the controller does not infer compression from it.

**Choose a batch supplied Worker first.** It validates and retains transferred frames, acknowledges
them, and calls the proved batch codec at finish. This matches the tested prototype and exposes
its memory cost honestly. The C ABI could support incremental adds, but persistent native state
across asynchronous frame messages is a later implementation choice with separate resource tests.
No automatic fallback to a calling-thread codec, alternate format or legacy Worker is planned.

## Image, timing and output contract

The format basis is RIFF/WEBP, animation control plus frame chunks, millisecond frame durations,
16-bit loop metadata and `image/webp`. See the primary
[WebP container specification](https://developers.google.com/speed/webp/docs/riff_container) and
[RFC 9649](https://www.rfc-editor.org/rfc/rfc9649.html). The following narrower rules are
**CanvasTake design choices**, not a claim that all valid WebP files follow this profile:

| Topic | Decision |
| --- | --- |
| Input | Complete independent, fixed-size straight-alpha sRGB RGBA8 canvas snapshots |
| Dimensions | Integer width/height 1..16383; first acknowledged frame fixes the size |
| Input delay | Integer 1..16777215 ms per snapshot, exact, without fps inference or GIF rounding |
| Timeline | Concatenate input holds; preserve the image throughout every input interval and the final hold |
| Plays | Total plays, 0 infinite (default), 1 once, maximum 65535; not GIF repeat or decoder repetition count |
| Encoded frames | May merge identical holds or split equivalent holds; count need not equal accepted snapshots |
| One snapshot | Animated output retaining duration/plays metadata; no silent static-WebP fallback |
| Empty finish | Fatal RangeError; no partial output |
| Output | Complete immutable Blob, MIME `image/webp`, suggested filename `.webp` |

For example, input `A:50, B:70, B:90, C:200` may encode as `A:50, B:160, C:200`.
Both have four accepted snapshots, 410 ms duration and the same presentation. A long merged hold
may need multiple container frames; `maxFrames` limits submitted snapshots, not encoded packets.
Splitting/merging cannot change colors, transparency, interval edges at which the image changes,
plays or total duration. Native frame-count equality is therefore not a WebP compatibility gate.

The initial supplied libwebp profile uses full keyframes and the two disclosed single-frame
guards from the proof. It must retain exact alpha, including transparent erasure. Lossless mode
preserves captured RGB where alpha is nonzero; hidden RGB at alpha zero is not guaranteed.
Lossy mode permits RGB differences, while the supplied adapter keeps alpha at full quality.
Quality/method/lossless options belong to that adapter, never the generic controller. Partial-alpha
lossy behavior and long-hold splitting still need explicit integration fixtures; the proof did
not certify every possible codec/disposal optimization.

Canvas readback itself can convert/round colors. Compare decoded output to the captured snapshot,
not to ideal drawing commands or pixels preceding the canvas round trip. Viewer clamping of short
delays remains a viewer property; never rewrite file timing to match a browser's clamp.

## Limits and admission order

| Option | Proposed default | Accounting |
| --- | ---: | --- |
| `maxFramePixels` | 4,194,304 | Inclusive `width * height` for each snapshot |
| `maxFrames` | 1000 | Inclusive committed frames plus the one pending reservation |
| `maxDurationMs` | 2,147,483,647 | Inclusive sum of logical input delays |
| `maxInputBytes` | 67,108,864 (64 MiB) | Inclusive cumulative raw `width * height * 4`, including pending admission |
| `maxOutputBytes` | 33,554,432 (32 MiB) | Complete encoded file, independently checked by adapter and controller |

Each limit accepts an integer in 1..2147483647; the dimension and per-frame-delay ceilings also
apply. The total-duration ceiling avoids the supplied binding's signed timestamp overflow.
These are proposed WebP defaults; no GIF/APNG/video default changes. All normalized limits are
passed in a frozen `context.limits` to the encoder, so the Worker cannot silently use a different
raw budget when the controller is configured differently. A codec can fail on its own memory or
capability limits even when these logical budgets permit the job.
The Worker maps `maxFramePixels` to the proof's private `maxPixels`, `durationMs` to `duration`,
and creates a Uint8Array view over its exclusively owned clamped RGBA buffer for the proved codec.
That view adds no pixel copy or new budget charge. Every other normalized limit is forwarded
explicitly; the proof's default values must not override controller configuration.

`totalFrames` is only a positive safe-integer display hint, not a limit, a preallocation request
or a required finish count. It neither raises other budgets nor defines a reliable percentage.

Admission order is fixed for review/tests:

1. Reject a terminal or overlapping operation without touching its canvas. Set `adding` for the
   admitted call before any user-controlled getter/readback can reenter.
2. Check delay, dimensions/overflow/fixed size, pixel/count/duration/raw budgets, in that order.
   Reserve private count/duration/raw bytes before readback; published counters do not move yet.
3. Read the complete 2D canvas synchronously with explicit sRGB, require RGBA8 and exact byte length,
   and allocate a fresh full-span `Uint8ClampedArray` before the first yield. Tainted canvas/readback
   errors are fatal. Do not flatten transparency or route this path through the shared RGBA blender.
4. Yield a task/check cancellation, then invoke the encoder exactly once. The encoder takes
   ownership at invocation. After its acknowledgement, recheck terminal state and commit totals.
5. Emit `collecting`, recheck cancellation/reentrancy, then return to `ready`. Clear local pixel and
   canvas references in finally, including invocation closures that retained error stacks could keep.

Reservations protect pending work. A transferred frame remains charged; streaming encoders do
not get raw-budget refunds. No second admission can consume that reservation. A rejected input
or backend failure terminates the session, releases owned work and returns no partial file.
Overlapping-operation errors alone do not kill the already admitted operation.

Raw/output budgets do not bound total memory. A batch Worker retains all raw snapshots, codec
scratch and output; transfer removes a main-thread copy but does not reduce cumulative accounting.
WASM high-water capacity, validation copies and Blob storage add memory. The output cap may only
be enforceable after native assembly; it does not prevent that transient allocation.

## State, promises and progress

| Event | State/result |
| --- | --- |
| Construct | Validate options and pre-abort; acquire one fresh encoder synchronously; `ready` |
| Add | `ready -> adding -> ready`, or first terminal failure/cancel |
| Finish | `ready -> finalizing -> finished`, or first terminal failure/cancel |
| Abort | Any unfinished state -> `aborted`; reject pending work with the selected reason |
| Dispose | Idempotent teardown; unfinished work -> `disposed`; no further admission |

No operation queue or restart on the same exporter is proposed. `ready` means no public operation
is pending, not that asynchronous WASM initialization has completed. Repeated finish in finalizing
or finished returns the **same Promise object**, installed before the finalizing observer can reenter.
Calls during an add reject independently. A fresh exporter is required for retry.

Success is committed before cleanup/finished notification. Dispose from that notification cannot
retract the Blob or the cached successful promise; future finish calls after disposal reject.
Dispose after an already terminal result changes the visible state to disposed and performs
idempotent cleanup, without a second terminal progress event or replacing the earlier result/reason.

Progress snapshots are fresh, shallow frozen and created only when an observer exists:

- Always: `phase`, `framesAccepted`, `durationMs`, `inputBytesAccepted`.
- `totalFrames` exists only when configured. `outputBytes` exists only for successful `finished`.
- Phases: `collecting`, `finalizing`, `finished`, `failed`, `aborted`, `disposed`.
- No constructor/init notification, native percentage, encoded-frame counter or implied streaming.
- Observers run synchronously; synchronous exceptions are ignored. Returned promises are not awaited
  or assimilated; callers own errors from their asynchronous observer work.

Counters advance only after acknowledgement **and** an active-state check. An abort between ack
and that commit leaves them unchanged even if the Worker received the input. Abort from the
collecting observer happens after commitment: the add can reject with counters already advanced.
No rollback/reset-to-zero is reported. Reentrant calls see adding/finalizing; a callback can produce
a nested terminal report when it aborts. Terminal guards apply again after each callback.

For 1×1 frames with delays 55 and 2000, the normal `(phase, frames, ms, rawBytes)` trace is
`collecting,1,55,4 -> collecting,2,2055,8 -> finalizing,2,2055,8 -> finished,2,2055,8`.
The last snapshot additionally contains the Blob size. Merging the two images does not change it.
`finalizing` includes compression, final timestamp/assembly, validation and Blob creation. A UI
can show admitted snapshots against the hint while collecting, then an indeterminate finalizing
state; the last accepted input must not be presented as a completed export or reliable 100%.

## Ownership and cancellation

| Storage | Owner and end of lifetime |
| --- | --- |
| Caller canvas/readback arrays | Caller; never transferred, detached or retained after the call settles |
| New snapshot | Controller until encoder invocation; encoder exclusively thereafter, even on rejection |
| Transferred RGBA buffer | Dedicated Worker; metadata is copied/validated, not read later from mutable caller objects |
| WASM input/pictures/session/output | Backend; cleanup on normal completion/native errors/cooperative abort |
| Encoder result bytes | Exclusive complete-file result; controller copies the exact view before yielding validation |
| Blob | Caller; remains valid after exporter disposal; caller owns object URLs/revocation |

Freeze metadata/context objects, not typed-array elements. `readonly` does not enforce physical
ownership. The encoder may transfer/retain snapshots but must not use caller-owned aliases or let
them escape after cleanup. Input arrays must span one ordinary ArrayBuffer exactly: offset zero,
byte length equal to both RGBA size and buffer size, no SharedArrayBuffer/detached/foreign tail.
There is no automatic retry after handoff or transport failure. Controller/adapter clear their
references rather than attempting to read/reclaim a detached input.

The controller owns an internal AbortController and races pending adapter work against cancellation.
Preserve the external `signal.reason` with a nullish AbortError fallback. First **controller-observed
terminal outcome** wins. Input/readback/limit errors keep identity; factory/add/finish exceptions
become component-specific Errors with the original value as cause. Transported Worker errors can
preserve name/message, not arbitrary cross-realm cause identity. Local cancellation reasons are not
posted to the Worker, so their identity can be retained. Cleanup throws/late rejections cannot win.

Register cancellation before acquiring the encoder; release a returned instance even if the factory
aborts reentrantly. Reject async factories, observe their eventual rejection, and dispose any late
owned instance without waiting. Own each encoder's disposal exactly once; its method must itself
be idempotent and nonblocking while init/add/finish is pending.
An unexpected promise returned by cleanup is observed for rejection without awaiting it;
this cannot enforce timely release by a nonconforming third-party implementation.
Recheck cancellation after acquiring a Worker/module/native handle; a handle returned after
reentrant cancellation must be released rather than used to start another request.

The supplied adapter cancels by removing listeners, rejecting pending requests with its first local
reason, clearing timers and terminating its Worker. An in-band cancel message cannot interrupt a
synchronous WASM call blocking that Worker's event loop. Cleanup after hard termination is isolate
teardown, not execution of every C destructor. Callback-free hot-loop interruption/physical RSS
return are not established by the existing paused-callback proof and must not be advertised.
Native progress/SAB probes are test instrumentation; no SAB/COOP/COEP requirement is proposed.

Main-thread readback, snapshot/output copies, Blob construction and a custom synchronous encoder
cannot be preempted by a Promise race. Do not promise constant cancellation latency. Late fetch,
initialization, ack, output or error after termination must be ignored/observed without new progress,
success, resource acquisition or an unhandled rejection.

## Worker protocol and assets

The private transport is separate from existing GIF/APNG/AAC runtimes:

| Request | Meaning of successful matching reply |
| --- | --- |
| `{format:'webp', version:1, id, action:'init', value:{plays,limits,codec,wasmUrl}}` | WASM loaded, ABI/profile validated, runtime accepts one owned export |
| `{format:'webp', version:1, id, action:'frame', value:ownedFrame}` with its buffer transferred | Frame validated/retained and all Worker-side budgets charged, not compressed |
| `{format:'webp', version:1, id, action:'finish'}` | Complete independent Uint8Array returned after native cleanup, with exact output span transferred |

Replies echo format/version/id/action. Init also identifies a binding ABI and the
`libwebp-batch-animation-v1` profile (including single-frame metadata support). A profile tag/ABI
check is now verified in the private native binding; codec version 1.6.0 alone cannot distinguish
the patched policy. These are compatibility tags, not cryptographic proof of correct pixels.
The current proof runtime/untagged messages are not reusable as this protocol without adaptation.
The initial success shapes are init `value:{bindingAbi:1,profile:'libwebp-batch-animation-v1'}`,
a bare matching frame acknowledgement, and finish `bytes:Uint8Array`. An error uses
`error:{name:string,message:string}` instead of a success body; mixed success/error bodies fail.
Unrecognized extra fields cannot commit progress or change these meanings. Init's wasmUrl is an
absolute string; runtime validates options/budgets before starting its fetch/native acquisition.

IDs are positive monotonic safe integers; one live operation is reserved before waiting for init.
Install the pending request and its timer before postMessage can reenter or throw.
Runtime rejects duplicate/out-of-order requests and revalidates metadata, input buffer, fixed size
and every normalized budget. Host rejects malformed matching replies, wrong tags/actions/profile,
error/messageerror, postMessage failure and output type/budget violations. Unknown/late IDs are
ignored, never acknowledged as current work or used to reset a timer. No progress messages are
needed for the first protocol. Never silently negotiate down to a static/legacy encoder.

`timeoutMs` defaults to 30000, finite in `(0,2147483647]`, per posted init/frame/finish request.
Waiting for init consumes the init deadline; a frame deadline starts when that frame is posted.
It is not an overall export deadline. No unbounded queue, idle watchdog or retry is implied.
Initialization starts inside an acquired encoder and observes its own rejection even when idle.
An idle init failure closes/memoizes the adapter error; without a pending public call, the controller
has no notification channel and reports it on its next operation that reaches the adapter. An
earlier input-validation failure or controller abort can therefore be its first observed terminal
outcome. This is not an asynchronous factory contract.

`createWebpWorkerEncoder` only validates/captures configuration and returns a factory. Each invocation
owns a fresh module Worker. Proposed adapter fields are workerUrl, wasmUrl, timeoutMs and libwebp
lossless/quality/method (defaults true/100/4; quality finite 0..100, method integer 0..6).
The calling thread must not import/instantiate the WASM codec.

Default asset expressions in the private adapter are literal module-relative
`new URL('./webp-worker-runtime.js', import.meta.url)` and
`new URL('./webp-codec.wasm', import.meta.url)`. Resolve both on the calling thread and send the
absolute WASM URL in init; a relative override uses document.baseURI on the calling Window, or
the calling Worker's location.href when running with an OffscreenCanvas there. Resolve only on
encoder acquisition, not at server import time; unsupported execution capabilities fail explicitly.
Changing workerUrl alone does not relocate the default WASM URL. For a static copy, provide both
explicit URLs and copy the matching runtime, codec asset, maps/provenance and required notices.
Overrides relocate one verified build, not arbitrary incompatible WASM. Worker fetch/compile/ABI,
HTTP fallback HTML, wrong asset pair, CSP/CORS and timeout failures are terminal, with no CDN fallback.
Bundle/Next behavior and import safety must be proved on installed assets before exposing entries.

Finish must copy native output into an ordinary independent buffer before clearing native pointers.
Transfer only the output's exact byte span; a subview of a larger buffer must be copied first.
The runtime then drops snapshots/module references and closes; the host also terminates its owned
handle on success/error/abort/disposal and observes late settlement. `terminate()` return is not a
cross-browser teardown acknowledgement; tests must separately observe actual target/thread closure.

## Output validation and verification boundary

Before publishing a Blob, require nonempty ordinary-buffer Uint8Array output, check the output
limit and synchronously copy its exact view. Validate bounded RIFF length/padding and reconstruction
chunk ordering, animation flag/canvas dimensions, one ANIM with expected plays, nonempty ANMF data,
frame rectangle bounds/reserved bits, valid image-subchunk structure and positive encoded delays.
Sum encoded delays exactly and compare to accepted duration. Require animation even for one frame;
reject still-only output, incomplete chunks and trailing bytes. Unknown/metadata chunks remain
bounded/skippable where the container permits them; metadata must not change the encoder's sRGB
presentation contract. WebP has no PNG chunk-CRC requirement; do not reuse APNG validation unchanged.

Envelope checking yields cooperatively for long chunk scans (including nested chunks), guards
termination on resumption and before Blob commit, and does not decompress pixels. It cannot prove
that a merged packet's image covers the correct input intervals or that a bitstream is decodable.
Those remain the encoder contract and independent acceptance evidence. Do not impose encoded-frame
count equality, claim exact per-input timing from a total-only check, or retain raw images in the
controller just to duplicate the codec test oracle. Keep only counters/dimensions needed at finish.

The [gates](webp-export-compatibility.md) distinguish backend, private-controller and Node Worker
evidence from browser deployment checks. Public declarations remain unchanged. Local browser results
are recorded separately; for future work keep at most two agent-opened tabs, preserve user tabs and use the built-in browser
by default. Before external browser launch/debug attachment, obtain the user's explicit permission
for the concrete scope and explain why built-in verification cannot cover it.

## Verification of this design change

On 2026-11-13, `node node_modules/typescript/bin/tsc -p docs/drafts/tsconfig.webp.json`
completed with exit 0, strict checking, exact optional properties and no emit. It checks the
positive sketches and four expected type errors; it does not test the proposed runtime behavior.
Seven design/README files, 76 local links, Markdown anchors, whitespace/newlines and unchanged
runtime/build/manifest/exports/version were checked. No browser, WASM rebuild, benchmark or new
CI run was needed. Backend observations and baseline CI remain their original dated evidence.

The subsequent [private controller implementation](webp-controller-verification.md) checks fake
encoders/canvas fixtures and preserves this draft contract. The subsequent [Worker integration](webp-worker-verification.md)
checks real Node Workers, tagged assets and independently decoded complete animations. Subsequent
authorized Chromium/Firefox checks cover real canvas, Workers, native decoding, cancellation and
deployment faults, with a recorded unreproduced Firefox observation. Public entries/installed WebP
assets/Next remain separate slices. No version,
production dependency, release or publication change is part of the private implementation.
