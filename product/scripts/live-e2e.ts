/** LIVE end-to-end check of the product HTTP API with the real DetectifAI client (spends ~50 credits).
 * Audio is macOS TTS, i.e. synthetic by construction, so the CORRECT outcome is that the enrollment
 * authenticity gate refuses the reference. This proves the gate on live data; it is not an accuracy claim.
 * Usage: DETECTIF_API_TOKEN=... node dist/product/scripts/live-e2e.js */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { DetectifClient } from '../../src/server/detectif.js';
import { encodeWav } from '../../src/media/wav.js';
import { createProductApp } from '../server/app.js';
import { SwitchGuardService, defaultConfig } from '../server/service.js';

const token = process.env.DETECTIF_API_TOKEN || process.env.DETECTIF_API_KEY;
if (!token) { console.error('Set DETECTIF_API_TOKEN'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'sg-e2e-'));

/** Reads any 16-bit PCM WAV (skipping extra chunks such as FLLR) and returns mono floats. */
function decodePcm16(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  let off = 12, rate = 0, channels = 1, data: Buffer | undefined;
  while (off + 8 <= bytes.length) {
    const id = bytes.toString('ascii', off, off + 4), size = bytes.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = bytes.readUInt16LE(off + 10); rate = bytes.readUInt32LE(off + 12); }
    if (id === 'data') data = bytes.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error('bad wav');
  const frames = Math.floor(data.length / 2 / channels), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { samples: out, sampleRate: rate };
}
function tts(voice: string, text: string): Uint8Array {
  const file = join(tmp, `${voice}.wav`);
  execFileSync('say', ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  const { samples, sampleRate } = decodePcm16(readFileSync(file));
  return encodeWav(samples, sampleRate);
}

const root = resolve(fileURLToPath(import.meta.url), '../../../../..');
const service = new SwitchGuardService(new DetectifClient(token), defaultConfig(join(tmp, 'data')));
const server = createProductApp(service, { reviewerToken: 'e2e', root });
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const out: Record<string, unknown> = { note: 'LIVE DetectifAI via product API. Audio is macOS TTS (synthetic by construction).' };
try {
  const h = { 'x-reviewer-token': 'e2e', 'content-type': 'application/json' };
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: h, body: JSON.stringify({ displayName: 'TTS check', kind: 'interview' }) })).json() as any;
  const id = created.sessionId, key = created.candidateKey;
  const ch = { 'x-session-key': key, 'content-type': 'application/json' };
  await fetch(`${base}/api/sessions/${id}/consent`, { method: 'POST', headers: ch, body: JSON.stringify({ voiceAnalysis: true, camera: false, retention: true }) });
  const text = 'The harbor was quiet that morning. A few boats rocked gently against the pier while gulls circled overhead. Somewhere a radio played an old song, and the smell of fresh bread drifted from the bakery on the corner. It was the kind of day that made everyone slow down and notice small things.';
  const wav = tts('Samantha', text);
  const durationMs = (wav.length - 44) / 2 / 16;
  await new Promise(r => setTimeout(r, durationMs + 500)); // capture times may not be in the future
  const res = await fetch(`${base}/api/sessions/${id}/enrollment`, { method: 'POST', body: new Blob([new Uint8Array(wav)]), headers: {
    'x-session-key': key, 'content-type': 'audio/wav', 'x-operation-id': `e2e${Date.now()}`, 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs: 100, endMs: 100 + durationMs })) } });
  out.enrollmentHttpStatus = res.status;
  out.enrollment = await res.json();
  const view = await (await fetch(`${base}/api/sessions/${id}`, { headers: { 'x-reviewer-token': 'e2e' } })).json() as any;
  out.reviewerSeesAttempt = view.enrollmentAttempts?.[0];
  out.enrolled = Boolean(view.enrollment);
  out.usage = view.usage;
  const del = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: { 'x-reviewer-token': 'e2e' } });
  out.deleteSession = { status: del.status, body: await del.json() };
} catch (error) { out.error = (error as Error).message; }
finally { server.close(); await service.idle(); rmSync(tmp, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 2));
