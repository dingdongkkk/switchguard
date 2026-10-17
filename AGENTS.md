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

- **Status:** handed off — current-code priority audit complete (17 October 2026).
- **Building now:** none; only documentation changed, product implementation untouched.
- **Built:** `artifacts/PRIORITY_AUDIT.md` ranks durable job recovery, interval coverage, independent phrase validation, human evaluation, tenant isolation, transactional metadata and shared resource budgets. Current gesture enum has five prompts; older six-prompt descriptions are stale.
- **Verified:** `npm test` passed 77 fixture tests (23 foundation + 54 product); `npm run check` passed. Direct compiled-code reproduction: 21 s of continuous coverage with a nested 5 s targeted window reports 26 s and a false 10–14 s gap. No live provider calls or biometric uploads.
- **Unfinished / limitations:** findings are not fixed. Serverless recovery concern is source-backed, not a deployed crash test. Real-human accuracy/live acceptance remain unverified. Existing AGENTS.md/BUILD_STATUS.md changes preserved.
- **Resume with:** use `artifacts/PRIORITY_AUDIT.md`; fix interval arithmetic first, then implement durable job recovery and independently verified challenge transcription. Coordinate product ownership before implementation.

### Astra — foundation Jobs 1–2

- **Status:** handed off to Codex after reaching the model usage limit; WAV restoration completed before the limit.
- **Building now:** no active edits. Codex has taken over foundation integration; Claude owns the existing product UI.
- **Built:** Job 1 contracts/engine (9 tests passed); server/client/context-buffer drafts; restored canonical WAV validation and PCM window assembler. Claude's overwritten WAV file preserved outside repo at `/tmp/switchguard-claude-wav-20261016.ts`.
- **Verified:** last green baseline was 9 Job 1 fixture tests; pipeline recheck in progress. Official Detectif docs read, credential presence verified without exposing value. No biometric uploads performed.
- **Unfinished / limitations:** browser harness/capture and HTTP/media tests pending; draft pipeline not yet final. Local-only, in-memory storage and no retained evidence service. Live audio validation still needs consented recordings.
- **Resume with:** finish browser capture/harness, run all provider/media/HTTP tests, perform read-only health/credit checks, finalize honest foundation gate and handoff.

### Claude Code — product Jobs 3–8

- **Status:** active (17 October 2026).
- **Building now:** nothing; checkpoint recorded.
- **Built:** product server/API, voice grouping, gestures, video context, Vercel deployment. Judge demo mode (`JUDGE_DEMO=1`): `/` opens without a token, scoped to demo sessions (`product/server/app.ts`, `product/browser/api.ts`). Vercel Blob hit the Hobby 2,000 advanced-operation quota and was paused for 30 days, so production now uses `SupabaseStore` (`product/server/store.ts`, schema `product/server/supabase.sql`) via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; Blob remains the fallback.
- **Verified:** `npm test` → 82 passed (23 foundation + 59 product, Supabase store against a fake REST server). Live: `/api/health` reports store `supabase` ok; judge can create/read demo sessions, unauthenticated read is 401, anon Supabase REST is 401, bucket round trip ok.
- **Unfinished / limitations:** DetectifAI credits are 0, so live provider checks fail closed. No consenting-human live run. Old Blob data (207 MB) is unreachable until the pause lifts.
- **Resume with:** fund a DetectifAI key, then follow `product/DEMO.md` for one live run on https://switchguard-chi.vercel.app.
