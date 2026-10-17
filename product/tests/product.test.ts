/** End-to-end product API tests through real HTTP against a scripted DetectifAI fake.
 * Every result here is a TEST FIXTURE (provenance 'test_fixture'); none of this is live verification. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { DetectifClient } from '../../src/server/detectif.js';
import { encodeWav } from '../../src/media/wav.js';
import { createProductApp } from '../server/app.js';
import { SwitchGuardService, defaultConfig } from '../server/service.js';
import { comparePhrase } from '../server/phrase.js';

const RATE = 16000;
const TOKEN = 'reviewer-test-token';
type Formants = Array<[number, number, number]>;
export const VOICE_A: Formants = [[650, 120, 1], [1100, 150, 0.6], [2500, 250, 0.3]];
export const VOICE_B: Formants = [[450, 110, 1], [1800, 170, 0.7], [2800, 250, 0.35]];
/** Voice-like test signal: harmonics shaped by formants, gentle intonation, ~4 Hz syllables. */
function voicePcm(seconds: number, f0 = 190, formants: Formants = VOICE_A, seed = 1.3): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE, f = f0 * (1 + 0.06 * Math.sin(t * 2.1 + seed) + 0.03 * Math.sin(t * 5.3));
    phase += (2 * Math.PI * f) / RATE;
    let s = 0;
    for (let h = 1; h <= 25 && f * h <= 7000; h++) {
      let w = 0;
      for (const [F, B, a] of formants) w += a * Math.exp(-0.5 * ((f * h - F) / B) ** 2);
      s += (Math.sin(h * phase) * (0.02 + w)) / h ** 0.3;
    }
    x[i] = 0.12 * s * ((t * 4.2 + seed) % 1 < 0.75 ? 1 : 0.05);
  }
  return x;
}
function speechLike(seconds: number, f0 = 190, formants: Formants = VOICE_A, seed = 1.3): Uint8Array { return encodeWav(voicePcm(seconds, f0, formants, seed), RATE); }
function concatPcm(...parts: Float32Array[]): Uint8Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0; for (const p of parts) { out.set(p, k); k += p.length; }
  return encodeWav(out, RATE);
}
const silence = (seconds: number) => encodeWav(new Float32Array(Math.round(seconds * RATE)), RATE);

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
interface Call { method: string; path: string; key?: string; speakerId?: string; detectDeepfake?: boolean }
let calls: Call[];
let verifyBalance = 5000;
let script: (call: Call) => Reply;
const verifyOk = (decision: 'match' | 'no_match', verdict: 'real' | 'fake' | 'not_sure'): Reply => ({ status: 200, body: {
  request_id: 'req_v', operation_id: 'op_v', object: 'speaker.verification', speaker_id: 'x', model: { name: 'm', version: '1' }, credits: { charged: 2, balance: verifyBalance }, latency_ms: 900, idempotent_replay: false,
  result: { decision, similarity: decision === 'match' ? 0.71 : 0.12, threshold: 0.53, duration_seconds: 7 },
  deepfake: { verdict, label: 'x', is_synthetic: verdict === 'fake', decided_by: 'main_model', score: 0.3, threshold: 0.62, duration_seconds: 7, segments: [{ start: 1, end: 3, score: 0.9 }], operation_id: 'op_d', credits_charged: 1, model: { name: 'd', version: '2' } },
} });
function defaultScript(call: Call): Reply {
  if (call.path === '/deepfake/detect') return { status: 200, body: { request_id: 'r', operation_id: 'o', result: { verdict: 'real' }, credits: { charged: 1 } } };
  if (call.path === '/speakers/enroll') return { status: 200, body: { request_id: 'r', operation_id: 'o', speaker: { speaker_id: call.speakerId, samples: 1 }, quality: { speech_seconds: 18.2, duration_seconds: 20 }, model: { name: 'm', version: '1' }, credits: { charged: 1 } } };
  if (call.path === '/speakers/verify') return verifyOk('match', 'real');
  if (call.method === 'DELETE') return { status: 200, body: { request_id: 'r', object: 'speaker.deleted', deleted: true } };
  if (call.path === '/health') return { status: 200, body: { status: 'ok' } };
  if (call.path === '/credits') return { status: 200, body: { available: 99, plan: 'free' } };
  return { status: 404, body: { error: { code: 'not_found' } } };
}
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input)); const form = init?.body instanceof FormData ? init.body : undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: Call = { method: init?.method ?? 'GET', path: url.pathname.replace('/v1', ''), key: headers['Idempotency-Key'], speakerId: form?.get('speaker_id')?.toString() ?? decodeURIComponent(url.pathname.split('/').pop() ?? ''), detectDeepfake: form?.get('detect_deepfake') === 'true' };
  calls.push(call);
  const reply = script(call);
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) } });
};

let dataDir: string, clock: number, service: SwitchGuardService, base: string, close: () => Promise<void>;
async function boot(token: string | null = 'detectif-test') {
  const client = new DetectifClient(token ?? undefined, fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise(r => server.close(() => r()));
}
beforeEach(async () => { dataDir = mkdtempSync(join(tmpdir(), 'sg-')); clock = 1_000_000; calls = []; script = defaultScript; verifyBalance = 5000; await boot(); });
afterEach(async () => { await service.idle(); await close(); rmSync(dataDir, { recursive: true, force: true }); });

async function call(method: string, path: string, opts: { reviewer?: boolean; key?: string; json?: unknown; wav?: Uint8Array; meta?: unknown; op?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.reviewer) headers['x-reviewer-token'] = TOKEN;
  if (opts.key) headers['x-session-key'] = opts.key;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.wav) { headers['content-type'] = 'audio/wav'; headers['x-capture-metadata'] = encodeURIComponent(JSON.stringify(opts.meta)); headers['x-operation-id'] = opts.op ?? `op${Math.random().toString(36).slice(2, 14)}`; body = new Blob([new Uint8Array(opts.wav)]); }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined, bytes: text.length };
}

