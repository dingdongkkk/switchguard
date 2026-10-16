# Backend production checklist

Audit of `product/server` + `src/server/detectif.ts` before deployment (2026-10-16). Each item lists the risk
found, the fix, and the test that proves it. Status: ✅ done and tested · ⚠️ documented limit.

## Stability

| # | Risk found | Fix | Proof |
|---|---|---|---|
| 1 | Voice analysis ran on the request thread (~110 ms per window, ~140 ms per profile), so concurrent interviews would stall every request. | Analysis runs in a worker thread with a bounded queue and a per-job timeout. A hung or crashed worker is restarted, and a skipped analysis is recorded, never treated as a pass. | `voice analysis runs off the request thread` |
| 2 | Any unhandled promise rejection would crash the process. Shutdown dropped pending writes. | `unhandledRejection` is logged without exiting. `uncaughtException` flushes and exits (the supervisor restarts it). SIGTERM/SIGINT stop accepting requests, wait for in-flight checks (≤10 s), flush, then exit. | `main.ts`; restart test |
| 3 | Bad configuration (PORT, retention values, unwritable `DATA_DIR`) failed late or silently. | Validated at startup with a clear message and exit code 2. Checks: PORT, numeric limits, REVIEWER_TOKEN (≥16 chars, required in production), ALLOWED_HOSTS when public, DATA_DIR writable, port already in use. | Startup run, 2026-10-16: each bad setting refused with its message |
| 4 | A full disk while saving media gave a generic 500. | Mapped to `507 storage_full`. Health reports storage errors. | `health reports storage` |

## Persistence

| # | Risk found | Fix | Proof |
|---|---|---|---|
| 5 | The whole session JSON was rewritten synchronously on every mutation, including thumbnails and video clips (~1 MB/hour per session). | Saves are batched (250 ms) and still atomic (tmp + rename). They are flushed on idle, shutdown and crash; deletion cancels a pending save. | all restart and deletion tests |
| 6 | Purged-media entries were never removed from session records. | Entries purged by the rolling buffer or thumbnail cap are dropped after 10 minutes and counted in `mediaPruned`. | `retention compacts records` |
| 7 | Sessions were kept forever. | `SESSION_RETENTION_DAYS` (default 30; 0 = keep). Expired sessions are deleted with their media and remote speaker profile. A failed remote delete is retried on the next sweep. | `old sessions expire` |
| 8 | A corrupt session file was silently skipped on startup. | Moved aside as `<id>.json.corrupt-<time>` and logged. Other sessions still load. | `corrupt session file is quarantined` |

## Security and abuse

| # | Risk found | Fix | Proof |
|---|---|---|---|
| 9 | The reviewer token could be guessed without limit. | 20 failed reviewer attempts per IP in 10 minutes → `429` for 10 minutes. | `reviewer token brute force is throttled` |
| 10 | No request-flood protection. | Per-IP token bucket (burst 300, 60 requests/s), comfortably above normal polling and uploads. | `request flood is throttled` |
| 11 | No HSTS behind HTTPS. Proxy IPs were not trusted or handled. | `Strict-Transport-Security` when served over HTTPS (`TRUST_PROXY=1` honours `X-Forwarded-Proto`/`-For`). | header test |
| 12 | Path traversal and malformed requests had not been tested. | Fuzz suite: traversal, bad IDs, bad JSON, wrong content types, oversized bodies, unknown routes. All return 4xx and the server keeps serving. | `malformed requests never crash` |

## Provider and cost

| # | Risk found | Fix | Proof |
|---|---|---|---|
| 13 | Targeted voice checks could drain a low credit balance. | The last balance DetectifAI reported is tracked. Below `LOW_CREDIT_THRESHOLD` (default 300), targeted checks are skipped and the reason is shown. Regular window checks continue. | `low credits skip targeted checks` |
| 14 | Provider outage, credit exhaustion and full queues | Already fail honestly (failed/inconclusive, never a pass) with capped retries and stable idempotency keys. | existing outage/partial tests |

## Operations

| # | Risk found | Fix | Proof |
|---|---|---|---|
| 15 | Health always returned ok. | `/api/health`: storage writable, voice worker state, queue, uptime, Detectif configured (no secrets). Returns `503` when storage is failing. Used by the Docker HEALTHCHECK. | `health reports storage` |
| 16 | No access log. | One JSON line per API request (method, path, status, ms, IP). No tokens, keys or query strings. Routine polls are logged only on errors. `ACCESS_LOG=0` disables it. | Production run, 2026-10-16 |
| 17 | Untested routes: thumbnails, ops, clock, static pages and vendor files. | Covered by an every-route test. | `every route answers` |
| 18 | Concurrency was never exercised. | Parallel sessions and parallel uploads keep consistent records with no lost windows or duplicated checks. | `parallel sessions and uploads` |

## Known limits (by design for this prototype)

- ⚠️ **Single process.** Sessions live in memory and on local disk. Run one instance, or put a sticky load balancer and shared storage in front before scaling out.
- ⚠️ **Durability window.** A hard kill can lose up to 250 ms of changes. Pending provider checks are re-run with the same idempotency key, so no credits are charged twice.
- ⚠️ **Gesture results come from the candidate's browser** (MediaPipe). The reviewer verifies them with the snapshot and video.
- ⚠️ **Local voice screening** has been measured on synthetic voices only. It can only trigger DetectifAI checks, not evidence.

## Verification (2026-10-16)

- `npm test` at the root: **67/67 pass** (23 foundation + 44 product). The runner exits cleanly: the voice worker no longer holds the process open.
- `npm run check`: both TypeScript projects are clean.
- Production entrypoint run (`NODE_ENV=production`). Every invalid setting was refused with its message. Health returned storage/worker/queue state with no secrets. The access log printed one JSON line per request. SIGTERM stopped the process cleanly and saved the session created just before.
- Fuzz case found and fixed: an oversized upload used to hang the connection for 60 s. Now it gets `413` in under a second (declared size is checked first; the rest of the body is discarded or the connection cut).
- Fuzz case found and fixed: a wrong audio content type returned 400 instead of 415 (content type is now checked before metadata).
