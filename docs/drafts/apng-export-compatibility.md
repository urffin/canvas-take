# APNG export: acceptance gates

Status: proposed tests, 2026-11-12. Companion to the [APNG design](apng-export.md) and
[draft declarations](apng-export-api.d.ts), baseline `4cc479b3178b77c1f945ec9371f656b5bb495187`.
No production APNG controller/adapter exists yet. The [backend spike](apng-backend-spike.md) verifies
real files and Worker interruption for its limited profile; it does not satisfy all controller gates.
Existing GIF/video tests cannot establish these new gates. Apply the [shared compatibility rules](shared-export-compatibility.md)
where relevant, keeping APNG policies distinct.

| Gate | Required evidence before accepting implementation |
| --- | --- |
| A1: injected backend | Fresh third-party fake encoder works without a supplied codec import; caller selects encoder; factory/capability failures allocate no accepted input; reentrant cancellation releases a returned instance |
| A2: snapshots/alpha | Readback/copy before first yield, explicit sRGB, immediate redraw cannot affect the accepted image; transfer never detaches caller storage; alpha 0/1/127/128/254/255 and erase-after-opaque frames reconstruct correctly |
| A3: delays/count/plays | Exact accepted delay list and frame count including identical frames and long final hold; one-frame animation keeps its metadata; 0/1/finite plays verified, no GIF repeat mapping |
| A4: limits | Inclusive exact boundary and first excess for pixels/frames/duration/raw bytes/output; overflow/invalid input rejected in defined order before readback/transfer; no partial output |
| A5: admission/progress | One pending public operation, cached finish identity before reentrant observer; full ordered frozen progress tuples, absent optional keys, no claimed encoded counts or batching |
| A6: cancellation | Pre-abort, reentrant factory/readback/observer, pending Worker init/add/finish/compression, error/timeout/malformed ack/late rejection; first reason/cause and exactly-once owned release |
| A7: output/cleanup | Complete structural result, independent decode of all full RGBA frames, finite retained-handle cleanup checks, Worker closed, returned Blob valid after disposal, a fresh export succeeds |
| A8: compatibility/package | Existing public declarations/exports unchanged except separately approved new APNG entry; no codec import in other controllers; licenses/maps and isolated packed/Next Worker deployment pass |

## Independent file oracle

Use an independent chunk reader with bounds and CRC validation, plus FFmpeg full-frame RGBA decode;
the encoding library's own decoder is supplementary evidence only. Check signature/IHDR/IEND,
animation count/plays, control/data ordering and sequence, frame-region bounds and delay fractions.
These structural requirements follow the [PNG animation specification](https://www.w3.org/TR/png-3/#apng-frame-based-animation).
Check that the default image is the first submitted animation image, not a separate poster.
Corrupt CRC, missing frame control, wrong play count/delay, static-only one-frame output and an
incorrect transparent erase must be negative controls that actually fail the oracle.

Compare every decoded image to the captured full-frame oracle: exact alpha and exact RGB where
alpha is nonzero, with no unexplained color tolerance. Ignore hidden RGB under zero alpha. Decode
one play without fps duplication/dropping; read final delay from chunk metadata as well as timestamps.
Browser playback is an additional smoke, not an exact short-delay timing oracle. If the independent
decoder cannot preserve a profile's alpha/endpoint, document and resolve that limitation before
claiming the gate; do not fall back to a writer/self-decoder round trip as the only proof.

## Required fixtures and controlled barriers

- Small odd dimensions and 1x1, fully opaque images, fully transparent images, partial-alpha
  gradients, moving objects becoming transparent, repeated identical frames, noise and final holds.
- Delays 1, 14, 15, 54, 55 and 65535 ms; fractional/zero/65536/nonfinite errors; exact summed duration
  and nonzero/overflowing dimensions; finite/infinite plays and one-frame animation.
- Exact raw-byte budget, one rejected next frame, output equal to/exceeding the limit; accepted
  counters survive a later rejected frame. Codec scratch is not asserted to fit the raw-byte budget.
- Delay adapter acknowledgement with explicit entry/continue gates. Inspect pixel/source buffer
  identity and report/state order before/after ack; no arbitrary sleep as proof of admission.
- Abort/dispose before/after owned transfer, inside readback, during batch compression and from
  collecting/finalizing/finished observers. Cover cleanup throwing or reentering and stale replies.
- Retain exporter/adapter/Blob handles while checking reference release and Worker termination;
  repeat successful and cancelled exports on one page. Keep caller canvas/readback storage usable.

Native browser verification uses Chromium/Firefox with an actual module Worker and default/custom
asset URLs. Keep at most two agent-opened browser tabs concurrently; reuse/close agent tabs and
preserve user tabs. An automated fixture should export/cancel/retry on the same page. Check that
the main thread can deliver cancellation while the Worker is compressing; report delivery versus
settlement separately rather than promise a universal latency threshold.

## Implementation gates and evidence status

The [completed spike](apng-backend-spike.md) selects pinned UPNG/Pako plus three guarded changes
for full-frame SOURCE/BACKGROUND. A2/A3 have synthetic RGBA/file evidence; A4 covers backend byte/
delay/plays checks; A6/A7 cover ready/compression interruption, actual Worker closure and retry.
Canvas readback, complete controller progress/limits/reentrancy, retention and A8 production
packaging remain pending. OVER/rectangle optimization is not certified. Characterize the draft
controller with fake adapters before integrating a production Worker. Type-checking alone remains
insufficient; see the spike's real-file results and explicit decoder limitation.

For runtime integration run `npm test`, `npm run test:package`, `npm run test:browser` and
`npm run test:next`; compare old export keys/declarations, Worker fixtures and independent files.
An exact candidate SHA CI result is required before claiming CI success. Keep dependency and
version changes separate; no new release is authorized by this design.