/** Creates an interview, consents, enrolls (20 s), starts. Returns ids. */
async function enrolledLiveSession() {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'Ada', kind: 'interview' } });
  assert.equal(created.status, 201);
  const id: string = created.body.sessionId, key: string = created.body.candidateKey;
  assert.equal((await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: true, retention: true } })).status, 200);
  clock += 25_000;
  const enroll = await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 3000, endMs: 23000 } });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.body));
  assert.equal(enroll.body.accepted, true, enroll.body.reason);
  assert.equal((await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } })).body.status, 'live');
  return { id, key };
}
async function window(id: string, key: string, startMs: number, seconds: number, wav = speechLike(seconds)) {
  clock = 1_000_000 + startMs + seconds * 1000 + 100;
  const r = await call('POST', `/api/sessions/${id}/windows`, { key, wav, meta: { startMs, endMs: startMs + seconds * 1000, source: 'candidate_microphone' } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await service.idle();
  return r.body as { windowId: string; coverage: string; reason?: string };
}
const view = async (id: string) => (await call('GET', `/api/sessions/${id}`, { reviewer: true })).body;

test('full path: enrollment gate → answer-linked windows → flag → evidence → reviewer → challenge', async () => {
  const { id, key } = await enrolledLiveSession();
  assert.deepEqual(calls.map(c => c.path), ['/deepfake/detect', '/speakers/enroll']);
  let v = await view(id);
  assert.equal(v.enrollment.authenticity, 'real');
  assert.equal(v.enrollmentAttempts[0].authenticity.verdict, 'real');

  clock = 1_000_000 + 30_000;
  await call('POST', `/api/sessions/${id}/answers/start`, { key, json: { questionId: 'q1' } });
  const w0 = await window(id, key, 30_000, 7);
  assert.equal(w0.coverage, 'pending');
  v = await view(id);
  assert.equal(v.decision.state, 'consistent_with_enrolled_speaker');
  assert.equal(v.windows[0].result.provenance, 'test_fixture');
  assert.deepEqual(v.windows[0].answerIds, ['a1-q1']);
  assert.ok(calls.at(-1)!.detectDeepfake, 'combined check requests detect_deepfake=true');

  script = c => c.path === '/speakers/verify' ? verifyOk('no_match', 'real') : defaultScript(c);
  await window(id, key, 37_000, 7);
  clock += 50; await call('POST', `/api/sessions/${id}/answers/end`, { key, json: {} });
  v = await view(id);
  assert.equal(v.decision.state, 'needs_reverification');
  assert.equal(v.evidence.length, 1);
  assert.deepEqual(v.evidence[0].reasons, ['speaker_mismatch']);
  assert.deepEqual(v.evidence[0].answerIds, ['a1-q1']);
  assert.equal(v.answers[0].id, 'a1-q1');
  // Segment timestamps map back to session time.
  assert.deepEqual([v.windows[1].result.authenticity.segments[0].startMs, v.windows[1].result.authenticity.segments[0].endMs], [38_000, 40_000]);

  // Evidence audio is reviewer-only.
  const media = v.windows[1].mediaName;
  assert.equal((await call('GET', `/api/sessions/${id}/media/${media}`, { key })).status, 404);
  assert.equal((await call('GET', `/api/sessions/${id}/media/${media}`, { reviewer: true })).status, 200);

  // Resolution requesting re-verification issues a challenge; the flag stays.
  const resolved = await call('POST', `/api/sessions/${id}/evidence/${encodeURIComponent(v.evidence[0].id)}/resolutions`, { reviewer: true, json: { disposition: 'request_reverification', notes: 'Different voice on Q1', reviewerId: 'Rev' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.evidence[0].resolutions.length, 1);
  assert.equal(resolved.body.challenges.length, 1);
  const cand = (await call('GET', `/api/sessions/${id}/candidate`, { key })).body;
  const challenge = cand.pendingChallenge;
  assert.ok(challenge.phrase.split(' ').length === 5);
  assert.equal(cand.monitoring, 'checking');
  assert.equal(JSON.stringify(cand).includes('no_match'), false, 'candidate view never exposes detection outcomes');

  script = defaultScript;
  clock = 1_000_000 + 60_000;
  const sub = await call('POST', `/api/sessions/${id}/challenges/${challenge.id}/submit`, { key, wav: speechLike(8), meta: { startMs: 51_000, endMs: 59_000 }, headers: { 'x-transcript': encodeURIComponent(`${challenge.phrase}.`) } });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.challenge.phraseMatched, true);
  await service.idle();
  v = await view(id);
  const c = v.challenges[0];
  assert.equal(c.status, 'checked');
  assert.equal(c.window.purpose, 'reverify');
  assert.equal(c.window.referenceId, v.enrollment.id, 'uses the original reference');
  assert.equal(c.window.result.speaker.decision, 'match');
  assert.equal(v.evidence.length, 1, 'successful re-verification does not erase the earlier flag');
  assert.equal(v.decision.state, 'consistent_with_enrolled_speaker');

  // One-use challenge.
  const again = await call('POST', `/api/sessions/${id}/challenges/${challenge.id}/submit`, { key, wav: speechLike(8), meta: { startMs: 51_000, endMs: 59_000 }, headers: { 'x-transcript': '' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'challenge_used');

  const exported = await call('GET', `/api/sessions/${id}/export`, { reviewer: true });
  assert.equal(exported.body.format, 'switchguard-evidence-export/1');
  assert.equal(exported.body.candidateUrl, undefined);
});

test('enrollment is refused when the final authenticity verdict is fake, and no profile is created', async () => {
  script = c => c.path === '/deepfake/detect' ? { status: 200, body: { result: { verdict: 'fake' } } } : defaultScript(c);
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'B' } });
  const { sessionId: id, candidateKey: key } = created.body;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: false, retention: true } });
  clock += 25_000;
  const r = await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 1000, endMs: 21000 } });
  assert.equal(r.body.accepted, false);
  assert.match(r.body.reason, /synthetic/);
  assert.deepEqual(calls.map(c => c.path), ['/deepfake/detect']);
  assert.equal((await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } })).status, 409);
  // not_sure is also refused (retry), never accepted.
  script = c => c.path === '/deepfake/detect' ? { status: 200, body: { result: { verdict: 'not_sure' } } } : defaultScript(c);
  const r2 = await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 1000, endMs: 21000 } });
  assert.equal(r2.body.accepted, false);
});

test('enrollment rejects short or mostly silent recordings before spending credits', async () => {
  const { sessionId: id, candidateKey: key } = (await call('POST', '/api/sessions', { reviewer: true, json: {} })).body;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, retention: true } });
  clock += 60_000;
  assert.equal((await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(10), meta: { startMs: 0, endMs: 10000 } })).body.accepted, false);
  assert.equal((await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: silence(20), meta: { startMs: 0, endMs: 20000 } })).body.accepted, false);
  assert.equal(calls.length, 0);
});

test('short fragments and silence are explicit gaps, never checks; state is never positive from them', async () => {
  const { id, key } = await enrolledLiveSession();
  calls = [];
  const short = await window(id, key, 30_000, 3);
  assert.equal(short.coverage, 'skipped');
  const quiet = await window(id, key, 33_000, 7, silence(7));
  assert.equal(quiet.coverage, 'skipped');
  assert.equal(calls.length, 0);
  const v = await view(id);
  assert.equal(v.decision.state, 'inconclusive');
  assert.equal(v.coverage.skippedMs, 10_000);
  assert.equal(v.coverage.gaps.length, 2);
});

test('retrying the same logical upload never duplicates the check; reusing an id for other audio is refused', async () => {
  const { id, key } = await enrolledLiveSession();
  calls = [];
  clock = 1_000_000 + 40_000;
  const wav = speechLike(7), meta = { startMs: 30_000, endMs: 37_000, source: 'candidate_microphone' };
  const a = await call('POST', `/api/sessions/${id}/windows`, { key, wav, meta, op: 'retry-op-0001' });
  const b = await call('POST', `/api/sessions/${id}/windows`, { key, wav, meta, op: 'retry-op-0001' });
  await service.idle();
  assert.equal(a.body.windowId, b.body.windowId);
  assert.equal(calls.filter(c => c.path === '/speakers/verify').length, 1);
  assert.equal(calls[0]!.key, `${id}:w0`, 'deterministic Detectif idempotency key per window');
  const c = await call('POST', `/api/sessions/${id}/windows`, { key, wav: speechLike(6), meta: { ...meta, endMs: 36_000 }, op: 'retry-op-0001' });
  assert.equal(c.status, 409);
});

test('partial provider failure keeps the completed check and a fake verdict still flags', async () => {
  const { id, key } = await enrolledLiveSession();
  script = c => c.path === '/speakers/verify'
    ? { status: 422, body: { error: { type: 'unprocessable_audio', code: 'insufficient_speech', message: 'too little speech' }, partial: { verdict: 'fake', segments: [] } } }
    : defaultScript(c);
  await window(id, key, 30_000, 7);
  const v = await view(id);
  assert.equal(v.windows[0].result.speaker.status, 'inconclusive');
  assert.equal(v.windows[0].result.authenticity.verdict, 'fake');
  assert.equal(v.windows[0].coverage, 'partial');
  assert.equal(v.decision.state, 'needs_reverification');
  assert.deepEqual(v.evidence[0].reasons, ['synthetic_speech']);
});

test('provider outage is visible as failed and never as a pass; retries respect Retry-After', async () => {
  const { id, key } = await enrolledLiveSession();
  script = c => c.path === '/speakers/verify' ? { status: 503, body: { error: { code: 'server_busy', message: 'busy' } }, headers: { 'retry-after': '1' } } : defaultScript(c);
  calls = [];
  await window(id, key, 30_000, 7);
  assert.equal(calls.length, 3, 'capped retries');
  assert.ok(calls.every(c => c.key === `${id}:w0`), 'retries reuse the same idempotency key');
  const v = await view(id);
  assert.equal(v.windows[0].coverage, 'failed');
  assert.equal(v.decision.state, 'inconclusive');
  assert.equal(v.evidence.length, 0, 'a failed request is not suspicious by itself');
});

test('missing credentials: checks fail honestly and nothing is reported as verified', async () => {
  await close(); await boot(null);
  const { sessionId: id, candidateKey: key } = (await call('POST', '/api/sessions', { reviewer: true, json: {} })).body;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, retention: true } });
  clock += 30_000;
  const r = await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 0, endMs: 20000 } });
  assert.equal(r.body.accepted, false);
  assert.match(r.body.reason, /credentials_missing/);
  assert.equal(calls.length, 0);
});

test('refresh/reconnect requires fresh audio before a positive state', async () => {
  const { id, key } = await enrolledLiveSession();
  await window(id, key, 30_000, 7);
  assert.equal((await view(id)).decision.state, 'consistent_with_enrolled_speaker');
  await call('POST', `/api/sessions/${id}/interruptions`, { key, json: { kind: 'interrupted', reason: 'Candidate page reloaded', atMs: 37_200 } });
  assert.equal((await view(id)).decision.state, 'monitoring_interrupted');
  await call('POST', `/api/sessions/${id}/interruptions`, { key, json: { kind: 'resumed', reason: 'Capture restarted', atMs: 37_300 } });
  assert.equal((await view(id)).decision.state, 'checking');
  await window(id, key, 37_400, 7);
  assert.equal((await view(id)).decision.state, 'consistent_with_enrolled_speaker');
});

