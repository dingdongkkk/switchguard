# SwitchGuard product layer (Jobs 3–8) — Claude Code

This folder is the product built on top of Astra's foundation. It **imports** `src/` (contracts,
decision engine, `DetectifClient` + `normalizeCombined`, WAV encoding/validation, window assembler)
and **never edits it**. It was built in an isolated folder because Astra was still finishing Job 2
in `src/`. Integration notes are at the end.

## Run

```bash
cd product
npm test            # build + 18 fixture tests (no network, provenance test_fixture)
npm run dev         # build + start on http://127.0.0.1:3000
```

Environment (put in the repo-root `.env`, which is gitignored; never in browser code):

| Variable | Meaning |
|---|---|
| `DETECTIF_API_TOKEN` | DetectifAI key, server-side only. Without it every check fails honestly (never passes). |
| `REVIEWER_TOKEN` | Reviewer/judge access token. If unset, a random one is printed at startup (required in production). |
| `WINDOW_MS` | Analysis window, default 7000 (5000–60000). See credit budget below. |
| `MEDIA_RETENTION_HOURS` | Retained audio/thumbnail lifetime, default 24. Analysis records remain after purge. |
| `PORT`, `BIND_HOST`, `ALLOWED_HOSTS`, `DATA_DIR` | Server binding; `ALLOWED_HOSTS` is needed for a non-loopback deployment. |
| `SESSION_RETENTION_DAYS` | Whole sessions (record, media, remote speaker profile) are deleted after this many days; default 30, `0` keeps them. |
| `TARGETED_CHECKS` | Targeted DetectifAI checks of locally suspicious stretches per session; default 8. |
| `LOW_CREDIT_THRESHOLD` | Below this last-reported credit balance, targeted checks are skipped; default 300. |
| `TRUST_PROXY` | `1` behind a reverse proxy: use `X-Forwarded-For` for per-IP limits and `X-Forwarded-Proto` for HSTS. |
| `ACCESS_LOG` | `0` disables the one-line-per-request JSON access log. |

Production readiness checklist and its evidence: `product/HARDENING.md`.

Pages: `/` (reviewer home + ops), `/reviewer.html?s=<id>`, `/candidate.html#s=<id>&k=<key>` (capability
link from the reviewer home), `/sandbox.html` (judge sandbox), `/report.html?s=<id>` (printable summary).

## What is implemented

- **Job 3 — consent and enrollment.** Explicit consent (voice analysis, optional camera, retention). ~20 s
  enrollment, local check for ≥10 s of speech, then **authenticity gate**: `POST /v1/deepfake/detect`; only a final
  `real` verdict proceeds to `POST /v1/speakers/enroll`. `fake` and `not_sure` are refused, and the attempt stays visible
  to the reviewer. The original reference is locked; it cannot be replaced.
- **Job 4 — interview + reviewer.** Fixed questions, explicit answer start/end, start/pause/resume/end, candidate-only
  capture streamed as independent canonical PCM16 WAV windows on the shared session clock, background combined checks
  (`detect_deepfake=true`), coverage gaps, interruptions, check age, pending count, separate identity/authenticity.
- **Job 5 — evidence + reviewer actions.** Windows link to answers. Flagged window audio comes with the previous/next windows as context, plus
  thumbnails (navigation aid only). Raw results, mapped deepfake segments, resolutions (request re-verification / reviewed / escalate, notes
  required) are stored separately from the immutable flag. Media is reviewer-only.
- **Job 6 — re-verification.** Server-generated, random 5-word phrase. Expires after 120 s, single use (consumed before
  processing), only one active at a time. Browser speech-recognition transcript is compared with an explicit
  word-order match, then fresh combined checks run against the **original** reference. Phrase, speaker and authenticity outcomes stay separate.
  A reviewer-assisted path is available (attestation recorded separately, never an automatic match). **Gestures are not implemented.**
