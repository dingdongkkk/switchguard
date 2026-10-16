# Build status

## Latest checkpoint — Claude, 2026-10-16 (foundation completion)

At the user's request Claude finished Astra's open foundation items without renaming any shared export.

- **Synchronized video context (Job 2):** `product/browser/video-recorder.ts` records independent ~5 s WebM/MP4 clips on the session clock while live (camera consent only). `POST /api/sessions/:id/video` validates the container header, keeps a rolling 120 s buffer plus every clip within 5 s of an evidence or still-pending interval, and purges the rest. Reviewer evidence shows clips ±5 s with explicit gaps, computed by `src/media/context-buffer.ts` (`ContextBuffer.context`). Retention and deletion cover video. Candidate consent text now names video clips.
- **Tests:** `npm test` → **43 passed** (23 foundation + 20 product; 2 new video-context tests). `npm run check` passes both projects.
- **Live read-only check (no credits):** Detectif health `ok` (database/inference ok). Credits: free plan, **1,650 available**, 50 per operation (100 per combined check).
- **Browser check (fixture data, provenance `test_fixture`):** the reviewer evidence panel loaded and decoded 4 test-pattern clips (ffmpeg `testsrc`, not a person) around a flagged window inside Codex's redesigned layout.
- **Deployment:** root `Dockerfile` + `.dockerignore`. The exact runtime layout was booted in production mode: pages, modules, worklet and vendor files returned 200, the API returned 401 without the reviewer token, and startup without `REVIEWER_TOKEN` was refused. The Docker image was **not** built (daemon not running).
- **Demo script:** `product/DEMO.md`.

### Foundation gate (Jobs 1–2) — as of this checkpoint

| Item | Status |
|---|---|
| Contracts, decision engine, timebase | Done; fixture-tested |
| Detectif client: enroll/verify+deepfake/delete, partial results, retries, idempotency, bounded queue | Done; fixture-tested; **live verified with TTS audio** (plumbing only) |
| Independent WAV windows, short fragments, gaps, timestamps | Done; fixture-tested |
| Bounded video context on the same timebase | Done; fixture-tested; browser playback checked with test-pattern clips |
| Credentials never reach the browser | Done (server env only; checked in the production layout) |
| Consenting human enrolled and checked live in a browser | **Not done.** Needs a person, a microphone and Chrome. |
| Live speaker change producing a real flag | **Not done** (same reason) |

The gate is complete except the two live-human items. They cannot be faked and must not be claimed until performed.

## Earlier checkpoint — 2026-10-16

The accidental WAV overwrite is repaired. `src/media/wav.ts` exports the original `encodeWav`, `inspectWav`, and `PcmWindowAssembler` used by both the foundation and Claude's product. The overwritten version was preserved at `/tmp/switchguard-claude-wav-20261016.ts`.

Astra reached its model usage limit after restoration. At the user's request, Codex continued integration and preserved Claude's work in `product/`. Root `npm run dev` now launches that product. We reuse its browser capture and screens instead of building a second development UI. `src/server/app.ts` remains an earlier local API draft, not the supported product entrypoint.

## Implemented

- Foundation: shared contracts, deterministic decisions, immutable historical flags, capture-order status, separate speaker/authenticity results, stale/interruption handling, original-reference re-verification.
- Detectif adapter: server credentials, enrollment/combined checks/deletion, partial-result normalization, provider IDs/metadata, capped retries with stable operation keys and bounded concurrency.
- Media: independent canonical PCM16 WAV windows, duration validation, short-fragment handling, explicit discontinuities and a bounded context-buffer utility.
- Claude product: consent/enrollment authenticity gate; interview and reviewer screens; answer-linked checks; evidence audio and thumbnails; resolutions; phrase challenges and reviewer assistance; labelled sandbox; retention/deletion, export and operator views. See `product/README.md` and `product/API.md` for behavior and limitations.
- Root integration: one launch command, checks for both TypeScript projects, combined tests, and ignored local session/media storage.

## Verification performed by Codex

- `npm test`: **41 passed** (23 foundation, 18 product), with scripted provider fixtures and no real detection calls.
- `npm run check`: both TypeScript projects passed.
- Root `npm start` on temporary port 3107: health, home, candidate, reviewer, sandbox, report, compiled candidate/WAV modules and AudioWorklet all returned HTTP 200. Unauthenticated reviewer sessions returned HTTP 401. Temporary server stopped afterward.
- New media tests verify independent decoding, capture-relative timing, short final fragments, malformed WAV rejection, forward gaps, backward-clock rejection, context gaps and byte/time eviction.

## Live verification

Codex did not make live Detectif calls or record a person during this repair. Claude's `product/README.md` reports earlier live checks using macOS synthetic speech: health, detect, enrollment, idempotent replay, same/different-voice verification, deletion, and refusal of synthetic enrollment by the product gate. These are reported plumbing checks, not accuracy measurements or a consenting-human end-to-end run, and were not rerun here.

## Gate and remaining limitations

**Build/test integration is ready for Claude continuation. The full original Job 2 live/media acceptance gate and deployed-demo gate are not complete.**

- A consenting human must still exercise browser microphone capture, enrollment, interview, speaker change, evidence and re-verification through the real provider.
- Video context is now connected (see latest checkpoint). Clip timing comes from MediaRecorder start/stop events (about ±100 ms), and video is reviewer context only, never detection evidence. Real camera capture has not been exercised in a browser with a person.
- Phrase transcripts are browser-reported Web Speech API results, not independently verified server transcripts; reviewer assistance is separate. Gesture recognition is not implemented.
- Shared draft API `src/server/app.ts` is not the product API; use `product/server/app.ts`. Do not deploy the draft as the application.
- Deployment, full sandbox comparative metrics, demo script/deck and other original-plan acceptance items need a final audit. Existing screens do not by themselves establish completion of Jobs 3–8.
- Check the operator credit balance before a live demo. No accuracy or multilingual-performance claims are justified by fixture tests.

## Next task

Run the consenting-human smoke test with `product/DEMO.md` (Chrome, `npm run dev`, `WINDOW_MS=15000`, at least 1,000 credits) and record its real outcome here. Still open: gestures (not implemented), the presentation deck, and a built and deployed container.

## UI refinement — Codex, 2026-10-16

Completed editorial review desk, shared navigation, responsive evidence review, candidate and sandbox styling, and custom Three.js continuous ribbon. Decorative art is labeled as illustration; real counts and flags remain API-derived. Browser fixture checks at 1440px and 390px passed; no console errors or page overflow. `npm test` passed all 43 tests; `npm run check` and final product build passed. No live human analysis was performed for this UI pass.