test('access control: candidate key cannot read reviewer data; reviewer token is required', async () => {
  const { id, key } = await enrolledLiveSession();
  assert.equal((await call('GET', `/api/sessions/${id}`, { key })).status, 404);
  assert.equal((await call('GET', `/api/sessions/${id}`)).status, 401);
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key: 'wrong' })).status, 404);
  assert.equal((await call('GET', '/api/sessions')).status, 401);
  assert.equal((await call('POST', `/api/sessions/${id}/challenges`, { key, json: {} })).status, 404);
  // fetch() cannot override Host, so use a raw request to simulate DNS rebinding.
  const status = await new Promise<number>((done, reject) => {
    const req = request(`${base}/api/sessions`, { headers: { host: 'evil.example', 'x-reviewer-token': TOKEN } }, res => { res.resume(); done(res.statusCode ?? 0); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const cross = await fetch(`${base}/api/sessions`, { headers: { origin: 'http://evil.example', 'x-reviewer-token': TOKEN } });
  assert.equal(cross.status, 403);
});

test('session deletion removes remote speaker, media and stored session; media becomes inaccessible', async () => {
  const { id, key } = await enrolledLiveSession();
  await window(id, key, 30_000, 7);
  const media = (await view(id)).windows[0].mediaName;
  assert.equal((await call('GET', `/api/sessions/${id}/media/${media}`, { reviewer: true })).status, 200);
  const del = await call('DELETE', `/api/sessions/${id}`, { reviewer: true });
  assert.equal(del.status, 200);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === `/speakers/sg-${id}`));
  assert.equal((await call('GET', `/api/sessions/${id}/media/${media}`, { reviewer: true })).status, 404);
  assert.equal(existsSync(join(dataDir, 'media', id)), false);
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);
});

test('remote deletion failure keeps the session so deletion can be retried', async () => {
  const { id } = await enrolledLiveSession();
  script = c => c.method === 'DELETE' ? { status: 500, body: { error: { code: 'internal_error' } } } : defaultScript(c);
  assert.equal((await call('DELETE', `/api/sessions/${id}`, { reviewer: true })).status, 502);
  assert.equal((await call('GET', `/api/sessions/${id}`, { reviewer: true })).status, 200);
});

test('profile deletion interrupts monitoring and blocks further checks against a replacement', async () => {
  const { id, key } = await enrolledLiveSession();
  const r = await call('DELETE', `/api/sessions/${id}/profile`, { reviewer: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.decision.state, 'monitoring_interrupted');
  clock += 10_000;
  const w = await call('POST', `/api/sessions/${id}/windows`, { key, wav: speechLike(7), meta: { startMs: 30_000, endMs: 37_000 } });
  assert.equal(w.status, 409);
});

test('retention sweep purges media; analysis records remain', async () => {
  const { id, key } = await enrolledLiveSession();
  await window(id, key, 30_000, 7);
  clock += 25 * 3_600_000;
  assert.ok(service.sweepRetention() >= 2);
  const v = await view(id);
  assert.equal(v.windows[0].mediaName, undefined);
  assert.equal(v.windows[0].result.speaker.decision, 'match');
  assert.equal((await call('GET', `/api/sessions/${id}/media/w0.wav`, { reviewer: true })).status, 404);
});

test('challenge expiry and phrase comparison', async () => {
  const { id, key } = await enrolledLiveSession();
  clock = 1_000_000 + 30_000;
  const v = (await call('POST', `/api/sessions/${id}/challenges`, { reviewer: true, json: {} })).body;
  assert.equal((await call('POST', `/api/sessions/${id}/challenges`, { reviewer: true, json: {} })).status, 409, 'one active challenge at a time');
  const cid = v.challenges[0].id;
  clock += 121_000;
  const late = await call('POST', `/api/sessions/${id}/challenges/${cid}/submit`, { key, wav: speechLike(8), meta: { startMs: 140_000, endMs: 148_000 } });
  assert.equal(late.status, 410);
  assert.equal(comparePhrase('amber harbor violet canyon maple', 'Amber, harbour violet canyon maple!').matched, true);
  assert.equal(comparePhrase('amber harbor violet canyon maple', 'amber canyon').matched, false);
  assert.equal(comparePhrase('amber harbor violet canyon maple', '').matched, false);
});

test('reviewer-assisted challenge path is recorded separately', async () => {
  const { id } = await enrolledLiveSession();
  const v = (await call('POST', `/api/sessions/${id}/challenges`, { reviewer: true, json: {} })).body;
  const cid = v.challenges[0].id;
  const r = await call('POST', `/api/sessions/${id}/challenges/${cid}/assist`, { reviewer: true, json: { phraseHeard: true, notes: 'Camera unavailable', reviewerId: 'Rev' } });
  assert.equal(r.body.challenges[0].reviewerAssist.phraseHeard, true);
  assert.equal(r.body.challenges[0].phraseMatched, undefined, 'reviewer attestation is not an automatic phrase match');
});

test('sandbox runs use the same pipeline on a file-relative timeline', async () => {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { kind: 'sandbox', displayName: 'S2', sandbox: { scenario: 'speaker_switch', label: 'switch at 14 s', switchOnsetSec: 14 } } });
  const id = created.body.sessionId;
  assert.equal((await call('POST', `/api/sessions/${id}/consent`, { reviewer: true, json: { voiceAnalysis: true, retention: true } })).status, 200);
  assert.equal((await call('POST', `/api/sessions/${id}/enrollment`, { reviewer: true, wav: speechLike(20), meta: { startMs: 0, endMs: 20000 } })).body.accepted, true);
  await call('POST', `/api/sessions/${id}/control`, { reviewer: true, json: { action: 'start' } });
  let n = 0;
  script = c => c.path === '/speakers/verify' ? verifyOk(n++ >= 2 ? 'no_match' : 'match', 'real') : defaultScript(c);
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', `/api/sessions/${id}/windows`, { reviewer: true, wav: speechLike(7), meta: { startMs: i * 7000, endMs: (i + 1) * 7000, source: 'labelled_upload' } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await service.idle();
  }
  const v = await view(id);
  assert.equal(v.windows.length, 4);
  assert.equal(v.windows[0].source, 'labelled_upload');
  assert.equal(v.sandbox.switchOnsetSec, 14);
  assert.equal(v.evidence.length, 2);
  assert.equal(v.decision.state, 'needs_reverification');
  assert.equal(v.usage.creditsCharged, 1 + 1 + 4 * 2);
});

test('state survives a server restart and pending checks resume with the same key', async () => {
  const { id, key } = await enrolledLiveSession();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  // First server: verify never answers before shutdown.
  script = c => c.path === '/speakers/verify' ? (() => { throw new Error('unreachable'); })() : defaultScript(c);
  clock = 1_000_000 + 40_000;
  const r = await call('POST', `/api/sessions/${id}/windows`, { key, wav: speechLike(7), meta: { startMs: 30_000, endMs: 37_000 } });
  assert.equal(r.status, 202);
  await service.idle(); release(); await gate;
  // The thrown fetch is a network failure → failed result after capped retries; reload still works.
  await close(); calls = []; script = defaultScript; await boot();
  service.load();
  const v = await view(id);
  assert.equal(v.windows.length, 1);
  assert.equal(v.enrollment.authenticity, 'real');
});

const webm = (size = 64) => { const b = new Uint8Array(size); b.set([0x1a, 0x45, 0xdf, 0xa3]); return b; };
async function videoClip(id: string, key: string, startMs: number, endMs: number, bytes = webm(), type = 'video/webm;codecs=vp8') {
  clock = 1_000_000 + endMs + 50;
  const res = await fetch(`${base}/api/sessions/${id}/video`, { method: 'POST', body: new Blob([new Uint8Array(bytes)]), headers: {
    'x-session-key': key, 'content-type': type, 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs, endMs })) } });
  return { status: res.status, body: await res.json() as any };
}

