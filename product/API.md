# SwitchGuard product API (product/ layer)

Server: `product/server/app.ts` (owned by the main Claude session). Browser pages must use
`product/browser/api.ts` and only these routes. All JSON. Times are **session milliseconds**
(`SessionMs`, ms since session creation) unless the name ends in `EpochMs`.

## Auth

- **Reviewer** (interviewer, judge, operator): header `x-reviewer-token: <REVIEWER_TOKEN>`.
  The browser asks for it once and keeps it in `sessionStorage['sg.reviewerToken']`.
- **Candidate**: header `x-session-key: <candidateKey>` for one session. Candidate link is
  `/candidate.html#s=<sessionId>&k=<candidateKey>` (fragment, so it never reaches server logs).
- Routes marked **R** need reviewer, **C** need candidate key, **R|C** accept either.
- Errors: HTTP 4xx/5xx with `{ "error": { "code": string, "message": string } }`.

## Static

- `/` → `index.html` (reviewer home: create/list sessions, ops panel, links)
- `/candidate.html`, `/reviewer.html?s=<id>`, `/sandbox.html`, `/report.html?s=<id>`
- `/style.css`, `/pcm-worklet.js`
- `/js/<path>.js` → compiled modules. Browser code lives at `/js/product/browser/*.js` and imports
  foundation modules relatively: `../../src/media/wav.js`, `../../src/shared/decision.js`, etc.
- CSP: `script-src 'self'` — **no inline scripts or inline event handlers**. Use `<script type="module" src=...>`.

## Routes

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/api/ops` | R | – | `OpsView` |
| GET | `/api/sessions` | R | – | `{ sessions: SessionSummary[] }` |
| POST | `/api/sessions` | R | `{ displayName, kind: 'interview'\|'sandbox', sandbox?: { scenario, label, notes?, switchOnsetSec? } }` | `{ sessionId, candidateKey, candidateUrl, view: ReviewerView }` |
| GET | `/api/sessions/:id` | R | – | `ReviewerView` |
| GET | `/api/sessions/:id/candidate` | C | – | `CandidateView` |
| GET | `/api/sessions/:id/clock` | R\|C | – | `{ sessionMs }` |
| POST | `/api/sessions/:id/consent` | C (R for sandbox) | `{ voiceAnalysis: true, camera: boolean, retention: true }` | `CandidateView` |
| POST | `/api/sessions/:id/enrollment` | C (R for sandbox) | raw `audio/wav`, header `x-capture-metadata` = URI-encoded JSON `{startMs,endMs}`, header `x-operation-id` | `{ accepted: boolean, reason: string, attempt: EnrollmentAttempt }` |
| POST | `/api/sessions/:id/control` | R\|C | `{ action: 'start'\|'pause'\|'resume'\|'end' }` | `CandidateView` |
| POST | `/api/sessions/:id/answers/start` | R\|C | `{ questionId }` | `CandidateView` |
| POST | `/api/sessions/:id/answers/end` | R\|C | `{}` | `CandidateView` |
| POST | `/api/sessions/:id/windows` | C (R for sandbox) | raw `audio/wav`, `x-capture-metadata` = `{startMs,endMs,source:'candidate_microphone'\|'labelled_upload'}`, `x-operation-id` | `{ windowId, coverage, reason? }` (check runs in background) |
| POST | `/api/sessions/:id/interruptions` | C | `{ kind: 'interrupted'\|'resumed', reason, atMs }` | `{ ok: true }` |
| POST | `/api/sessions/:id/video` | C | raw complete `video/webm` or `video/mp4` clip (≤4 MB, ≤30 s), `x-capture-metadata` = `{startMs,endMs}`; needs camera consent and a live/paused session | `{ mediaName, evicted: string[] }` |
| GET | `/api/sessions/:id/evidence/:evidenceId/context` | R | – | `VideoContext` (clips ±5 s with explicit gaps) |
| POST | `/api/sessions/:id/thumbnails` | C | raw `image/jpeg` (≤200 KB), header `x-at-ms` | `{ ok: true }` |
| POST | `/api/sessions/:id/transcript` | C | `{ phrases: [{ id, startMs, endMs, text }] }` (1–20, needs `consent.transcript`, live/paused/ended; idempotent by id) | `{ accepted }` |
| GET | `/api/sessions/:id/media/:name` | R | – | `audio/wav` or `image/jpeg` (404 after deletion/retention purge) |
| POST | `/api/sessions/:id/evidence/:evidenceId/resolutions` | R | `{ disposition: 'request_reverification'\|'reviewed'\|'escalate', notes, reviewerId }` | `ReviewerView` |
| POST | `/api/sessions/:id/challenges` | R | `{ reason? }` | `ReviewerView` (compatibility: same as a reviewer review request) |
| POST | `/api/sessions/:id/challenges/:cid/submit` | C | raw `audio/wav`, `x-capture-metadata` = `{startMs,endMs}`, header `x-transcript` = URI-encoded browser transcript or empty, `x-operation-id` | `{ challenge: ChallengeView }` |
| POST | `/api/sessions/:id/challenges/:cid/assist` | R | `{ phraseHeard: boolean, notes, reviewerId }` | `ReviewerView` |
| POST | `/api/sessions/:id/join` | R | `{ reviewerId }` | `ReviewerView`. Any reviewer-token holder may join an interview that is not completed (410 `interview_completed` otherwise). Joining records the interviewer once; both sides then share the same session. |
| POST | `/api/sessions/:id/review-requests` | R\|C | `{ reason?, reviewerId? }` | Opens a re-evaluation (`rr-<n>-<hex>`) and issues version 1 (a one-use phrase). Candidate key → `CandidateView`, reviewer → `ReviewerView`. 409 if one is already open. Works after the interview ended. |
| POST | `/api/sessions/:id/review-requests/:rid/versions` | R\|C | `{}` | New voice response (new phrase, next version; max 3). Candidate only after the phrase expired; reviewer after an evaluation or expiry. |
| POST | `/api/sessions/:id/review-requests/:rid/close` | R | `{ outcome: 'reviewed'\|'escalated', notes, reviewerId }` | Closes the request; an unanswered phrase is withdrawn. |
| GET | `/api/sessions/:id/export` | R | – | JSON evidence export (download) |
| DELETE | `/api/sessions/:id/profile` | R | – | `ReviewerView` (Detectif speaker deleted; monitoring interrupted) |
| DELETE | `/api/sessions/:id` | R | – | `{ deleted: true }` (session, media, and remote speaker removed) |

## View shapes (see `product/server/views.ts` for the exact TypeScript)

```ts
type Status = 'consent' | 'enrollment' | 'ready' | 'live' | 'paused' | 'ended';

