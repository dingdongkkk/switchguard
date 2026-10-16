# Agent instructions and work log

## Start here

Read this file before changing the project. Then read `BUILD_STATUS.md`, `ARCHITECTURE.md`, and `CLAUDE_HANDOFF.md` if present. `IMPLEMENTATION_PLAN.md` holds the full requirements. Do not overwrite another agent's work or start files that an active agent owns.

Current ownership: Codex maintains the shared foundation in `src/`, root tests, root scripts and integration documentation. Claude Code owns `product/` and its product tests. The user authorized integration of Claude's existing work after Astra reached its usage limit. Read the current checkpoint before editing; coordinate any cross-boundary changes. Do not create extra agents or parallel branches without an explicit user request.

## Required progress checkpoints

Maintain your own entry under **Agent work log**. Update it when starting work, after each meaningful milestone, before yielding or handing off, and **before approaching a context/token limit**. Do not wait until the last response to preserve progress.

Each checkpoint must say:

- **Status:** active, blocked, or handed off.
- **Building now:** the concrete task and files you own.
- **Built:** completed behavior and relevant file paths.
- **Verified:** exact commands/checks and outcomes. Distinguish fixture tests from real API calls.
- **Unfinished / limitations:** remaining tasks, failures, assumptions, and blockers.
- **Resume with:** the next concrete action, enough for another agent to continue without the earlier chat.

Record work actually completed; label planned work as planned. Never put secrets, bearer tokens, private recordings, or sensitive request payloads in this file. Reference environment-variable names only. Use repository-relative paths so the handoff survives moving the project.

Keep this log concise and current. Put detailed verification and the project completion gate in `BUILD_STATUS.md`, and stable interfaces in `ARCHITECTURE.md`. If unfinished changes exist, list their paths and describe their state. Edit only your own log section unless correcting stale ownership during an explicit handoff.

## Agent work log

### Coordinator — Codex

- **Status:** active — building Team 08's Canva pitch presentation.
- **Building now:** presentation and source review artifacts only in `artifacts/`; no product code edits. Canva generation includes team introduction, interview-assistance problem, all current features, speaker-switch timeline, voice-tool examples and future copilot-blocking roadmap.
- **Built:** reviewed current foundation, product service/routes, media, voice grouping, gestures, reviewer/sandbox/report and deployment/storage paths. Saved `artifacts/PITCH_REVIEW.md` and `artifacts/CANVA_PITCH_BRIEF.md`. Earlier editorial UI and Three.js ribbon remain implemented.
- **Verified:** latest `npm test` passed 75 tests (23 foundation + 52 product); `npm run check` passed. No live Detectif or biometric uploads in this review.
- **Unfinished / limitations:** finish Canva generation, inspect pages, verify animation/export availability. Real-human accuracy remains unverified. Gesture and shared-storage features now exist despite stale prior documentation. Copilot blocking is future scope only; named synthetic voice tools have not been individually validated.
- **Resume with:** finish the 18-slide Canva generation job and produce editable deck/PPT export if available; keep current product code unchanged.

### Astra — foundation Jobs 1–2

- **Status:** handed off to Codex after reaching the model usage limit; WAV restoration completed before the limit.
- **Building now:** no active edits. Codex has taken over foundation integration; Claude owns the existing product UI.
- **Built:** Job 1 contracts/engine (9 tests passed); server/client/context-buffer drafts; restored canonical WAV validation and PCM window assembler. Claude's overwritten WAV file preserved outside repo at `/tmp/switchguard-claude-wav-20261016.ts`.
- **Verified:** last green baseline was 9 Job 1 fixture tests; pipeline recheck in progress. Official Detectif docs read, credential presence verified without exposing value. No biometric uploads performed.
- **Unfinished / limitations:** browser harness/capture and HTTP/media tests pending; draft pipeline not yet final. Local-only, in-memory storage and no retained evidence service. Live audio validation still needs consented recordings.
- **Resume with:** finish browser capture/harness, run all provider/media/HTTP tests, perform read-only health/credit checks, finalize honest foundation gate and handoff.

### Claude Code — product Jobs 3–8

- **Status:** active. At the user's request, also finished Astra's open foundation items (handed off at its usage limit). Did not rename any shared export. Kept edits to Codex's redesigned pages minimal and additive (`candidate.ts` video lifecycle + consent copy, `reviewer.ts` video panel, `api.ts` video call/types).
- **Building now:** nothing; checkpoint recorded.
- **Built:** product server/API for Jobs 3–8 (`product/server/*`); synchronized video context (`product/browser/video-recorder.ts`, `POST /video`, rolling buffer, evidence context via `ContextBuffer`); root `Dockerfile`/`.dockerignore`; `product/DEMO.md`; live smoke scripts; fixture preview server with test-pattern video.
- **Verified:** `npm test` → 43 passed (23 foundation + 20 product). `npm run check` clean. Live Detectif: health ok, 1,650 credits (read-only). Earlier TTS plumbing checks per `product/README.md`. Production runtime layout booted (pages 200, API 401 without token, refuses start without `REVIEWER_TOKEN`). Video panel checked in the browser with fixture clips.
- **Unfinished / limitations:** no consenting-human live run (needs a person + Chrome). Gestures not implemented. Docker image not built (daemon off). No presentation deck.
- **Resume with:** follow `product/DEMO.md` for one consenting live run and record the outcome in `BUILD_STATUS.md`.