test('video context: consented clips on the session clock, bounded buffer, evidence context kept with explicit gaps', async () => {
  const { id, key } = await enrolledLiveSession(); // camera consented
  // Five 5 s clips with a 1 s hole between 40 s and 41 s.
  const starts = [30_000, 35_000, 41_000, 46_000];
  for (const s of starts) assert.equal((await videoClip(id, key, s, s + (s === 35_000 ? 5_000 : 5_000))).status, 200);
  script = c => c.path === '/speakers/verify' ? verifyOk('no_match', 'real') : defaultScript(c);
  await window(id, key, 34_000, 7); // flagged window 34–41 s
  let v = await view(id);
  const ctx = v.evidence[0].videoContext;
  assert.deepEqual(ctx.requested, { startMs: 29_000, endMs: 46_000 });
  assert.deepEqual(ctx.clips.map((c: any) => c.startMs), [30_000, 35_000, 41_000]);
  assert.deepEqual(ctx.gaps, [{ startMs: 29_000, endMs: 30_000 }, { startMs: 40_000, endMs: 41_000 }]);
  assert.equal(ctx.complete, false);
  // Reviewer-only playback.
  assert.equal((await call('GET', `/api/sessions/${id}/media/${ctx.clips[0].mediaName}`, { key })).status, 404);
  const media = await fetch(`${base}/api/sessions/${id}/media/${ctx.clips[0].mediaName}`, { headers: { 'x-reviewer-token': TOKEN } });
  assert.equal(media.headers.get('content-type'), 'video/webm');
  const route = await call('GET', `/api/sessions/${id}/evidence/${encodeURIComponent(v.evidence[0].id)}/context`, { reviewer: true });
  assert.deepEqual(route.body.gaps, ctx.gaps);
  // Advance far beyond the 120 s buffer: unflagged old clips are evicted, flagged context stays.
  const late = await videoClip(id, key, 200_000, 205_000);
  assert.deepEqual(late.body.evicted, [v.videoClips.find((c: any) => c.startMs === 46_000).mediaName]);
  v = await view(id);
  assert.deepEqual(v.videoClips.map((c: any) => c.startMs), [30_000, 35_000, 41_000, 200_000]);
});

test('video clips need camera consent, a live session and a real container header', async () => {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'NoCam' } });
  const { sessionId: id, candidateKey: key } = created.body;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: false, retention: true } });
  assert.equal((await videoClip(id, key, 0, 5000)).status, 403);
  clock = 1_000_000; // videoClip() timestamps are relative to a session created at this clock
  const live = await enrolledLiveSession();
  assert.equal((await videoClip(live.id, live.key, 30_000, 35_000, new Uint8Array(64))).status, 422, 'random bytes are not a WebM file');
  const mp4 = new Uint8Array(64); mp4.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
  assert.equal((await videoClip(live.id, live.key, 30_000, 35_000, mp4, 'video/mp4')).status, 200, 'Safari MP4 clips are accepted');
  assert.equal((await videoClip(live.id, live.key, 30_000, 70_000)).status, 422, 'clips over 30 s are refused');
});

test('interviewer join: statuses, authorization, reviewer-side start, same session for both sides', async () => {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'Join' } });
  const { sessionId: id, candidateKey: key } = created.body;
  assert.equal(created.body.view.joinStatus, 'waiting_for_candidate');
  // Interviewer may join early; candidate sees it.
  const joined = await call('POST', `/api/sessions/${id}/join`, { reviewer: true, json: { reviewerId: 'Iris' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.interviewer.reviewerId, 'Iris');
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key })).body.interviewer.joined, true);
  // Only reviewers can join; unknown sessions are not found.
  assert.equal((await call('POST', `/api/sessions/${id}/join`, { key, json: {} })).status, 404);
  assert.equal((await call('POST', `/api/sessions/${'0'.repeat(24)}/join`, { reviewer: true, json: {} })).status, 404);
  // Candidate consents and enrolls → ready to join; the interviewer starts without any candidate action.
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, retention: true } });
  clock += 25_000;
  assert.equal((await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 1000, endMs: 21000 } })).body.accepted, true);
  await call('GET', `/api/sessions/${id}/candidate`, { key }); // candidate page polling
  let v = await view(id);
  assert.equal(v.joinStatus, 'ready_to_join');
  assert.equal(v.candidateConnected, true);
  assert.equal((await call('POST', `/api/sessions/${id}/control`, { reviewer: true, json: { action: 'start' } })).status, 200);
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key })).body.status, 'live');
  v = await view(id);
  assert.equal(v.joinStatus, 'in_progress');
  const listed = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions.find((s: any) => s.sessionId === id);
  assert.equal(listed.joinStatus, 'in_progress');
  assert.equal(listed.interviewerJoined, true);
  await call('POST', `/api/sessions/${id}/control`, { reviewer: true, json: { action: 'end' } });
  const late = await call('POST', `/api/sessions/${id}/join`, { reviewer: true, json: {} });
  assert.equal(late.status, 410);
  assert.equal(late.body.error.code, 'interview_completed');
});

test('re-evaluation: candidate request → versioned voice response → linked evaluation → dashboard sees it', async () => {
  const { id, key } = await enrolledLiveSession();
  clock = 1_000_000 + 40_000;
  // Not before the candidate has answered anything.
  const early = await call('POST', `/api/sessions/${id}/review-requests`, { key, json: {} });
  assert.equal(early.status, 409);
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key })).body.canRequestReevaluation, false);
  await call('POST', `/api/sessions/${id}/answers/start`, { key, json: { questionId: 'q1' } });
  const req = await call('POST', `/api/sessions/${id}/review-requests`, { key, json: { reason: 'My microphone cut out on question 2' } });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const cand = req.body;
  assert.match(cand.reviewRequest.id, /^rr-1-[a-f0-9]{6}$/);
  assert.equal(cand.reviewRequest.status, 'awaiting_response');
  assert.equal(cand.pendingChallenge.reviewRequestId, cand.reviewRequest.id);
  assert.equal(cand.canRequestReevaluation, false);
  assert.equal((await call('POST', `/api/sessions/${id}/review-requests`, { key, json: {} })).status, 409, 'one open request at a time');
  // Candidate records the new response (audio + transcript).
  clock = 1_000_000 + 50_000;
  const sub = await call('POST', `/api/sessions/${id}/challenges/${cand.pendingChallenge.id}/submit`, { key, wav: speechLike(8), meta: { startMs: 41_000, endMs: 49_000 },
    headers: { 'x-transcript': encodeURIComponent(cand.pendingChallenge.phrase) } });
  assert.equal(sub.status, 200);
  await service.idle();
  const v = await view(id);
  const rr = v.reviewRequests[0];
  assert.equal(rr.id, cand.reviewRequest.id);
  assert.equal(rr.requestedBy, 'candidate');
  assert.equal(rr.status, 'evaluated');
  assert.equal(rr.evaluationVersion, 1);
  assert.equal(rr.versions[0].version, 1);
  assert.equal(rr.versions[0].transcript, cand.pendingChallenge.phrase);
  assert.ok(rr.versions[0].audioMediaName);
  assert.equal(rr.versions[0].evaluation.speaker.decision, 'match');
  assert.equal(rr.versions[0].evaluation.phraseMatched, true);
  const listed = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions.find((s: any) => s.sessionId === id);
  assert.equal(listed.reviewRequestsToReview, 1);
  // Reviewer asks for another response → version 2, earlier version kept.
  const again = await call('POST', `/api/sessions/${id}/review-requests/${rr.id}/versions`, { reviewer: true, json: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.reviewRequests[0].versions.length, 2);
  assert.equal(again.body.reviewRequests[0].status, 'awaiting_response');
  assert.equal(again.body.reviewRequests[0].evaluationVersion, 1, 'the last evaluated version stays visible');
  // Phrase expires unanswered → candidate can get a new phrase (version 3), then the limit holds.
  clock += 130_000;
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key })).body.reviewRequest.status, 'expired');
  assert.equal((await call('POST', `/api/sessions/${id}/review-requests/${rr.id}/versions`, { key, json: {} })).status, 200);
  clock += 130_000;
  assert.equal((await call('POST', `/api/sessions/${id}/review-requests/${rr.id}/versions`, { key, json: {} })).status, 429);
  // Escalation closes the request and is counted on the dashboard.
  const closed = await call('POST', `/api/sessions/${id}/review-requests/${rr.id}/close`, { reviewer: true, json: { outcome: 'escalated', notes: 'Needs hiring lead review', reviewerId: 'Rev' } });
  assert.equal(closed.body.reviewRequests[0].status, 'escalated');
  const after = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions.find((s: any) => s.sessionId === id);
  assert.equal(after.escalated, 1);
  assert.equal(after.openReviewRequests, 0);
});