interface CandidateView {
  sessionId: string; displayName: string; status: Status; kind: 'interview'|'sandbox';
  consent?: { voiceAnalysis: boolean; camera: boolean; retention: boolean; atMs: number };
  enrolled: boolean; enrollmentAttempts: number;
  questions: { id: string; text: string }[];
  answeredQuestionIds: string[];
  openAnswer?: { id: string; questionId: string; startMs: number };
  monitoring: 'not_started'|'checking'|'interrupted'|'ended';   // never shows detection outcome to the candidate
  pendingChallenge?: { id: string; phrase: string; expiresAtMs: number };
  windowMs: number;          // analysis window length to use (default 7000)
  nowMs: number;
}

interface WindowView extends AudioWindow {           // AudioWindow from src/shared/contracts.ts
  result?: WindowResult;                              // separate speaker + authenticity results
  mediaName?: string;                                 // for /media/:name; absent when purged
}

interface ReviewerView {
  sessionId: string; kind: 'interview'|'sandbox'; status: Status; displayName: string;
  candidateUrl: string; createdAtEpochMs: number; nowMs: number;
  consent?: CandidateView['consent'];
  enrollment?: EnrollmentReference; enrollmentAttempts: EnrollmentAttempt[];
  decision: Decision;                                 // from decide(); state + reasons
  checkAgeMs?: number;                                // nowMs - decision.latestCompletedCheckMs
  questions: Question[]; answers: Answer[]; openAnswer?: { id; questionId; startMs };
  windows: WindowView[];
  evidence: Array<EvidenceInterval & { resolutions: ReviewerResolution[]; videoContext: VideoContext }>;
  interruptions: CaptureInterruption[];
  challenges: ChallengeView[];
  thumbnails: { atMs: number; mediaName: string }[];
  videoClips: { startMs: number; endMs: number; mediaName: string }[];   // retained video (rolling 120 s + evidence context)
  coverage: { checkedMs: number; skippedMs: number; failedMs: number; pendingMs: number; gaps: Interval[] };
  usage: { providerCalls: number; creditsCharged: number };
  sandbox?: { scenario: string; label: string; notes?: string; switchOnsetSec?: number };
  retention: { mediaRetentionHours: number };
}

interface EnrollmentAttempt {
  id: string; atMs: number; durationMs: number; localVoicedSec: number;
  authenticity?: { status: 'complete'|'failed'|'missing'|'inconclusive'; verdict?: 'real'|'fake'|'not_sure'; error?: CheckError };
  enrolled: boolean; reason: string; mediaName?: string;
}