- **Job 7 — sandbox.** Judges upload a labelled reference + test file. Both go through the same API, enrollment gate and windows
  (`labelled_upload`, file-relative timeline). Expected labels are display-only metadata.
- **Job 8 — retention and ops.** Retention sweep, session deletion (remote speaker + media + record; a failed remote
  delete keeps the session for retry), profile deletion, JSON export, printable report, ops panel (health, credits, queue).

## Short switches, several voices, gesture checks

- **Why:** DetectifAI returns one similarity per clip, so a few seconds of another voice inside a 15 s window, or someone talking over the candidate, can be averaged away.
- **Local screening:** each window (plus the join with the previous one) is screened locally in 1.5 s slices against a profile of the reference. Suspicious stretches get their own targeted DetectifAI check (budget `TARGETED_CHECKS`, default 8 per session, 100 credits each). Only DetectifAI results become evidence; the local screening is labelled as an estimate.
- **Measured on synthetic voices only:** the same voice, louder and higher-pitched, raised nothing; a mid-window switch, a 3 s intrusion, a same-pitch different-timbre voice, rapid turn-taking and two overlapping voices were all flagged. Real-speech false-alarm rates have not been measured.
- **Gesture checks:** the interviewer asks for one of six gestures (or a random one); the candidate has 30 s and MediaPipe hand tracking runs in their browser. Results are performed, suspicious (not seen, no response, or late) or could not check (no camera or detector). This is a liveness signal, not identity proof: a real-time deepfake could still perform a gesture, and the result is reported by the candidate's browser, so the reviewer gets a snapshot and the surrounding video to confirm.

## Who is speaking (Person 1, 2, 3…), split answers, exact-moment video

- **Labels:** every voiced 1.5 s slice is labelled locally. Person 1 is the enrolled voice; a new person is created only when at least two slices sound unlike everyone heard so far, so labels stay consistent across the whole interview (up to 6 people, plus "several at once").
- **Answers:** each answer shows who spoke and for how long. It is flagged as **split** when a second person spoke a real part of it (≥ 2.25 s and ≥ 15 % of its speech), with the switch time, or **answered by Person N** when the enrolled voice did not answer it.
- **Video:** the reviewer can watch exactly a flagged window, a voice-change stretch or a speaker switch; the player stitches the 5 s clips together and stops at the end. Video within 8 s of every speaker switch is kept, even if DetectifAI raised no flag.
- **Limits:** person numbers are local estimates by sound, not identities. DetectifAI confirms only whether a stretch is the enrolled voice. Tested on synthetic voices (three voices kept apart and recognised again later); real-speech accuracy is not measured.

## Verification performed (2026-10-16)

- `npm test`: **18/18 fixture tests pass** through real HTTP against a scripted DetectifAI fake. Covered: full path, gate fake/not_sure,
  short/silent audio, idempotent retries, partial failure, outage + Retry-After, missing credentials,
  reload/reconnect, access control (incl. Host/Origin), deletion, failed remote deletion, profile deletion,
  retention, challenge expiry/one-use, reviewer assist, sandbox, restart reload.