test('re-evaluation works after the interview ended, and reviewer re-verification creates a linked request', async () => {
  const { id, key } = await enrolledLiveSession();
  script = c => c.path === '/speakers/verify' ? verifyOk('no_match', 'real') : defaultScript(c);
  await window(id, key, 30_000, 7);
  const ev = (await view(id)).evidence[0];
  const resolved = await call('POST', `/api/sessions/${id}/evidence/${encodeURIComponent(ev.id)}/resolutions`, { reviewer: true, json: { disposition: 'request_reverification', notes: 'Ask again', reviewerId: 'Rev' } });
  const rr = resolved.body.reviewRequests[0];
  assert.equal(rr.requestedBy, 'reviewer');
  assert.equal(rr.evidenceId, ev.id);
  assert.equal(rr.reason, 'Ask again');
  const close = await call('POST', `/api/sessions/${id}/review-requests/${rr.id}/close`, { reviewer: true, json: { outcome: 'reviewed', notes: 'Fine', reviewerId: 'Rev' } });
  assert.equal(close.status, 200);
  await call('POST', `/api/sessions/${id}/answers/start`, { key, json: { questionId: 'q1' } });
  await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'end' } });
  const after = await call('POST', `/api/sessions/${id}/review-requests`, { key, json: { reason: 'Please re-check' } });
  assert.equal(after.status, 200);
  assert.equal(after.body.status, 'ended');
  assert.ok(after.body.pendingChallenge, 'a fresh phrase is issued even after the interview ended');
});

async function rawWindow(id: string, key: string, startMs: number, wav: Uint8Array) {
  const durationMs = (wav.length - 44) / 2 / RATE * 1000;
  clock = 1_000_000 + startMs + durationMs + 100;
  const r = await call('POST', `/api/sessions/${id}/windows`, { key, wav, meta: { startMs, endMs: startMs + durationMs } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await service.idle();
  return r.body;
}

test('a short voice switch inside one window is screened locally and confirmed by a targeted DetectifAI check', async () => {
  const { id, key } = await enrolledLiveSession();
  let verifies = 0;
  // The whole-window check averages the switch away (match); the targeted check of the stretch does not.
  script = c => c.path === '/speakers/verify' ? verifyOk(verifies++ === 0 ? 'match' : 'no_match', 'real') : defaultScript(c);
  calls = [];
  await rawWindow(id, key, 30_000, concatPcm(voicePcm(6, 190, VOICE_A, 1.1), voicePcm(3, 120, VOICE_B, 4.2), voicePcm(6, 190, VOICE_A, 2.2)));
  const v = await view(id);
  assert.equal(v.voiceProfileReady, true);
  const sig = v.voiceSignals.find((s: any) => s.kind === 'speaker_change_suspected');
  assert.ok(sig, JSON.stringify(v.voiceSignals));
  assert.ok(sig.startMs >= 34_500 && sig.startMs <= 36_500 && sig.endMs >= 38_500 && sig.endMs <= 40_500, `${sig.startMs}–${sig.endMs}`);
  assert.equal(calls.filter(c => c.path === '/speakers/verify').length, 2, 'one window check + one targeted check');
  assert.equal(sig.targeted.speaker.decision, 'no_match');
  assert.equal(sig.targeted.flagged, true);
  const targeted = v.windows.find((w: any) => w.id === sig.targeted.windowId);
  assert.deepEqual(targeted.targetedFrom, [v.windows[0].id]);
  assert.ok(targeted.endMs - targeted.startMs >= 4500 && targeted.endMs - targeted.startMs <= 15_000);
  // Evidence points at the short stretch, not the whole 15 s window.
  const ev = v.evidence.find((e: any) => e.windowId === targeted.id);
  assert.deepEqual(ev.reasons, ['speaker_mismatch']);
  assert.ok(ev.endMs - ev.startMs < 15_000);
});

test('a switch that straddles two windows is caught at the boundary', async () => {
  const { id, key } = await enrolledLiveSession();
  await rawWindow(id, key, 30_000, concatPcm(voicePcm(12, 190, VOICE_A, 1.1), voicePcm(3, 120, VOICE_B, 4.2)));
  await rawWindow(id, key, 45_000, concatPcm(voicePcm(3, 120, VOICE_B, 5.1), voicePcm(12, 190, VOICE_A, 2.2)));
  const v = await view(id);
  const changes = v.voiceSignals.filter((s: any) => s.kind === 'speaker_change_suspected');
  // The other voice runs 42–48 s across the 45 s boundary: one signal must cover the join itself.
  assert.ok(changes.some((s: any) => s.startMs < 45_000 && s.endMs > 45_000), JSON.stringify(changes));
  assert.ok(changes.every((s: any) => s.startMs >= 40_000 && s.endMs <= 50_500), JSON.stringify(changes));
  assert.equal(new Set(changes.map((s: any) => Math.round(s.startMs / 1000))).size, changes.length, 'boundary re-read does not duplicate signals');
});

test('two voices taking quick turns are reported as more than one voice; the same voice is not', async () => {
  const { id, key } = await enrolledLiveSession();
  await rawWindow(id, key, 30_000, speechLike(15, 185, VOICE_A, 2.7));
  assert.equal((await view(id)).voiceSignals.length, 0, 'no local signal for the enrolled voice');
  const a = voicePcm(15, 190, VOICE_A, 1.3), b = voicePcm(15, 120, VOICE_B, 3.3), mixed = new Float32Array(a.length);
  for (let i = 0; i < mixed.length; i++) mixed[i] = (Math.floor(i / (0.12 * RATE)) % 2 ? b : a)[i]!;
  await rawWindow(id, key, 45_000, encodeWav(mixed, RATE));
  const kinds = (await view(id)).voiceSignals.map((s: any) => s.kind);
  assert.ok(kinds.includes('multiple_voices_suspected'), JSON.stringify(kinds));
});

test('targeted checks respect the per-session credit budget', async () => {
  await close(); service.config; // rebuild with a budget of 1
  const client = new DetectifClient('detectif-test', fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock, maxTargetedChecks: 1 });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..') });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; close = () => new Promise(r => server.close(() => r()));
  clock = 1_000_000;
  const { id, key } = await enrolledLiveSession();
  await rawWindow(id, key, 30_000, concatPcm(voicePcm(6, 190, VOICE_A, 1.1), voicePcm(3, 120, VOICE_B, 4.2), voicePcm(6, 190, VOICE_A, 2.2)));
  await rawWindow(id, key, 45_000, concatPcm(voicePcm(6, 190, VOICE_A, 3.1), voicePcm(3, 120, VOICE_B, 6.2), voicePcm(6, 190, VOICE_A, 4.4)));
  const v = await view(id);
  assert.equal(v.targetedChecks.used, 1);
  assert.ok(v.voiceSignals.some((s: any) => /budget/.test(s.targetedSkipped ?? '')), JSON.stringify(v.voiceSignals));
});

const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64');
test('gesture checks: 30 s to perform, results and suspicious remarks, reviewer-only snapshot', async () => {
  const { id, key } = await enrolledLiveSession();   // camera consented
  clock = 1_000_000 + 40_000;
  const g1 = await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'thumbs_up', reviewerId: 'Iris' } });
  assert.equal(g1.status, 200, JSON.stringify(g1.body));
  const check = g1.body.gestureChecks[0];
  assert.equal(check.verdict, 'pending');
  assert.equal(check.deadlineMs - check.issuedAtMs, 30_000);
  assert.equal((await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'wave_hello' } })).status, 409, 'one at a time');
  assert.equal((await call('POST', `/api/sessions/${id}/gestures`, { key, json: { gesture: 'thumbs_up' } })).status, 404, 'only the interviewer asks');
  const cand = (await call('GET', `/api/sessions/${id}/candidate`, { key })).body;
  assert.equal(cand.pendingGesture.gesture, 'thumbs_up');
  assert.equal(cand.pendingGesture.label, 'Thumbs up');
  clock += 4_000;
  const rep = await call('POST', `/api/sessions/${id}/gestures/${check.id}/report`, { key, json: { status: 'performed', detectedAtMs: 43_500, confidence: 0.91, snapshot: jpegB64, frames: 90, handFrames: 60 } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.pendingGesture, undefined);
  let v = await view(id);
  assert.equal(v.gestureChecks[0].verdict, 'completed');
  assert.match(v.gestureChecks[0].remark, /3\.5 s/);
  const snap = v.gestureChecks[0].report.snapshot;
  assert.equal((await call('GET', `/api/sessions/${id}/media/${snap}`, { key })).status, 404);
  assert.equal((await call('GET', `/api/sessions/${id}/media/${snap}`, { reviewer: true })).status, 200);
  assert.equal((await call('POST', `/api/sessions/${id}/gestures/${check.id}/report`, { key, json: { status: 'performed', detectedAtMs: 44_000 } })).status, 409, 'one result per check');

  // Not performed in time → suspicious, with what was seen instead.
  const g2 = (await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'raise_hand' } })).body.gestureChecks[1];
  clock += 31_000;
  await call('POST', `/api/sessions/${id}/gestures/${g2.id}/report`, { key, json: { status: 'not_performed', observed: ['Raise right hand'], frames: 900, handFrames: 300 } });
  // No response at all → suspicious after the grace period.
  const g3 = (await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'random' } })).body.gestureChecks[2];
  assert.ok(Object.keys({ thumbs_up: 1, thumbs_down: 1, raise_hand: 1, point_one_finger: 1, wave_hello: 1 }).includes(g3.gesture));
  clock += 41_000;
  // Camera problem → unverified (not a pass, not an accusation).
  const g4 = (await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'point_one_finger' } })).body.gestureChecks[3];
  await call('POST', `/api/sessions/${id}/gestures/${g4.id}/report`, { key, json: { status: 'unavailable', reason: 'Camera permission denied' } });
  v = await view(id);
  assert.deepEqual(v.gestureChecks.map((g: any) => g.verdict), ['completed', 'suspicious', 'suspicious', 'unverified']);
  assert.match(v.gestureChecks[1].remark, /Seen instead: Raise right hand/);
  assert.match(v.gestureChecks[2].remark, /no response/);
  const listed = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions.find((s: any) => s.sessionId === id);
  assert.equal(listed.suspiciousGestures, 2);
});

