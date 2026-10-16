# SwitchGuard — Claude Code handoff

## Current continuation checkpoint — 2026-10-16

Claude has already built `product/`; preserve it and do not restart Jobs 3–8 from scratch. The accidental shared WAV overwrite is restored. Codex integrated the product into the root commands after Astra hit its model usage limit. `npm test` passes 41 fixture tests and `npm run check` checks both projects. Use `npm run dev` from the root for the existing product.

The build/test integration gate passed, but the original full live/media gate is still incomplete: consenting-human browser verification, synchronized video capture/context, and other limitations are listed in `BUILD_STATUS.md`. First run the real participant workflow, then audit the existing product against the original plan. Current ownership: Codex/shared foundation in `src/`; Claude/product in `product/`. Coordinate changes to shared interfaces and keep both test suites green. The assignment below is the original checklist, not a claim that all listed work remains unbuilt.

## Assignment

Continue the existing SwitchGuard prototype after the Astra foundation gate passes. Read `IMPLEMENTATION_PLAN.md`, `ARCHITECTURE.md`, `BUILD_STATUS.md`, and `README.md` before editing. Inspect the actual implementation and run its documented checks before adding product features. The original plan remains the acceptance checklist.

Astra owns only the shared contracts, deterministic decision engine, server-side Detectif adapter, media timing/capture foundation, focused tests, and a minimal development harness. Claude Code owns the remaining product work. Do not create additional agents unless the user requests them.

Do not start product implementation while Astra is still editing the foundation. The completed gate in `BUILD_STATUS.md` must distinguish implemented features, fixture-tested behavior, live API verification, and known gaps. A pending live media test is not a successful live test; finish it with a consenting participant before claiming the demo works.

## Build order

1. **Working interview path — original Jobs 3–4.** Build consent and enrollment, microphone level/status, approximately 20-second enrollment recording, authenticity gating before accepting the reference, candidate-only capture, fixed questions, explicit answer boundaries, session controls, and reviewer timeline. Use the existing API and timebase. Show identity and authenticity separately, current check age, pending work, interruptions, and coverage gaps. Finish one real enrollment-to-answer-results path before adding secondary screens.
2. **Evidence and human review — original Job 5.** Connect flagged answers to the actual audio/video interval with surrounding context. Show actual results and readable reasons. Add request-reverification, reviewed, and escalate actions with notes. Preserve earlier evidence and record later resolutions separately. Restrict recording access; thumbnails are navigation aids, not detection evidence.
3. **Judge sandbox — original Job 7.** Use consented, clearly labelled samples for the five scenarios in the plan. Send them through the same backend and decision pipeline. Keep expected labels outside detection logic. Show fresh results, misses, false alerts, inconclusive runs, actual trial counts, latency, and available usage information. Compare enrollment-only and repeated checks without inventing accuracy statistics.
4. **Re-verification — original Job 6.** First implement an expiring, server-generated, one-use phrase challenge, actual transcription and text comparison, and fresh Detectif checks against the original reference. Keep phrase, speaker, and authenticity outcomes separate. Add the small supported gesture set only after the voice workflow works. Provide reviewer-assisted accessibility handling. Do not imply a displayed phrase was checked without transcription, or that gestures authenticate video.
5. **Delivery — original Job 8.** Implement explicit media retention, restricted access, session/media/profile deletion, operator health/credit reporting, and a simple evidence export. Deploy with server-only secrets and permitted demo data. Write a short demo script and prepare presentation material after the end-to-end checks pass.

This order follows the plan's time-limited priorities: real voice pipeline, timing/failures, evidence, sandbox, phrase challenges, gestures, then secondary presentation work. Apply basic access restrictions and retention while adding storage; do not defer those until deployment.

## Interface rules

The initial foundation entry points are `src/shared/contracts.ts` for domain types and `src/shared/decision.ts` for `createSession`, `addWindow`, `applyResult`, and `decide`. `ARCHITECTURE.md` documents the final server/media interfaces. The baseline commands are `npm ci`, `npm test`, and `npm run check`; `npm run dev` builds and starts the development harness once Job 2 is complete.

- Use the exact exports and routes documented in `ARCHITECTURE.md`; do not introduce a second Detectif client or decision engine.
- Preserve capture time separately from request/response time and use the established session-relative clock.
- Keep independently decodable clips. Never submit arbitrary `MediaRecorder` fragments as complete files.
- Never combine speaker similarity and authenticity into a trust percentage. Similarity is not a probability.
- A speaker match cannot cancel a synthetic verdict. Errors, stale checks, short audio, and missing coverage cannot produce a positive status.
- Preserve partial results, individual windows, interruptions, original flags, and reviewer resolutions.
- Re-verification must use the original enrolled profile. A later successful check cannot erase prior evidence.
- Keep Detectif credentials server-side. Do not copy secrets into prompts, fixtures, logs, browser bundles, or version control.
- If a foundation defect blocks integration, make the smallest repair, add a meaningful regression test, and document the contract change in `ARCHITECTURE.md` and `BUILD_STATUS.md`.

## Completion checks

Run the existing checks after integrating each job, and add tests for new behavior where useful. Update `BUILD_STATUS.md` after each milestone with changes, checks run, live calls actually performed, known problems, and the next task.

Before claiming completion, exercise enrollment → interview → actual alert or honestly reported outcome → evidence → fresh challenge → reviewer disposition. Verify partial API failures, late results, retries without duplicated logical operations, refresh/reconnect invalidation, and deletion making retained media inaccessible. The system must never automatically reject a candidate.

## Prompt to paste into Claude Code

> Continue SwitchGuard in this directory. Read CLAUDE_HANDOFF.md, BUILD_STATUS.md, ARCHITECTURE.md, README.md, and IMPLEMENTATION_PLAN.md. Confirm the Astra foundation gate and run the documented baseline checks. Implement the remaining product jobs in CLAUDE_HANDOFF.md order, starting with the consent/enrollment and interview/reviewer flow. Reuse the foundation contracts, Detectif adapter, media timebase, and decision engine. Keep updates in BUILD_STATUS.md. Clearly distinguish fixtures from real results, and never claim live verification without a real successful call. Do not spawn agents or redesign foundation interfaces unless a documented defect requires a small repair. Complete one working path before optional features.
