# SwitchGuard

Interview voice-continuity prototype with separate speaker and authenticity checks, answer-linked evidence and human review.

## Run

Use Node 22 or newer. From this directory:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. The server prints a reviewer token unless you set `REVIEWER_TOKEN`. Sign in on the home page, create a session and open its candidate link. Recording requires the participant's consent.

`DETECTIF_API_TOKEN` must be available to the server environment or in a root `.env` file. The existing MCP setup already exports it for local shells. Never put it in browser code. Session/media storage defaults to `product/data/`, which is ignored by Git. See `product/README.md` for retention and configuration.

## Commands

- `npm test`: foundation and product fixture tests; no live Detectif calls.
- `npm run check`: type-check both projects.
- `npm run build`: compile both projects.
- `npm start`: launch the compiled product.
- `npm run preview:fixture`: scripted UI preview on port 3101, reviewer token `fixture-reviewer`. All detection results are fixtures, not live analysis.

## Project layout

- `src/shared/`: contracts and deterministic decision engine.
- `src/server/detectif.ts`: shared server-only provider client.
- `src/media/`: WAV capture utilities and context buffer.
- `product/`: Claude's application, browser capture, screens, storage and HTTP API.
- `src/server/app.ts`: earlier API-only development draft; not the default application.

The overwrite has been repaired and both layers pass their tests. Real consenting-human browser verification remains pending; consented video context is implemented and gestures are not implemented. See `BUILD_STATUS.md` for the exact gate, `AGENTS.md` for ownership, and `CLAUDE_HANDOFF.md` for continuation.

The reviewer UI uses a paper-toned review desk and a locally served Three.js ribbon illustration. The illustration is decorative; detection results only come from the session API. Motion respects reduced-motion preferences and falls back to CSS when WebGL is unavailable.