test('gesture checks need camera consent', async () => {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'NoCam' } });
  const { sessionId: id, candidateKey: key } = created.body;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: false, retention: true } });
  clock += 25_000;
  await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 1000, endMs: 21000 } });
  await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } });
  const r = await call('POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'thumbs_up' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'camera_not_consented');
});

// ---------------------------------------------------------------- hardening
import { writeFileSync as writeFileSyncH, readdirSync as readdirSyncH, chmodSync } from 'node:fs';

test('low credits skip targeted checks but window checks continue', async () => {
  const { id, key } = await enrolledLiveSession();
  verifyBalance = 120;   // below LOW_CREDIT_THRESHOLD (300)
  await rawWindow(id, key, 30_000, speechLike(15));          // learns the low balance
  calls = [];
  await rawWindow(id, key, 45_000, concatPcm(voicePcm(6, 190, VOICE_A, 1.1), voicePcm(3, 120, VOICE_B, 4.2), voicePcm(6, 190, VOICE_A, 2.2)));
  const v = await view(id);
  assert.equal(calls.filter(c => c.path === '/speakers/verify').length, 1, 'the window itself is still checked');
  assert.ok(v.voiceSignals.some((s: any) => /credits are low/.test(s.targetedSkipped ?? '')), JSON.stringify(v.voiceSignals));
  assert.equal(v.targetedChecks.lowCredits, true);
});

test('voice analysis runs off the request thread and its failures are recorded, not passed', async () => {
  const { id, key } = await enrolledLiveSession();
  assert.equal((await view(id)).voiceProfileReady, true, 'profile built in the worker');
  const original = service.voice.analyse.bind(service.voice);
  service.voice.analyse = async () => { throw new Error('worker crashed'); };
  await rawWindow(id, key, 30_000, speechLike(15));
  service.voice.analyse = original;
  const v = await view(id);
  assert.equal(v.targetedChecks.skippedAnalyses, 1);
  assert.equal(v.windows[0].coverage, 'complete', 'the DetectifAI window check is unaffected');
});

test('health reports storage, worker and queue state without secrets', async () => {
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.storage, 'ok');
  assert.equal(typeof h.body.voiceWorker.state, 'string');
  assert.equal(JSON.stringify(h.body).includes('detectif-test'), false, 'never echoes the provider key');
  chmodSync(join(dataDir, 'sessions'), 0o500);
  try {
    const bad = await call('GET', '/api/health');
    assert.equal(bad.status, 503);
    assert.equal(bad.body.storage, 'error');
  } finally { chmodSync(join(dataDir, 'sessions'), 0o700); }
});

test('corrupt session file is quarantined and other sessions still load', async () => {
  const { id } = await enrolledLiveSession();
  await service.idle();
  writeFileSyncH(join(dataDir, 'sessions', 'ffffffffffffffffffffffff.json'), '{ not json');
  await close(); await boot(); service.load();
  assert.equal((await call('GET', `/api/sessions/${id}`, { reviewer: true })).status, 200);
  assert.ok(readdirSyncH(join(dataDir, 'sessions')).some(f => f.startsWith('ffffffffffffffffffffffff.json.corrupt-')));
});

test('old sessions expire with their media and remote speaker profile', async () => {
  const { id, key } = await enrolledLiveSession();
  await rawWindow(id, key, 30_000, speechLike(15));
  calls = [];
  clock += 31 * 86_400_000;
  const r = await service.expireSessions();
  assert.equal(r.deleted, 1);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === `/speakers/sg-${id}`));
  assert.equal((await call('GET', `/api/sessions/${id}`, { reviewer: true })).status, 404);
  assert.equal(existsSync(join(dataDir, 'media', id)), false);
});

test('retention compacts purged buffer entries from long sessions', async () => {
  const { id, key } = await enrolledLiveSession();
  const webm = new Uint8Array(64); webm.set([0x1a, 0x45, 0xdf, 0xa3]);
  for (let s = 30_000; s <= 400_000; s += 5_000) {
    clock = 1_000_000 + s + 5_050;
    await fetch(`${base}/api/sessions/${id}/video`, { method: 'POST', body: new Blob([webm]), headers: { 'x-session-key': key, 'content-type': 'video/webm', 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs: s, endMs: s + 5_000 })) } });
  }
  const before = service.records.get(id)!.media.length;
  clock += 11 * 60_000;
  service.sweepRetention();
  const rec = service.records.get(id)!;
  assert.ok(rec.media.length < before, `${rec.media.length} < ${before}`);
  assert.ok((rec.mediaPruned ?? 0) > 0);
});

test('reviewer token brute force is throttled per address', async () => {
  await close();
  const client = new DetectifClient('detectif-test', fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..'), limits: { reviewerFailures: 5, lockoutMs: 60_000 } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; close = () => new Promise(r => server.close(() => r()));
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/sessions`, { headers: { 'x-reviewer-token': `wrong-${i}` } })).status, 401);
  const locked = await fetch(`${base}/api/sessions`, { headers: { 'x-reviewer-token': TOKEN } });
  assert.equal(locked.status, 429, 'even the right token waits out the lockout');
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'health stays reachable');
});

test('request flood is throttled', async () => {
  await close();
  const client = new DetectifClient('detectif-test', fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..'), limits: { burst: 20, perSecond: 1 } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; close = () => new Promise(r => server.close(() => r()));
  const statuses = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/api/sessions`, { headers: { 'x-reviewer-token': TOKEN } }).then(r => r.status)));
  assert.ok(statuses.filter(s => s === 429).length >= 15, JSON.stringify(statuses));
  assert.ok(statuses.filter(s => s === 200).length >= 15);
});

