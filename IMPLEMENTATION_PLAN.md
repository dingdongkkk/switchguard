# SwitchGuard — Implementation Plan

## Objective

Build a hackathon prototype that checks speaker identity and voice authenticity throughout an interview, maps concerns to specific answers, supports re-verification, and lets judges run controlled test scenarios.

The complete demonstration:

**Enroll → interview → possible speaker change → affected answer flagged → evidence playback → re-verification → human review.**

Use DetectifAI for the actual voice checks. Do not invent detection results or present simulated results as live.

## Working instructions

1. Inspect the existing repository before changing anything. Reuse working code and the existing stack where practical.
2. Maintain `BUILD_STATUS.md` with completed work, verification performed, known problems, and the next task. Never include secrets.
3. Complete Astra Jobs 1–2 before starting the remaining jobs.
4. Implement one working path before adding optional features.
5. Do not redesign approved interfaces during later jobs unless a concrete defect requires it. Document any change.
6. Distinguish implemented, tested, mocked, and planned features.
7. Do not introduce a general-purpose LLM into detection decisions.
8. Do not create additional agents or parallel implementation branches unless explicitly requested.

## Source of truth

Read the current documentation before implementation:

- https://platform.detectif.ai/docs/
- https://platform.detectif.ai/docs/api/verify-speaker/
- https://platform.detectif.ai/docs/api/enroll-speaker/
- https://platform.detectif.ai/docs/api/detect-deepfake/
- https://platform.detectif.ai/docs/audio-and-limits/
- https://platform.detectif.ai/docs/errors/
- https://platform.detectif.ai/docs/privacy/

Known constraints to verify against the current docs:

- Enrollment: 15–60 seconds, including at least 10 seconds of speech.
- Verification: 3–60 seconds, including at least 2 seconds of speech.
- Deepfake detection: more than 4 seconds, up to 120 seconds.
- Combined checking: `POST /v1/speakers/verify`, with `file`, `speaker_id`, and `detect_deepfake=true`.
- Combined checks can partially fail and are counted separately for credits.
- Speaker similarity is not a percentage probability.
- Use the deepfake final `verdict`; segment scores are supporting evidence from an earlier processing stage.
- Public documentation describes file uploads. Implement repeated clip analysis, not an assumed streaming API.
- Start with clear English speech; do not claim validated multilingual performance.

# ASTRA WORK — COMPLETE FIRST

## Job 1 — Inspect, define contracts, and implement decision logic

**Model: Astra, High reasoning**

Keep this focused. Do not build the polished interface.

### Tasks

- Audit existing code and identify reusable components.
- Choose the simplest architecture compatible with the repository and deployment.
- Define shared types or schemas for:
  - Interview session and participant.
  - Enrollment reference.
  - Question and answer.
  - Captured audio window.
  - Separate speaker and authenticity results.
  - Evidence interval.
  - Verification challenge.
  - Reviewer resolution.
- Define one session-relative timebase for audio, video, questions, and results.
- Preserve capture time separately from submission and response time.
- Implement the deterministic decision engine.
- Document interfaces and ownership boundaries in `ARCHITECTURE.md`.

### Decision rules

- Keep identity and authenticity separate.
- Never average them into a single “trust percentage.”
- A match cannot cancel a synthetic-speech flag.
- Missing, failed, or stale checks cannot produce a positive status.
- Low-quality or insufficient audio becomes inconclusive.
- Preserve individual results even when applying temporal smoothing.
- Do not treat overlapping windows as independent confirmations.
- Re-verification uses the original enrolled reference.
- Successful re-verification does not erase earlier evidence.
- A reviewer makes the final disposition; the system never automatically rejects a candidate.

### Application states

- Checking.
- Consistent with enrolled speaker.
- Needs re-verification.
- Inconclusive.
- Monitoring interrupted.

Represent the reviewer’s resolution separately from these states.

### Acceptance checks

Test meaningful cases:

- Speaker match plus genuine verdict.
- Speaker mismatch plus genuine verdict.
- Speaker match plus fake verdict.
- `not_sure`.
- One check failing while the other succeeds.
- Delayed results arriving out of order.
- Interruption followed by recovery.
- Successful re-verification preserving the previous flag.

