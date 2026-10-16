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

- **Status:** handed off — UI redesign and Three.js refinement complete.
- **Building now:** no active edits. User authorized product UI changes, including replacement of Claude's decorative spectrogram.
- **Built:** shared navigation and accessible dialogs; editorial review desk with compact statistics and searchable sessions; responsive reviewer/candidate/sandbox/report pages. `product/browser/signal.ts` now renders a custom lit, ribbed continuous ribbon with pointer parallax, reduced-motion support, visibility throttling, disposal and CSS fallback. Three.js is locally served through an allowlisted vendor route. Preserved Claude's added video functionality.
- **Verified:** `npm test`: 23 foundation + 20 product fixture tests passed. `npm run check` and product build passed. Browser fixture preview checked at 1440px and 390px; no horizontal page overflow or console errors. Sign-in, search/filter, create dialog, review/report, candidate consent screen and sandbox inspected. No live Detectif analysis or microphone capture in this UI task.
- **Unfinished / limitations:** consenting-human live flow still needs verification; gestures remain unimplemented. See `BUILD_STATUS.md` for deployment and video status.
- **Resume with:** run `npm run dev`; keep current UI and Claude's backend/video changes. Read this checkpoint before editing shared files.

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