interface ChallengeView extends VerificationChallenge {   // from contracts
  status: 'issued'|'expired'|'submitted'|'checked';
  transcript?: string; transcriptSource?: 'browser_speech_recognition'|'none';
  phraseComparison?: { matched: boolean; matchedWords: number; totalWords: number };
  reviewerAssist?: { phraseHeard: boolean; notes: string; reviewerId: string; atMs: number };
  window?: WindowView;
}

interface VideoContext {
  requested: Interval; complete: boolean; gaps: Interval[];
  clips: { startMs: number; endMs: number; mediaName: string; mimeType: string }[];
}

interface OpsView {
  detectif: { configured: boolean; health?: unknown; credits?: unknown; error?: string };
  queue: { active: number; waiting: number; concurrency: number; maxWaiting: number };
  sessions: number; mediaRetentionHours: number; storage: string;
}
```

## Rules the UI must keep

- Show identity (speaker) and authenticity as **separate** indicators. Never combine them, never show
  similarity as a percentage (label it "similarity (not a probability)" with its threshold).
- `result.provenance` is shown verbatim: `detectif_live` vs `test_fixture`.
- Skipped / failed / pending windows are visible gaps, never green.
- A later success never hides an earlier flag; resolutions are listed under the evidence they resolve.
- Candidate view never shows detection outcomes. There is no automatic rejection anywhere.
- Thumbnails are labelled "navigation aid — not detection evidence".
- Phrase match is "not checked" when there is no transcript; gestures are not implemented.

## Join status, presence and re-evaluation (added 2026-10-16)

- `joinStatus`: `waiting_for_candidate` (consent/enrollment) · `ready_to_join` (reference accepted) · `in_progress` (live/paused) · `completed` · `not_applicable` (sandbox). Shown in `ReviewerView` and `SessionSummary`.
- Presence: `candidateConnected` / `interviewer.connected` are true when that side fetched its view within 15 s.
- Interview controls (`/control`) accept the reviewer token, so the interviewer can start, pause, resume and end without any candidate action.
- `ReviewerView.reviewRequests[]`: `{ id, requestedBy, reason, evidenceId?, status, evaluationVersion?, outcome?, versions[] }`. Each version holds `{ version, challengeId, submittedAtMs?, transcript?, audioMediaName?, challenge, evaluation? }`, and `evaluation` links the reverify window's speaker and authenticity results. Status is derived: `awaiting_response` → `response_submitted` → `evaluated` → `reviewed`/`escalated` (or `expired` when a phrase lapses).
- `CandidateView` adds `interviewer: { joined, connected }`, `reviewRequest?` (id, status, versions) and `canRequestReevaluation`. Candidates never see detection results.
- Summaries add `interviewerJoined`, `candidateConnected`, `openReviewRequests`, `reviewRequestsToReview` and `escalated` (flags whose latest resolution is escalate, plus escalated requests).

## Voice-consistency screening and gesture checks (added 2026-10-16)

- **Local screening** (`product/server/voice-analysis.ts`). After enrollment a timbre and pitch profile is stored (no audio). Every monitor window, joined to the last 4 s of the previous contiguous window, is scanned in 1.5 s slices. Signals: `speaker_change_suspected` and `multiple_voices_suspected`. Each signal triggers one targeted DetectifAI combined check of just that stretch (±0.5 s, 4.5–15 s, its own independent WAV window with `targetedFrom`). Only that check's result can create evidence. The budget is `TARGETED_CHECKS` per session (default 8).
  - `ReviewerView.voiceSignals[]`: `{ id, kind, startMs, endMs, strength, detail, windowIds, targetedWindowId?, targetedSkipped?, targeted? }`; `targetedChecks: { used, max }`; `voiceProfileReady`.
- **Gesture checks.** `POST /api/sessions/:id/gestures` (R) `{ gesture: thumbs_up|thumbs_down|raise_right_hand|raise_left_hand|point_one_finger|wave_hello|random, reviewerId }`. Needs camera consent and a live or paused interview, one at a time. The candidate gets 30 s (`CandidateView.pendingGesture`).
  - `POST /api/sessions/:id/gestures/:gid/report` (C) `{ status: performed|not_performed|unavailable, detectedAtMs?, confidence?, observed?, frames?, handFrames?, reason?, snapshot? (JPEG data URL ≤200 KB) }`, one result per check.
  - Verdicts are derived. `completed`: seen before the deadline. `suspicious`: not seen, no response within 30 s + 10 s grace, or a late result. `unverified`: camera or detector unavailable. `pending`.
  - MediaPipe runs in the candidate's browser (`/vendor/mediapipe/*` from `@mediapipe/tasks-vision@1.0.1`; the model is fetched from storage.googleapis.com). Video is not analysed on the server; the reviewer sees the snapshot and the video clips around the check.