**Deliverable:** working decision module, shared contracts, tests, and a concise architecture document.

## Job 2 — Build the critical API and media pipeline

**Model: Astra, High reasoning**

Implement the difficult foundation with a minimal development harness. Leave styling and full product screens for later jobs.

### DetectifAI integration

- Keep credentials exclusively on the server.
- Implement enrollment, combined checking, and speaker deletion.
- Retain actual request IDs, operation IDs, model versions, verdicts, and relevant timing information.
- Handle embedded deepfake errors and partial results.
- Use a new idempotency key for each logical operation; reuse it only for retries of that same operation.
- Respect retry headers and cap retries.
- Bound concurrency and queues.
- Handle credit exhaustion, expired credentials, unsupported audio, and service failures honestly.

### Capture and timestamps

- Capture candidate audio separately from interviewer audio.
- Begin with approximately 6–8-second analysis windows; make the configuration adjustable.
- Ensure every submitted clip is independently decodable. Do not assume each browser recorder fragment is a valid standalone audio file.
- Preserve session-relative start/end times and answer associations.
- Handle short final fragments without silently treating them as checked.
- Keep explicit pending, failed, and skipped intervals.
- Map API segment timestamps back to the original session.
- Design a bounded temporary video buffer using the same timebase.
- Provide a function that retrieves visual context around a flagged audio interval.
- Preserve the timing relationship during any audio conversion or trimming.
- Mark reconnects and capture interruptions.

### Verification

Use a minimal harness to prove:

- A consenting speaker can be enrolled.
- A fresh recording can be submitted for both checks.
- API results reach the decision engine.
- Evidence timestamps correspond to the original recording.
- A delayed result cannot overwrite newer session state incorrectly.
- Failure or interruption is visible.
- Credentials never reach browser code.

If credentials are unavailable, complete fixture-based tests and clearly mark live verification as pending. Never present fixture results as live.

**Deliverable:** working integration and media modules, a minimal harness, focused tests, and a handoff listing exact interfaces for later jobs.

## Astra completion gate

Before switching models, provide:

- What is implemented.
- Which checks passed.
- Which real API calls were tested.
- Known limitations.
- Files and interfaces later jobs should use.
- The next implementation task.

No further Astra work is scheduled.

# STANDARD-MODEL WORK — CODEX OR CLAUDE

Use a capable everyday coding model for Jobs 3–8. Follow the existing contracts and run their tests after integration.

## Job 3 — Consent and enrollment screen

Build:

- Short explanation of voice analysis and evidence retention.
- Explicit microphone/camera consent.
- Microphone level and recording status.
- Enrollment recording targeting approximately 20 seconds.
- Clear retries for insufficient speech or poor audio.
- An authenticity check before accepting the reference into the workflow.
- A clear distinction between voice continuity and proof of real-world identity.

If a random phrase is shown, do not claim it was verified unless transcription and phrase matching are implemented.

**Done when:** enrollment works end to end through the real backend.

## Job 4 — Interview room and reviewer dashboard

Build:

- Candidate camera preview and microphone status.
- Fixed interview questions.
- Explicit answer start/end boundaries.
- Start, pause, resume, and end-session controls.
- Interviewer/reviewer view.
- Separate identity and authenticity indicators.
- Latest completed-check time.
- Pending checks and analysis coverage gaps.
- Answer timeline with reasons and timestamps.

Use candidate-only capture. Full mixed-audio diarization is out of scope.

If a full video-call integration already exists, reuse it. Otherwise prioritize a controlled browser interview flow over building a conferencing product.

**Done when:** a complete interview produces answer-linked results without manual database changes.

## Job 5 — Evidence playback and reviewer actions

Build:

- Click a flagged answer to inspect the relevant audio/video interval.
- Include context before and after the flagged segment.
- Display a thumbnail as a navigation aid.
- Show separate API results and plain-language explanations.
- Support “request re-verification,” “reviewed,” and “escalate,” with notes.
- Preserve the original flag and the later resolution.

