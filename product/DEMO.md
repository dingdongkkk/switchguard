# SwitchGuard demo script (about 6 minutes)

Two browser windows: **Reviewer** (laptop) and **Candidate** (second laptop or a second Chrome profile with a
headset). One consenting presenter is the enrolled candidate; a second consenting person plays the "switch".
Everything shown is a live DetectifAI result unless the badge says `test_fixture`.

## Before you start (5 minutes, not on stage)

1. Check credits on the home page's Operations panel. Each combined check costs **100 credits**. Have at least
   **1,000** available, and set `WINDOW_MS=15000` so a 2-minute interview uses about 8 checks.
2. `npm run dev` (or the container, see `product/README.md`), then sign in with the reviewer token.
3. Use Chrome. The microphone and camera need `localhost` or HTTPS.
4. Do a dry-run enrollment with the presenter, then delete that session from the home page.

## Script

| # | Say | Do |
|---|---|---|
| 1 | "Remote interviews have a new failure mode: the person who passes the screen isn't the person answering." | Home page: **New interview**, then copy the candidate link to the candidate window. |
| 2 | "Consent first, and it's explicit: this checks voice continuity, not real-world identity." | Candidate ticks voice analysis + retention (+ camera), then **Continue**. |
| 3 | "We record a 20-second reference. Before we accept it, DetectifAI checks it isn't synthetic." | Candidate reads the paragraph. The reviewer shows the enrollment attempt: authenticity `real`, accepted. |
| 4 | "From here every answer is checked in short windows against that original reference, with identity and authenticity kept separate." | **Start interview** → **Start answer** on Q1. The presenter answers for ~30 s. The reviewer shows green windows, check age and pending count. |
| 5 | "Now the switch." | Q2: the presenter starts answering, then the second person takes over mid-answer. |
| 6 | "The flag is tied to the answer and the exact interval. The system doesn't reject anyone." | Reviewer: a red segment on Q2 → **Evidence**: no_match, similarity (not a probability), audio before/flagged/after, video context. |
| 7 | "A human decides. They can ask for fresh proof." | Resolution: **Request re-verification** with a note. A 5-word phrase appears on the candidate screen. |
| 8 | "Fresh, one-use, expiring phrase, checked against the *original* reference." | The presenter (the real candidate) reads it. The reviewer shows phrase matched / speaker match / authenticity, each separately. The earlier flag stays. |
| 9 | "Judges can try it themselves on labelled samples, through the same pipeline." | **Sandbox**: run scenario 2 (different speaker) and 5 (silence). Show detected/missed counts with `n = trials`. Never quote accuracy. |
| 10 | "And it cleans up after itself." | **Export JSON**, **Print report**, then **Delete session**. Media URLs return 404 afterward. |

## Honest answers to likely questions

- *Accuracy?* "We haven't measured it. These are a handful of trials, shown with their counts. DetectifAI's deepfake model is tuned for English."
- *Lip-sync deepfakes?* "Video is context for the reviewer only. We don't classify video."
- *Gestures?* "Not implemented. The phrase challenge plus a reviewer-assisted path covers re-verification."
- *What if the API fails?* "The window shows as failed or inconclusive, never as passed, and a request failure on its own never raises a flag."

## If something goes wrong on stage

- **No windows turn green:** check the Operations panel (credits, Detectif health) and the candidate's microphone meter.
- **Enrollment refused as `not_sure`:** move somewhere quieter and re-record. Any refused attempt stays visible to the reviewer.
- **Credits run out:** the flag on Q2 and its evidence remain. Show those, then go to the sandbox explanation.
