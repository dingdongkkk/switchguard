/** UI preview server with a SCRIPTED DetectifAI stand-in. Every result it produces carries
 * provenance 'test_fixture' and is shown as such in the UI — never present it as a live result.
 * It seeds one interview with a match, a speaker mismatch on question 2, a synthetic flag and a
 * challenge, plus one sandbox run, so reviewer pages can be checked visually without credits.
 * Usage: PORT=3101 node dist/product/scripts/fixture-server.js  (reviewer token: fixture-reviewer) */
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DetectifClient } from '../../src/server/detectif.js';
import { encodeWav } from '../../src/media/wav.js';
import { createProductApp } from '../server/app.js';
import { SwitchGuardService, defaultConfig } from '../server/service.js';

const RATE = 16000;
/** Voice-like test audio: harmonics shaped by formants. Pitch ≥150 Hz uses timbre A, lower uses B
 * (so the fixture's "other speaker" windows sound like a different voice to the local screening). */
const VOICE_C: Array<[number, number, number]> = [[750, 130, 1], [1300, 160, 0.8], [2200, 240, 0.4]];
function speechLike(seconds: number, pitch = 190, timbre?: Array<[number, number, number]>): Uint8Array { return encodeWav(voicePcm(seconds, pitch, timbre), RATE); }
function voicePcm(seconds: number, pitch = 190, timbre?: Array<[number, number, number]>): Float32Array {
  const formants: Array<[number, number, number]> = timbre ?? (pitch >= 150 ? [[650, 120, 1], [1100, 150, 0.6], [2500, 250, 0.3]] : [[450, 110, 1], [1800, 170, 0.7], [2800, 250, 0.35]]);
  const x = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE, f = pitch * (1 + 0.06 * Math.sin(t * 2.1) + 0.03 * Math.sin(t * 5.3));
    phase += (2 * Math.PI * f) / RATE;
    let v = 0;
    for (let h = 1; h <= 25 && f * h <= 7000; h++) { let w = 0; for (const [F, B, a] of formants) w += a * Math.exp(-0.5 * ((f * h - F) / B) ** 2); v += (Math.sin(h * phase) * (0.02 + w)) / h ** 0.3; }
    x[i] = 0.12 * v * ((t * 4.2) % 1 < 0.75 ? 1 : 0.05);
  }
  return x;
}
const joined = (...parts: Float32Array[]) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return encodeWav(o, RATE); };
let mode: { decision: 'match' | 'no_match'; verdict: 'real' | 'fake' | 'not_sure' } = { decision: 'match', verdict: 'real' };
const fake: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname.replace('/v1', '');
  const form = init?.body instanceof FormData ? init.body : undefined;
  const body = path === '/deepfake/detect' ? { request_id: 'fixture', result: { verdict: 'real' }, credits: { charged: 50 } }
    : path === '/speakers/enroll' ? { request_id: 'fixture', operation_id: 'fixture', speaker: { speaker_id: form?.get('speaker_id') }, quality: { speech_seconds: 18 }, credits: { charged: 50 } }
    : path === '/speakers/verify' ? { request_id: 'fixture', operation_id: 'fixture', model: { name: 'fixture', version: '0' }, latency_ms: 850, credits: { charged: 100 },
      result: { decision: mode.decision, similarity: mode.decision === 'match' ? 0.74 : 0.18, threshold: 0.53, duration_seconds: 7 },
      deepfake: { verdict: mode.verdict, decided_by: 'main_model', score: mode.verdict === 'fake' ? 0.97 : 0.1, segments: [{ start: 2, end: 4, score: mode.verdict === 'fake' ? 0.95 : 0.1 }], operation_id: 'fixture' } }
    : path === '/health' ? { status: 'ok', note: 'fixture' } : path === '/credits' ? { plan: 'fixture', available: null } : { deleted: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

const root = resolve(fileURLToPath(import.meta.url), '../../../../..');
let clock = Date.now() - 10 * 60_000;
const service = new SwitchGuardService(new DetectifClient('fixture', fake, async () => {}), { ...defaultConfig(mkdtempSync(join(tmpdir(), 'sg-fixture-'))), provenance: 'test_fixture', now: () => clock });

const rec = service.createSession({ displayName: 'Fixture candidate (TEST DATA)' });
service.consent(rec, { voiceAnalysis: true, camera: true, retention: true });
clock += 30_000;
await service.enroll(rec, speechLike(20), { startMs: 5000, endMs: 25000 }, 'fixture-enroll-1');
service.control(rec, 'start');
let t = 32_000;
const win = async (mods: typeof mode, seconds = 7, pitch = 180) => { mode = mods; clock = rec.session.createdAtEpochMs + t + seconds * 1000 + 50; await service.submitWindow(rec, speechLike(seconds, pitch), { startMs: t, endMs: t + seconds * 1000 }, `fixture-w-${t}`); await service.idle(); t += seconds * 1000; };
clock = rec.session.createdAtEpochMs + t; service.startAnswer(rec, 'q1');
await win({ decision: 'match', verdict: 'real' }); await win({ decision: 'match', verdict: 'real' });
clock += 10; service.endAnswer(rec); t += 1500;
clock = rec.session.createdAtEpochMs + t; service.startAnswer(rec, 'q2');
await win({ decision: 'match', verdict: 'real' }); await win({ decision: 'no_match', verdict: 'real' }, 7, 120); await win({ decision: 'no_match', verdict: 'not_sure' }, 7, 120);
await win({ decision: 'match', verdict: 'real' }, 3);
clock += 10; service.endAnswer(rec); t += 1500;
clock = rec.session.createdAtEpochMs + t; service.startAnswer(rec, 'q3');
await win({ decision: 'match', verdict: 'fake' }); await win({ decision: 'match', verdict: 'real' });
clock += 10; service.endAnswer(rec); t += 1500;
// Q4: half answered by the candidate, half by a second person. Q5: answered by a third voice.
clock = rec.session.createdAtEpochMs + t; service.startAnswer(rec, 'q4');
{ mode = { decision: 'match', verdict: 'real' }; const w = joined(voicePcm(7, 190), voicePcm(8, 120)); clock = rec.session.createdAtEpochMs + t + 15_100;
  await service.submitWindow(rec, w, { startMs: t, endMs: t + 15_000 }, `fixture-split-${t}`); await service.idle(); t += 15_000; }
clock += 10; service.endAnswer(rec); t += 1500;
clock = rec.session.createdAtEpochMs + t; service.startAnswer(rec, 'q5');
{ mode = { decision: 'no_match', verdict: 'real' }; clock = rec.session.createdAtEpochMs + t + 15_100;
  await service.submitWindow(rec, speechLike(15, 150, VOICE_C), { startMs: t, endMs: t + 15_000 }, `fixture-third-${t}`); await service.idle(); t += 15_000; }
clock += 10; service.endAnswer(rec);
// Test-pattern video clips (ffmpeg testsrc, NOT a person) every 5 s across the interview, with one
// deliberate 2 s hole, so the reviewer's video-context panel and its gap reporting can be checked.
try {
  const dir = mkdtempSync(join(tmpdir(), 'sg-fixture-video-')), file = join(dir, 'clip.webm');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=5', '-c:v', 'libvpx', '-b:v', '200k', '-y', file]);
  const clipBytes = new Uint8Array(readFileSync(file));
  for (let s = 32_000; s + 5_000 <= t; s += 5_000) {
    if (s === 67_000) continue; // gap
    clock = rec.session.createdAtEpochMs + s + 5_050;
    service.addVideoClip(rec, clipBytes, { startMs: s, endMs: s + 5_000 }, 'video/webm');
  }
} catch (error) { console.warn(`fixture video skipped (ffmpeg unavailable?): ${(error as Error).message}`); }
service.resolve(rec, rec.session.evidence[0]!.id, { disposition: 'request_reverification', notes: 'Voice on Q2 sounds different (fixture note).', reviewerId: 'Fixture reviewer' });
// The request_reverification above opened a re-evaluation; answer it so version 1 has an evaluation.
{
  const rr = rec.reviewRequests?.[0], c = rr && rec.session.challenges.find(x => x.id === rr.versions[0]!.challengeId);
  if (c) {
    mode = { decision: 'match', verdict: 'real' };
    const start = t + 2000; clock = rec.session.createdAtEpochMs + start + 8_100;
    await service.submitChallenge(rec, c.id, speechLike(8), { startMs: start, endMs: start + 8000 }, encodeURIComponent(c.phrase), 'fixture-reverify-1');
    await service.idle();
  }
}
// Gesture checks: one performed (test-pattern snapshot, not a person), one missed.
{
  let snapshot: string | undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sg-fixture-snap-')), file = join(dir, 'snap.jpg');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=1', '-frames:v', '1', '-y', file]);
    snapshot = readFileSync(file).toString('base64');
  } catch { /* no ffmpeg: no snapshot */ }
  clock = rec.session.createdAtEpochMs + t + 12_000;
  const g1 = service.requestGesture(rec, { gesture: 'thumbs_up', reviewerId: 'Fixture reviewer' });
  clock += 4_200;
  service.reportGesture(rec, g1.id, { status: 'performed', detectedAtMs: g1.issuedAtMs + 3_600, confidence: 0.88, frames: 61, handFrames: 44, snapshot });
  const g2 = service.requestGesture(rec, { gesture: 'raise_hand', reviewerId: 'Fixture reviewer' });
  clock += 31_000;
  service.reportGesture(rec, g2.id, { status: 'not_performed', observed: ['Raised right hand', 'Open hand'], frames: 455, handFrames: 120 });
  clock += 1_000;
}
// Real clock from here so the live views stay fresh.
const offset = clock - Date.now();
(service.config as { now: () => number }).now = () => Date.now() + offset;
clock = Date.now() + offset;

