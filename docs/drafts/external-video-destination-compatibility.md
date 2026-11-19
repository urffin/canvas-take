# Production destination acceptance matrix

Date: 2026-11-20, baseline `c6f7ef7`, version 0.8.1. Design criteria, **not a backend certification**.
See the [refined contract](external-video-destination-contract.md),
[companion types](external-video-destination-contract.d.ts) and [compile-only fixture](external-video-destination-types.ts).
These gates supplement [P1–P28](external-video-public-compatibility.md), especially P6–P8/P13–P21/P26.
The subsequent [private Node verification](external-video-file-verification.md) and
[gate evidence](external-video-file-results.json) record implementation checks for its explicit
controlled-local-directory/process-lifetime profile. The original design-stage evidence column
below remains historical; it is not a universal filesystem certification.

| Gate | Required future receiver proof | Evidence in this design stage |
| --- | --- | --- |
| D1 | Positive support is scoped to the actual backend/root/profile revision and selected policy; unknown/stale evidence rejects | `DestinationScope`, policy-specific `DestinationSupport`, required guarantees |
| D2 | Repeated support checks acquire/mutate nothing: no target/temp/journal/lock/picker/probe; no hidden writer calls | Defined read-only boundary; runtime instrumentation pending |
| D3 | Permission-required/denied is unsupported without prompting; later revocation rejects creation before publication | Typed diagnostic cases; actual platform checks pending |
| D4 | Unsupported positioned writes/truncate/byte bounds/recovery rejects; no fallback or limit inflation | Guarantee literals and unsupported codes; numeric/runtime proof pending |
| D5 | Profile/root/mount/target identity changes between preflight and create reject; partial unreturned handles/staging cleaned | Revalidation and ownership rules specified; fault injection pending |
| D6 | Two create-new attempts, intervening creator and another process: exactly one eligible publication; loser never touches winner | Existing local test receiver experiments are historical P13 evidence, not approval of the new receiver |
| D7 | Case/name aliases, symlinks/reparse points, non-regular targets, moved parents and scope escapes obey documented identity policy or reject | Explicit identity/concurrency boundary; actual platform proofs pending |
| D8 | Replace leaves previous content unchanged until one atomic publication; no stale tail, append, copy/delete/in-place fallback | Existing scoped P14 experiment retained; candidate receiver proof pending |
| D9 | Concurrent replacement is unconditional unless backend explicitly enforces a stricter revision; failed attempt never restores stale old content over another writer | Selected semantics; multi-writer test pending |
| D10 | Commit throw/reject/malformed result still leaves caller-known attempt identity and independent recovery access after closed | Binding/key types; fixture does not use optional close-report recovery hint |
| D11 | Journal/attempt registration precedes publication; inject failures before/after journal write, publication call and acknowledgement | Ordering specified; no journal implementation or crash proof added |
| D12 | All three outcomes classify actual publication; negative outcome requires proof this attempt did not publish | Existing core protocol retained; receiver-specific classification tests pending |
| D13 | Equal hash/size/bytes, absent target/staging, missing record and attempted-only record never alone resolve ambiguity | Recovery decision table; false-proof fault injection pending |
| D14 | A timed-out/disconnected operation that can still publish stays indeterminate; stale lease/time alone is insufficient | Non-quiescent snapshot cannot carry not-committed in the fixture; backend fencing proof pending |
| D15 | Successful earlier publication followed by overwrite/delete is still historically committed; never return the later writer's object as the earlier receipt | Separate currentTarget/publication and unavailable-receipt branches; concurrency proof pending |
| D16 | Recovered receipts are original-attempt, caller-owned, type-correct and usable independently of session/recovery handles; falsy values permitted | Positive/failing receipt fixtures; resource/retention proof pending |
| D17 | Repeated inspect is read-only; unknown key version/backend/scope/foreign attempt reject without mutation; inspector failures preserve recovery state | Scoped versioned key and service separation; runtime trace tests pending |
| D18 | Cleanup revalidates revision, quiescence, definitive outcome and staging ownership at mutation time; stale/ambiguous/foreign artifacts block | Mandatory expectedRevision and blocked outcome types; race tests pending |
| D19 | Unknown release preserves needed recovery state; explicit repeated cleanup touches only owned obsolete remnants and never target/receipt/evidence | Existing core release classification unchanged; candidate recovery lifetime tests pending |
| D20 | No core ABI/signature/export/default/Promise changes; legacy Blob path and current private muxer/controller checks stay valid | Strict old/new type assignments, unchanged public declarations and source/metadata checks |

These are receiver implementation gates. The compile-only fixture checks shape, correlation and
narrowing; it cannot establish read-only behavior, atomicity, identity security, publication history,
physical quiescence or crash durability. The [verification record](external-video-destination-verification.md)
keeps the distinction explicit.

The private reference receiver should first prove process-lifetime recovery on its selected
platform/namespace. A later durable/crash-recovery profile needs explicit persistence/fencing tests
and must not inherit a stronger guarantee from a passing process-lifetime test. P27/P28 public
installed/Next integration remains a subsequent separately authorized stage.
