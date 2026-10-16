# SwitchGuard foundation interfaces

## Architecture and ownership

The repository was empty. The foundation uses TypeScript, Node's built-in HTTP and fetch APIs, and browser ES modules. Three.js is the browser illustration runtime dependency; its module and core files are served locally through allowlisted vendor routes. `src/shared/contracts.ts` is the shared model; `src/shared/decision.ts` is the deterministic state engine. Product UI, storage, challenges, sandbox, and deployment belong to later jobs. Do not put provider credentials in client code.

## Decision contract (Job 1 complete)

- `createSession(id, epochMs, displayName)` creates the ledger.
- `addWindow(session, window)` returns a new session and requires the original active reference.
- `applyResult(session, result)` appends one result per window and persistent evidence for mismatch/fake. Duplicates do not replace earlier results. Results received out of capture order are retained.
- `decide(session, nowMs, staleMs = 25000)` derives current state from the greatest capture end time, with sequence as a tie-breaker. A newer pending/skipped interval supersedes an old green state. Stale capture or an active interruption cannot be positive. Recovery requires a recording starting after resume. A mismatch or fake result remains a concern even when the other check fails.
- No smoothing or voting is applied. Overlapping windows are observations, never counted as independent confirmations. Historical evidence and reviewer resolutions remain separate from current state; a newer success can be green while prior flags stay visible. No automatic candidate rejection.
- Similarity is a raw similarity, never a probability. Authenticity uses only the final `verdict`, never segment scores.

## Timebase

All `*Ms` fields except `createdAtEpochMs` are milliseconds since session creation. Capture uses a monotonic browser clock anchored once to the server response (midpoint round-trip estimate); the server uses its own elapsed time. Never substitute submission/response time for capture time. The provider's clip-relative seconds map to `window.startMs + mediaOffsetMs + seconds * 1000`, bounded by the captured interval. No conversion, trimming, or resampling is permitted without recording its offset. Current implementation emits PCM16 WAV at the device AudioContext sample rate and uses sample counts for duration.

## Integrated pipeline

`src/server/detectif.ts` exports `DetectifClient`, `normalizeCombined`, `failedResult`, and provider metadata helpers. The client has bounded concurrency and capped retries; each logical enrollment/check receives a stable idempotency key across its retries. `normalizeCombined` preserves verification failures with successful partial deepfake results, and embedded deepfake failures with successful speaker verification. It maps segment seconds onto the captured interval and uses only the final verdict for decisions.

`src/media/wav.ts` exports `encodeWav`, `inspectWav`, and `PcmWindowAssembler`. Each output is an independent mono PCM16 WAV at the source sample rate. A discontinuity flushes the existing fragment; backward clocks reject capture instead of joining unrelated samples. `src/media/context-buffer.ts` exports `ContextBuffer` for bounded temporary chunks and context retrieval with explicit gaps. The product uses it to compute reviewer video context (clips ±5 s with explicit gaps) from retained clips recorded by `product/browser/video-recorder.ts`. Each clip is one complete MediaRecorder file stamped with session-clock start/end. The server keeps a rolling 120 s buffer plus clips near evidence or pending intervals.

Claude's `product/browser/capture.ts` supplies AudioWorklet candidate capture and the product uses the shared WAV assembler. `product/server/service.ts` owns sessions, answer association, persistence, enrollment authenticity gating and review actions. `product/server/app.ts` owns the HTTP interface documented in `product/API.md`. Browser/product contracts must follow that API, not the earlier development routes.

### Integration decision — 2026-10-16

The user requested preserving Claude's concurrent product work. Root build/start/test/check scripts now include `product/`, and `npm run dev` starts the product. Its existing screens serve as the development harness rather than introducing a duplicate interface. No shared export was renamed. `src/server/app.ts` and `main.ts` remain historical API-only drafts and are not the default app. This integration does not imply a production or live-human verification gate has passed; see `BUILD_STATUS.md`.