- **Live DetectifAI, macOS text-to-speech audio only (synthetic by construction; no person's voice):**
  - `npm run smoke:live`: health ok; deepfake detect on TTS → `fake` (main_model); enroll ok; same-key replay →
    `idempotent_replay: true`, 0 credits; verify same TTS voice → `match` (similarity 0.937, threshold 0.53) + `fake`;
    different TTS voice → `no_match` (0.208) + `fake`; speaker delete → `deleted: true`.
  - `npm run live:e2e`: product API enrollment with TTS → **refused by the authenticity gate** (`fake`), no profile created, session deleted.
  - These prove request/response handling, not detection accuracy.
- **Browser check (built-in browser, 2026-10-16):** reviewer sign-in, home/ops, session creation, candidate consent,
  enrollment screen (the microphone is blocked in that pane, and the page shows the error with a Reconnect button), reviewer dashboard,
  timeline, evidence with previous/flagged/next audio, resolution recording, challenge list, report, and a full sandbox
  run. Data came from `scripts/fixture-server.ts` (scripted DetectifAI, provenance `test_fixture`, shown in the UI).
  Run it with `node dist/product/scripts/fixture-server.js` (reviewer token `fixture-reviewer`) to preview the UI without credits.
- **Not yet verified live:** a consenting human enrollment and interview in a browser, the browser capture and
  speech-recognition paths, and a real speaker change. These need a consenting participant and a mic.

## Deploy

A `Dockerfile` at the repo root builds both projects, runs all tests during the build, and ships only the
compiled server, browser modules, static pages and the three.js build.

```bash
docker build -t switchguard .
docker run -p 3000:3000 -v switchguard-data:/data \
  -e DETECTIF_API_TOKEN=... -e REVIEWER_TOKEN=... -e ALLOWED_HOSTS=demo.example.com -e WINDOW_MS=15000 switchguard
```

- Put it behind HTTPS. Browsers allow the microphone and camera only on HTTPS or `localhost`.
- `REVIEWER_TOKEN` is required when `NODE_ENV=production` (the container sets it). Secrets stay in the server environment.
- `/data` holds sessions and media under the retention policy. Use a private volume.
- Verified on 2026-10-16 by booting the exact runtime file layout in production mode: all pages, modules, worklet and
  vendor files returned 200, the API returned 401 without the reviewer token, and startup without `REVIEWER_TOKEN` was refused.
  The image itself was not built here because the Docker daemon was not running.

Demo walkthrough: `product/DEMO.md`.

## Credit budget (important for the demo)

Free plan: 50 credits per operation, so a combined verify + deepfake check costs **100 credits**. After testing, the account had
about **1,650** of 2,000 left: roughly 16 combined checks. With 7 s windows that is under 2 minutes of monitored speech. For the
demo, set `WINDOW_MS=15000` or more, keep answers short, or top up credits. The ops panel shows the live balance.

## Known limitations

- Video context: while the interview is live (with camera consent), the candidate page records independent ~5 s clips on the session clock. The server keeps a rolling 120 s buffer plus every clip within 5 s of a flagged or still-pending interval. The reviewer's evidence panel plays the clips around a window and lists gaps, computed with the foundation `ContextBuffer`. Clip timestamps come from MediaRecorder start/stop events (about ±100 ms). Video is context for a person, never detection evidence.
- Phrase transcription runs in the browser (Web Speech API; Chrome sends audio to its own service). It is client-reported.
  Without it, the phrase is "not checked" and the reviewer-assisted path applies.
- Local speech estimate is a crude energy gate. It can only *skip* a window, never pass one.
- Storage is local disk JSON + files (single process). Access control is a reviewer token + per-session capability keys.
- No immutable-log claims. No multilingual claims (the deepfake model is tuned for English).

## Integration with Astra's foundation (when the gate is recorded)

- Uses unchanged: `DetectifClient`, `normalizeCombined`, `failedResult`, `providerMeta`, `PipelineError`, `object`
  (`src/server/detectif.ts`); `createSession`, `addWindow`, `applyResult`, `decide` (`src/shared/decision.ts`);
  `encodeWav`, `inspectWav`, `PcmWindowAssembler` (`src/media/wav.ts`).
- `normalizeCombined` hard-codes `provenance: 'detectif_live'`. The service overrides it from config (`test_fixture` in tests).
- Enrollment authenticity is parsed from `/v1/deepfake/detect` `result.verdict` in the service, because the foundation
  normalizer reads only verify responses. A shared helper in `detectif.ts` would be cleaner.
- `src/server/app.ts` (Astra's dev harness) and `product/server/app.ts` both exist. Suggested end state: keep the harness for
  foundation tests and make `product/server/main.ts` the app entrypoint (or move `product/` into `src/` after Astra hands off).