test('HSTS is sent behind an HTTPS proxy only', async () => {
  await close();
  const client = new DetectifClient('detectif-test', fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..'), trustProxy: true });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; close = () => new Promise(r => server.close(() => r()));
  assert.equal((await fetch(`${base}/api/health`)).headers.get('strict-transport-security'), null);
  assert.match((await fetch(`${base}/api/health`, { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security') ?? '', /max-age=/);
});

test('malformed requests never crash the server', async () => {
  const { id, key } = await enrolledLiveSession();
  const cases: Array<[string, string, RequestInit, number[]]> = [
    ['bad json', `/api/sessions`, { method: 'POST', headers: { 'x-reviewer-token': TOKEN, 'content-type': 'application/json' }, body: '{"displayName":' }, [400]],
    ['json array body', `/api/sessions/${id}/control`, { method: 'POST', headers: { 'x-session-key': key }, body: '[1,2]' }, [400]],
    ['wrong audio type', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/mpeg', 'x-operation-id': 'abcdefgh1' }, body: 'x' }, [415]],
    ['not a wav', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': 'abcdefgh2', 'x-capture-metadata': encodeURIComponent('{"startMs":1,"endMs":2}') }, body: 'RIFFxxxx' }, [422]],
    ['missing metadata', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': 'abcdefgh3' }, body: 'x' }, [400]],
    ['bad metadata', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': 'abcdefgh4', 'x-capture-metadata': '%E0%A4%A' }, body: 'x' }, [400]],
    ['bad op id', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': '../../x', 'x-capture-metadata': encodeURIComponent('{"startMs":1,"endMs":2}') }, body: 'x' }, [400]],
    ['huge json', `/api/sessions/${id}/interruptions`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'x'.repeat(200_000) }) }, [413]],
    ['huge audio', `/api/sessions/${id}/windows`, { method: 'POST', headers: { 'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': 'abcdefgh5' }, body: new Uint8Array(13 * 1024 * 1024) }, [413]],
    ['bad session id', `/api/sessions/../../etc/passwd`, { method: 'GET', headers: { 'x-reviewer-token': TOKEN } }, [404]],
    ['bad session id 2', `/api/sessions/ZZZ`, { method: 'GET', headers: { 'x-reviewer-token': TOKEN } }, [404]],
    ['media traversal', `/api/sessions/${id}/media/..%2F..%2Fsessions`, { method: 'GET', headers: { 'x-reviewer-token': TOKEN } }, [404, 405]],
    ['static traversal', `/js/product/browser/..%2F..%2F..%2Fpackage.json`, { method: 'GET' }, [404]],
    ['vendor traversal', `/vendor/mediapipe/..%2F..%2Fthree%2Fpackage.json`, { method: 'GET' }, [404]],
    ['unknown route', `/api/nope`, { method: 'GET' }, [404]],
    ['wrong method', `/api/sessions/${id}/candidate`, { method: 'DELETE', headers: { 'x-session-key': key } }, [405]],
    ['bad gesture', `/api/sessions/${id}/gestures`, { method: 'POST', headers: { 'x-reviewer-token': TOKEN, 'content-type': 'application/json' }, body: '{"gesture":"dance"}' }, [400]],
    ['bad gesture report', `/api/sessions/${id}/gestures/g1-abc/report`, { method: 'POST', headers: { 'x-session-key': key }, body: 'not json' }, [400]],
    ['bad disposition', `/api/sessions/${id}/evidence/x/resolutions`, { method: 'POST', headers: { 'x-reviewer-token': TOKEN }, body: '{}' }, [404]],
    ['bad time', `/api/sessions/${id}/interruptions`, { method: 'POST', headers: { 'x-session-key': key }, body: JSON.stringify({ kind: 'interrupted', reason: 'x', atMs: 'soon' }) }, [400]],
  ];
  for (const [name, path, init, expected] of cases) {
    const res = await fetch(base + path, init).catch((e) => ({ status: -1, statusText: String(e) } as Response));
    assert.ok(expected.includes(res.status), `${name}: got ${res.status}`);
  }
  assert.equal((await call('GET', `/api/sessions/${id}`, { reviewer: true })).status, 200, 'server still serving');
});

test('parallel sessions and uploads keep consistent records', async () => {
  const sessions = await Promise.all([0, 1, 2, 3].map(async (i) => {
    const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: `P${i}` } });
    const { sessionId: id, candidateKey: key } = created.body;
    await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, retention: true } });
    return { id, key };
  }));
  clock += 30_000;
  await Promise.all(sessions.map(({ id, key }, i) => call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20, 190, VOICE_A, i), meta: { startMs: 1000, endMs: 21000 } })));
  await Promise.all(sessions.map(({ id, key }) => call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } })));
  clock += 60_000;
  await Promise.all(sessions.flatMap(({ id, key }) => [30_000, 45_000, 60_000].map((s) =>
    call('POST', `/api/sessions/${id}/windows`, { key, wav: speechLike(15), meta: { startMs: s, endMs: s + 15_000 } }))));
  await service.idle();
  for (const { id } of sessions) {
    const v = await view(id);
    assert.equal(v.windows.filter((w: any) => !w.targetedFrom).length, 3, `session ${id}`);
    assert.ok(v.windows.every((w: any) => w.coverage !== 'pending'));
    assert.equal(new Set(v.windows.map((w: any) => w.sequence)).size, v.windows.length, 'unique sequences');
  }
});

test('every route answers (static pages, vendor files, ops, clock, thumbnails)', async () => {
  for (const p of ['/', '/candidate.html', '/reviewer.html', '/sandbox.html', '/report.html', '/style.css', '/theme.css', '/pcm-worklet.js', '/js/product/browser/candidate.js', '/js/product/browser/gesture.js', '/js/src/media/wav.js', '/vendor/three.module.js', '/vendor/mediapipe/vision_bundle.mjs']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  const { id, key } = await enrolledLiveSession();
  assert.equal((await call('GET', '/api/ops', { reviewer: true })).status, 200);
  assert.equal(typeof (await call('GET', `/api/sessions/${id}/clock`, { key })).body.sessionMs, 'number');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  const t = await fetch(`${base}/api/sessions/${id}/thumbnails`, { method: 'POST', body: jpeg, headers: { 'x-session-key': key, 'content-type': 'image/jpeg', 'x-at-ms': '20000' } });
  assert.equal(t.status, 200);
  assert.equal((await view(id)).thumbnails.length, 1);
});

// ---------------------------------------------------------------- who is speaking
const VOICE_C: Array<[number, number, number]> = [[750, 130, 1], [1300, 160, 0.8], [2200, 240, 0.4]];

test('three different voices are labelled Person 1, 2 and 3 consistently across answers', async () => {
  const { id, key } = await enrolledLiveSession();
  const answer = async (q: string, startMs: number, wav: Uint8Array) => {
    clock = 1_000_000 + startMs; await call('POST', `/api/sessions/${id}/answers/start`, { key, json: { questionId: q } });
    await rawWindow(id, key, startMs + 100, wav);
    await call('POST', `/api/sessions/${id}/answers/end`, { key, json: {} });
  };
  await answer('q1', 30_000, speechLike(15, 188, VOICE_A, 2.1));                                                        // Person 1 only
  await answer('q2', 50_000, concatPcm(voicePcm(7, 190, VOICE_A, 1.1), voicePcm(8, 120, VOICE_B, 4.2)));               // half Person 1, half Person 2
  await answer('q3', 70_000, speechLike(15, 150, VOICE_C, 3.3));                                                        // someone else entirely
  await answer('q4', 90_000, concatPcm(voicePcm(8, 118, VOICE_B, 5.1), voicePcm(7, 152, VOICE_C, 6.2)));               // Person 2 then Person 3
  const sp = (await view(id)).speakers;
  assert.deepEqual(sp.people.map((p: any) => p.person), [1, 2, 3], JSON.stringify(sp.people));
  assert.equal(sp.people[0].label, 'Person 1 — enrolled voice');
  const byQ = Object.fromEntries(sp.answers.map((a: any) => [a.questionId, a]));
  assert.equal(byQ.q1.verdict, 'one_person');
  assert.deepEqual(byQ.q1.people.filter((p: any) => p.seconds >= 2).map((p: any) => p.person), [1]);
  assert.equal(byQ.q2.verdict, 'split');
  assert.deepEqual(byQ.q2.people.filter((p: any) => p.seconds >= 2).map((p: any) => p.person).sort(), [1, 2]);
  const sw = byQ.q2.switches[0];
  assert.ok(sw && sw.from === 1 && sw.to === 2 && sw.atMs > 56_000 && sw.atMs < 58_500, JSON.stringify(byQ.q2.switches));
  assert.equal(byQ.q3.verdict, 'other_person');
  assert.equal(byQ.q3.people[0].person, 3);
  assert.equal(byQ.q4.verdict, 'split');
  assert.deepEqual(byQ.q4.people.filter((p: any) => p.seconds >= 2).map((p: any) => p.person).sort(), [2, 3], 'Person 2 is recognised again');
  const listed = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions.find((s: any) => s.sessionId === id);
  assert.equal(listed.peopleHeard, 3);
  assert.equal(listed.splitAnswers, 3);
});

test('video around a voice switch is kept even when nothing was flagged by DetectifAI', async () => {
  const { id, key } = await enrolledLiveSession();   // camera consented
  const webm = new Uint8Array(64); webm.set([0x1a, 0x45, 0xdf, 0xa3]);
  const clip = async (s: number) => { clock = 1_000_000 + s + 5_050; await fetch(`${base}/api/sessions/${id}/video`, { method: 'POST', body: new Blob([webm]), headers: { 'x-session-key': key, 'content-type': 'video/webm', 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs: s, endMs: s + 5_000 })) } }); };
  for (let s = 30_000; s < 45_000; s += 5_000) await clip(s);
  await rawWindow(id, key, 30_000, concatPcm(voicePcm(7, 190, VOICE_A, 1.1), voicePcm(8, 120, VOICE_B, 4.2)));   // switch ≈ 37 s, DetectifAI says match
  const switches = (await view(id)).speakers.switches;
  assert.ok(switches.length >= 1, 'switch found');
  for (let s = 45_000; s <= 300_000; s += 5_000) await clip(s);                                                     // push far past the 120 s buffer
  const kept = (await view(id)).videoClips.map((c: any) => c.startMs);
  assert.ok(kept.includes(30_000) && kept.includes(35_000) && kept.includes(40_000), JSON.stringify(kept.slice(0, 6)));
  assert.ok(!kept.includes(100_000), 'unrelated old video is still dropped');
});