A screenshot or clip is visual context, not automated proof of lip-sync manipulation.

Store retained media with restricted access. Public demonstration links must not expose private session recordings.

**Done when:** the reviewer can trace an alert to the exact analyzed interval and document a resolution.

## Job 6 — Phrase and gesture re-verification

Build:

- Server-generated, one-use challenges associated with the session.
- Fresh spoken phrase plus a short randomized gesture sequence.
- Phrase transcription followed by explicit text matching.
- MediaPipe recognition for a small supported gesture set.
- Repeat DetectifAI checks against the original enrollment.
- Expiration and rejection of already-used challenge submissions.
- An alternative reviewer-assisted path for accessibility or camera problems.

Keep these outcomes separate:

- Phrase matched.
- Gesture completed.
- Speaker matched.
- Authenticity verdict.

Gesture completion must not override a failed voice check or imply that the video is authentic.

**Done when:** a challenge is issued, evaluated, logged, and shown alongside the previous evidence.

## Job 7 — Judge-controlled stress-test sandbox

Provide consented, labelled scenarios:

1. Genuine enrolled speaker.
2. Different speaker taking over.
3. Permitted synthetic speech.
4. Genuine speech with noise.
5. Short speech or silence.

Requirements:

- Run samples through the same pipeline as interview audio.
- Clearly label prerecorded input processed now.
- Keep expected labels outside detection logic.
- Show actual results, including misses and false alerts.
- Show the answer/segment timeline.
- Optionally accept judge uploads; identity checking requires an appropriate enrolled reference.
- Do not conceal cached results as fresh runs.

Add a comparison view:

- Enrollment-only verification.
- Repeated verification.

Report:

- Switches detected and missed.
- Genuine sessions that triggered false alerts.
- Inconclusive cases.
- Time from known switch onset to displayed alert.
- API calls and credits used where available.

Keep test sets and trial counts visible. Never fabricate accuracy figures.

**Done when:** a judge can choose a scenario and inspect the actual outcome independently.

## Job 8 — Retention, deployment, report, and final checks

Build:

- Explicit media-retention configuration and deletion behavior.
- Session deletion, including associated media.
- Speaker-profile deletion where appropriate.
- Printable evidence summary or simple export.
- Health and credit status for the operator.
- Deployed demo with server-side secrets.
- Safe demo access using permitted sample data.
- Short demonstration script and presentation deck.

Verify:

- Enrollment → interview → alert → evidence → challenge → review.
- Genuine speech does not become suspicious merely because a request fails.
- Browser refresh/reconnect does not falsely preserve a current verified state.
- Partial API failures are visible.
- Retry behavior does not duplicate logical operations.
- Deleted media is no longer accessible.
- All demonstration labels are truthful.

# PRIORITIES IF TIME RUNS SHORT

Preserve, in order:

1. Real enrollment and combined voice checks.
2. Correct audio timing and failure handling.
3. Answer timeline and reviewer evidence.
4. Judge-controlled sandbox.
5. Phrase re-verification.
6. Gesture challenge.
7. Report styling and secondary conveniences.

Do not sacrifice the working voice pipeline to finish gestures.

# EXPLICITLY OUT OF SCOPE

- Training a custom deepfake model.
- Automated lip-sync classification.
- Emotion, honesty, or personality scoring.
- Automatic candidate rejection.
- Full Zoom/Meet/Teams integrations unless already working.
- Mixed-audio diarization unless essential to existing architecture.
- Claims of immutable logs without an implemented integrity mechanism.
- Claims of perfect detection or equal accuracy across languages.
- A general-purpose AI interviewer.

# FINAL DEMONSTRATION

1. Enroll a consenting participant.
2. Start an interview.
3. Introduce a controlled speaker change.
4. Show the actual result and affected answer.
5. Inspect synchronized evidence.
6. Run fresh re-verification.
7. Record the reviewer’s decision.
8. Let judges run a sandbox scenario.
9. Show measured successes, failures, and limitations.

The project is complete when this workflow runs reliably on the deployed prototype—not when every optional feature exists.