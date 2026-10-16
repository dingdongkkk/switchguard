/** Multi-instance mode (Vercel): two independent server instances share one store with conditional
 * writes. Requests for the same session alternate between instances and run concurrently. Every
 * provider result here is a test fixture. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DetectifClient } from '../../src/server/detectif.js';
import { encodeWav } from '../../src/media/wav.js';
import { createProductApp } from '../server/app.js';
import { SwitchGuardService, defaultConfig } from '../server/service.js';
import { MemoryStore } from '../server/store.js';

const RATE = 16000, TOKEN = 'reviewer-shared-test', CRON = 'cron-secret-for-tests';
function voice(seconds: number, f0 = 190, seed = 1.3): Uint8Array {
  const formants: Array<[number, number, number]> = [[650, 120, 1], [1100, 150, 0.6], [2500, 250, 0.3]];
  const x = new Float32Array(Math.round(seconds * RATE)); let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE, f = f0 * (1 + 0.06 * Math.sin(t * 2.1 + seed)); phase += (2 * Math.PI * f) / RATE;
    let s = 0; for (let h = 1; h <= 25 && f * h <= 7000; h++) { let w = 0; for (const [F, B, a] of formants) w += a * Math.exp(-0.5 * ((f * h - F) / B) ** 2); s += (Math.sin(h * phase) * (0.02 + w)) / h ** 0.3; }
    x[i] = 0.12 * s * ((t * 4.2 + seed) % 1 < 0.75 ? 1 : 0.05);
  }
  return encodeWav(x, RATE);
}

let verifyCalls = 0;
const fake: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname.replace('/v1', '');
  const form = init?.body instanceof FormData ? init.body : undefined;
  await new Promise(r => setTimeout(r, 15));   // provider latency: lets requests interleave
  const body = path === '/deepfake/detect' ? { result: { verdict: 'real' }, credits: { charged: 50, balance: 5000 } }
    : path === '/speakers/enroll' ? { speaker: { speaker_id: form?.get('speaker_id') }, quality: { speech_seconds: 18 }, credits: { charged: 50, balance: 5000 } }
    : path === '/speakers/verify' ? (verifyCalls++, { request_id: 'r', model: { name: 'm', version: '1' }, credits: { charged: 100, balance: 5000 },
      result: { decision: 'match', similarity: 0.7, threshold: 0.53, duration_seconds: 7 }, deepfake: { verdict: 'real', segments: [] } })
    : path === '/health' ? { status: 'ok' } : { deleted: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

let store: MemoryStore, clock: number, dirs: string[], servers: Server[], services: SwitchGuardService[], bases: string[];
async function instance() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-shared-')); dirs.push(dir);
  const service = new SwitchGuardService(new DetectifClient('k', fake, async () => {}), { ...defaultConfig(dir), provenance: 'test_fixture', now: () => clock, sharedStore: store, inlineVoice: true });
  const server = createProductApp(service, { reviewerToken: TOKEN, root: resolve(process.cwd(), '..'), cronSecret: CRON });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server); services.push(service); bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
beforeEach(async () => { store = new MemoryStore(); clock = 1_000_000; verifyCalls = 0; dirs = []; servers = []; services = []; bases = []; await instance(); await instance(); });
afterEach(async () => {
  await Promise.all(services.map(s => s.idle()));
  await Promise.all(servers.map(s => new Promise(r => s.close(r))));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function call(i: number, method: string, path: string, o: { reviewer?: boolean; key?: string; json?: unknown; wav?: Uint8Array; meta?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.reviewer) headers['x-reviewer-token'] = TOKEN;
  if (o.key) headers['x-session-key'] = o.key;
  let body: BodyInit | undefined;
  if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  if (o.wav) { headers['content-type'] = 'audio/wav'; headers['x-capture-metadata'] = encodeURIComponent(JSON.stringify(o.meta)); headers['x-operation-id'] = `op${Math.random().toString(36).slice(2, 14)}`; body = new Blob([new Uint8Array(o.wav)]); }
  const res = await fetch(bases[i]! + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined };
}
const idle = () => Promise.all(services.map(s => s.idle()));

async function liveSession() {
  const created = await call(0, 'POST', '/api/sessions', { reviewer: true, json: { displayName: 'Shared' } });
  assert.equal(created.status, 201);
  const { sessionId: id, candidateKey: key } = created.body;
  // Consent on instance 1, enroll on instance 0, start on instance 1.
  assert.equal((await call(1, 'POST', `/api/sessions/${id}/consent`, { key, json: { voiceAnalysis: true, camera: true, retention: true } })).status, 200);
  clock += 25_000;
  const enroll = await call(0, 'POST', `/api/sessions/${id}/enrollment`, { key, wav: voice(20), meta: { startMs: 3000, endMs: 23000 } });
  assert.equal(enroll.body.accepted, true, JSON.stringify(enroll.body));
  assert.equal((await call(1, 'POST', `/api/sessions/${id}/control`, { key, json: { action: 'start' } })).body.status, 'live');
  return { id, key };
}

test('a session created on one instance is served and updated by the other', async () => {
  const { id } = await liveSession();
  const a = (await call(0, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  const b = (await call(1, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  assert.equal(a.status, 'live'); assert.equal(b.status, 'live');
  assert.equal(a.enrollment.authenticity, 'real');
  assert.equal(b.voiceProfileReady, true, 'voice profile built inline and stored');
  const list = (await call(1, 'GET', '/api/sessions', { reviewer: true })).body.sessions;
  assert.equal(list.length, 1);
});

test('parallel uploads to both instances lose nothing and never duplicate a check', async () => {
  const { id, key } = await liveSession();
  clock = 1_000_000 + 200_000;
  const starts = [30_000, 45_000, 60_000, 75_000, 90_000, 105_000];
  const uploads = starts.map((s, i) => call(i % 2, 'POST', `/api/sessions/${id}/windows`, { key, wav: voice(15, 190, i), meta: { startMs: s, endMs: s + 15_000 } }));
  // Reviewer actions racing the uploads on both instances.
  const reviewer = [call(0, 'POST', `/api/sessions/${id}/join`, { reviewer: true, json: { reviewerId: 'Iris' } }), call(1, 'POST', `/api/sessions/${id}/gestures`, { reviewer: true, json: { gesture: 'thumbs_up' } })];
  const results = await Promise.all([...uploads, ...reviewer]);
  assert.ok(results.every(r => r.status < 300), JSON.stringify(results.filter(r => r.status >= 300)));
  await idle();
  const v = (await call(0, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  const monitor = v.windows.filter((w: any) => !w.targetedFrom);
  assert.equal(monitor.length, 6, 'every upload kept');
  assert.equal(new Set(v.windows.map((w: any) => w.sequence)).size, v.windows.length, 'unique sequences');
  assert.ok(v.windows.every((w: any) => w.coverage === 'complete'), JSON.stringify(v.windows.map((w: any) => w.coverage)));
  assert.equal(verifyCalls, v.windows.length, 'exactly one provider check per window');
  assert.equal(v.interviewer.reviewerId, 'Iris');
  assert.equal(v.gestureChecks.length, 1);
  assert.equal(v.speakers.people[0].person, 1);
});

test('the same logical upload retried on the other instance is not processed twice', async () => {
  const { id, key } = await liveSession();
  clock = 1_000_000 + 60_000;
  const headers = { 'content-type': 'audio/wav', 'x-session-key': key, 'x-operation-id': 'same-op-123456', 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs: 30_000, endMs: 45_000 })) };
  const wav = voice(15);
  const r0 = await fetch(`${bases[0]}/api/sessions/${id}/windows`, { method: 'POST', headers, body: new Blob([new Uint8Array(wav)]) });
  const r1 = await fetch(`${bases[1]}/api/sessions/${id}/windows`, { method: 'POST', headers, body: new Blob([new Uint8Array(wav)]) });
  assert.deepEqual(await r0.json(), await r1.json());
  await idle();
  const v = (await call(1, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  assert.equal(v.windows.filter((w: any) => !w.targetedFrom).length, 1);
});

test('media written on one instance is served by the other; deletion removes it everywhere', async () => {
  const { id, key } = await liveSession();
  clock = 1_000_000 + 60_000;
  await call(0, 'POST', `/api/sessions/${id}/windows`, { key, wav: voice(15), meta: { startMs: 30_000, endMs: 45_000 } });
  await idle();
  const v = (await call(1, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  const media = v.windows[0].mediaName;
  // Instance 1 never had the file on its local disk: it must come from the shared store.
  const res = await fetch(`${bases[1]}/api/sessions/${id}/media/${media}`, { headers: { 'x-reviewer-token': TOKEN } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.ok(store.mediaCount >= 2, 'enrollment + window stored');
  assert.equal((await call(1, 'DELETE', `/api/sessions/${id}`, { reviewer: true })).status, 200);
  assert.equal(store.mediaCount, 0);
  assert.equal((await call(0, 'GET', `/api/sessions/${id}`, { reviewer: true })).status, 404, 'the other instance sees the deletion');
  assert.equal((await call(0, 'GET', '/api/sessions', { reviewer: true })).body.sessions.length, 0);
});

test('a background check finishing after another instance wrote still lands', async () => {
  const { id, key } = await liveSession();
  clock = 1_000_000 + 60_000;
  // Upload on 0 (its provider check runs in the background) while 1 keeps writing to the same session.
  const upload = call(0, 'POST', `/api/sessions/${id}/windows`, { key, wav: voice(15), meta: { startMs: 30_000, endMs: 45_000 } });
  const writes = Array.from({ length: 5 }, (_, i) => call(1, 'POST', `/api/sessions/${id}/interruptions`, { key, json: { kind: i % 2 ? 'resumed' : 'interrupted', reason: `net ${i}`, atMs: 40_000 + i } }));
  await Promise.all([upload, ...writes]);
  await idle();
  const v = (await call(1, 'GET', `/api/sessions/${id}`, { reviewer: true })).body;
  assert.equal(v.windows[0].coverage, 'complete');
  assert.equal(v.interruptions.filter((x: any) => x.reason.startsWith('net ')).length, 5, 'no interruption lost');
});

test('health reports the shared store; the cron sweep needs its secret', async () => {
  const h = await call(0, 'GET', '/api/health');
  assert.equal(h.body.store, 'memory');
  assert.equal(h.body.ok, true);
  assert.equal((await call(0, 'GET', '/api/cron/sweep')).status, 401);
  const swept = await call(1, 'GET', '/api/cron/sweep', { headers: { authorization: `Bearer ${CRON}` } });
  assert.equal(swept.status, 200);
  assert.deepEqual(swept.body.expired, { deleted: 0, failed: 0 });
});