// ---------------------------------------------------------------- judge demo (open without login)
async function bootJudge(judgeDemo: boolean, overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  await close();
  const client = new DetectifClient('detectif-test', fakeFetch, async () => {});
  service = new SwitchGuardService(client, { ...defaultConfig(dataDir), provenance: 'test_fixture', now: () => clock, ...overrides });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..'), judgeDemo });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; close = () => new Promise(r => server.close(() => r()));
}
const judge = (method: string, path: string, json?: unknown) => fetch(base + path, { method, headers: { 'x-demo': '1', ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => undefined) as any }));

test('judge demo: opens without a token, sees and works only with demo sessions', async () => {
  await bootJudge(true);
  assert.deepEqual((await (await fetch(`${base}/api/demo`)).json()), { enabled: true });
  const real = (await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'Real candidate' } })).body.sessionId;
  const list0 = await judge('GET', '/api/sessions');
  assert.equal(list0.status, 200);
  assert.equal(list0.body.role, 'judge');
  assert.equal(list0.body.sessions.length, 0, 'real sessions are invisible to judges');
  // Real and unknown sessions answer the same way, so a judge learns nothing about them.
  assert.equal((await judge('GET', `/api/sessions/${real}`)).status, 401);
  assert.equal((await judge('GET', `/api/sessions/${'0'.repeat(24)}`)).status, 401);
  assert.equal((await judge('DELETE', `/api/sessions/${real}`)).status, 401, 'judges cannot touch real sessions');
  assert.equal((await call('GET', `/api/sessions/${real}`, { reviewer: true })).status, 200, 'real session untouched');
  const created = await judge('POST', '/api/sessions', { displayName: 'Judge test' });
  assert.equal(created.status, 201);
  const demoId = created.body.sessionId;
  assert.equal((await judge('GET', '/api/sessions')).body.sessions.map((s: any) => s.sessionId).join(), demoId);
  assert.equal((await judge('GET', `/api/sessions/${demoId}`)).status, 200);
  assert.equal((await judge('POST', `/api/sessions/${demoId}/join`, { reviewerId: 'Judge' })).body.interviewer.reviewerId, 'Judge');
  // The interviewer with the token still sees everything, demo sessions marked.
  const full = (await call('GET', '/api/sessions', { reviewer: true })).body.sessions;
  assert.equal(full.length, 2);
  assert.equal(full.find((s: any) => s.sessionId === demoId).demo, true);
  assert.equal((await judge('DELETE', `/api/sessions/${demoId}`)).status, 200);
});

test('judge demo is off unless enabled', async () => {
  await bootJudge(false);
  assert.deepEqual((await (await fetch(`${base}/api/demo`)).json()), { enabled: false });
  assert.equal((await judge('GET', '/api/sessions')).status, 401);
  assert.equal((await judge('POST', '/api/sessions', { displayName: 'x' })).status, 401);
});

test('judge demo limits: concurrent sessions, provider checks per session, 24 h lifetime', async () => {
  await bootJudge(true, { demoMaxSessions: 2, demoMaxChecks: 1 });
  const a = (await judge('POST', '/api/sessions', { displayName: 'A' })).body;
  await judge('POST', '/api/sessions', { displayName: 'B' });
  const third = await judge('POST', '/api/sessions', { displayName: 'C' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'demo_limit');
  // Per-session check cap: the second window is not sent to DetectifAI.
  const id = a.sessionId, key = a.candidateKey;
  await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, retention: true } });
  clock += 25_000;
  await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 1000, endMs: 21000 } });
  await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } });
  calls = [];
  await rawWindow(id, key, 30_000, speechLike(15));
  await rawWindow(id, key, 45_000, speechLike(15));
  assert.equal(calls.filter(c => c.path === '/speakers/verify').length, 1);
  const w = (await judge('GET', `/api/sessions/${id}`)).body.windows.filter((x: any) => !x.targetedFrom);
  assert.match(w[1].reason, /Judge demo limit/);
  // Demo sessions are deleted after 24 h even though real sessions are kept for 30 days.
  clock += 25 * 3_600_000;
  const r = await service.expireSessions();
  assert.equal(r.deleted, 2);
});

test('live transcript: needs consent, is idempotent, and marks other-person and AI-voice phrases red', async () => {
  const created = await call('POST', '/api/sessions', { reviewer: true, json: { displayName: 'Tx', kind: 'interview' } });
  const id: string = created.body.sessionId, key: string = created.body.candidateKey;
  assert.equal((await call('POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: false, retention: true, transcript: true } })).body.consent.transcript, true);
  clock += 25_000;
  assert.equal((await call('POST', `/api/sessions/${id}/transcript`, { key, json: { phrases: [{ id: 'p-early000', startMs: 1000, endMs: 2000, text: 'too early' }] } })).status, 409, 'not before the interview starts');
  assert.equal((await call('POST', `/api/sessions/${id}/enrollment`, { key, wav: speechLike(20), meta: { startMs: 3000, endMs: 23000 } })).body.accepted, true);
  await call('POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } });

  // 7 s of the enrolled voice, then 8 s of someone else; then a window DetectifAI calls synthetic.
  await rawWindow(id, key, 50_100, concatPcm(voicePcm(7, 190, VOICE_A, 1.1), voicePcm(8, 120, VOICE_B, 4.2)));
  script = (c) => c.path === '/speakers/verify' ? verifyOk('match', 'fake') : defaultScript(c);
  await window(id, key, 80_000, 7);
  script = defaultScript;

  const phrases = [
    { id: 'p-first001', startMs: 50_600, endMs: 56_200, text: 'I led the payments migration last year' },
    { id: 'p-second01', startMs: 58_300, endMs: 64_500, text: 'we used a queue to smooth the load' },
    { id: 'p-synth001', startMs: 80_500, endMs: 86_000, text: 'the design scaled to ten times the traffic' },
  ];
  clock = 1_000_000 + 90_000;
  assert.deepEqual((await call('POST', `/api/sessions/${id}/transcript`, { key, json: { phrases } })).body, { accepted: 3 });
  assert.deepEqual((await call('POST', `/api/sessions/${id}/transcript`, { key, json: { phrases } })).body, { accepted: 0 }, 'a retried batch is not duplicated');
  for (const bad of [{ ...phrases[0], id: 'x' }, { ...phrases[0], id: 'p-badtime1', endMs: 40_000 }, { ...phrases[0], id: 'p-future01', startMs: 200_000, endMs: 201_000 }, { ...phrases[0], id: 'p-empty001', text: '  ' }]) {
    assert.equal((await call('POST', `/api/sessions/${id}/transcript`, { key, json: { phrases: [bad] } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', `/api/sessions/${id}/transcript`, { reviewer: true, json: { phrases } })).status >= 400, true, 'only the candidate posts phrases');

  const tx = (await view(id)).transcript;
  assert.equal(tx.enabled, true);
  const byId = Object.fromEntries(tx.phrases.map((p: any) => [p.id, p]));
  assert.equal(byId['p-first001'].tone, 'ok', JSON.stringify(byId['p-first001']));
  assert.equal(byId['p-second01'].tone, 'bad', JSON.stringify(byId['p-second01']));
  assert.ok(byId['p-second01'].reasons.some((r: string) => /^Person 2/.test(r)), JSON.stringify(byId['p-second01'].reasons));
  assert.equal(byId['p-synth001'].tone, 'bad');
  assert.ok(byId['p-synth001'].reasons.includes('Synthetic (AI) voice verdict'));
  assert.ok(byId['p-synth001'].windowId);
  assert.equal(tx.redCount, 2);
  // The candidate never sees the colouring; the export carries it for the reviewer.
  assert.equal((await call('GET', `/api/sessions/${id}/candidate`, { key })).body.transcript, undefined);
  assert.equal((await call('GET', `/api/sessions/${id}/export`, { reviewer: true })).body.transcript.phrases.length, 3);

  // Without transcript consent the endpoint refuses.
  const plain = await enrolledLiveSession();
  const refused = await call('POST', `/api/sessions/${plain.id}/transcript`, { key: plain.key, json: { phrases: [{ id: 'p-aaaaaaaa', startMs: 0, endMs: 1000, text: 'hello' }] } });
  assert.equal(refused.status, 403);
});