const sb = service.createSession({ kind: 'sandbox', displayName: 'Sandbox fixture', sandbox: { scenario: 'speaker_switch', label: 'Different speaker from 14 s (fixture)', switchOnsetSec: 14 } });
service.consent(sb, { voiceAnalysis: true, retention: true });
await service.enroll(sb, speechLike(20), { startMs: 0, endMs: 20000 }, 'fixture-sb-enroll');
service.control(sb, 'start');
for (let i = 0; i < 4; i++) { mode = { decision: i >= 2 ? 'no_match' : 'match', verdict: 'real' }; await service.submitWindow(sb, speechLike(7), { startMs: i * 7000, endMs: (i + 1) * 7000, source: 'labelled_upload' }, `fixture-sb-${i}`); await service.idle(); }
mode = { decision: 'match', verdict: 'real' };

const port = Number(process.env.PORT ?? 3101);
createProductApp(service, { reviewerToken: 'fixture-reviewer', root, judgeDemo: true }).listen(port, '127.0.0.1', () => {
  console.log(`FIXTURE server (scripted DetectifAI, provenance test_fixture): http://127.0.0.1:${port}  reviewer token: fixture-reviewer`);
  console.log(`interview: /reviewer.html?s=${rec.session.id}   candidate: /candidate.html#s=${rec.session.id}&k=${rec.candidateKey}   sandbox: /reviewer.html?s=${sb.session.id}`);
});
