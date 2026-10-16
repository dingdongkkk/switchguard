/** LIVE DetectifAI plumbing check (spends a few credits). Uses macOS `say` text-to-speech, so every
 * clip is SYNTHETIC by construction: this verifies request/response handling, idempotency and
 * deletion against the real API — it is not a detection-accuracy test and involves no person's voice.
 * Usage: DETECTIF_API_TOKEN=... node dist/product/scripts/live-smoke.js */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DetectifClient, normalizeCombined } from '../../src/server/detectif.js';
import type { AudioWindow } from '../../src/shared/contracts.js';

const token = process.env.DETECTIF_API_TOKEN || process.env.DETECTIF_API_KEY;
if (!token) { console.error('Set DETECTIF_API_TOKEN'); process.exit(2); }
const client = new DetectifClient(token);
const dir = mkdtempSync(join(tmpdir(), 'sg-live-'));
const TEXT = 'The harbor was quiet that morning. A few boats rocked gently against the pier while gulls circled overhead. ' +
  'Somewhere a radio played an old song, and the smell of fresh bread drifted from the bakery on the corner. ' +
  'It was the kind of day that made everyone slow down and notice small things, like the sound of rope against wood.';
function tts(voice: string, text: string, name: string): Uint8Array {
  const out = join(dir, `${name}.wav`);
  execFileSync('say', ['-v', voice, '-o', out, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  return new Uint8Array(readFileSync(out));
}
const summary = (r: { status: number; body: any; attempts: number; requestId?: string }) => ({ status: r.status, attempts: r.attempts, requestId: r.requestId, error: r.body?.error?.code, credits: r.body?.credits });
const speakerId = `sg-smoke-${randomUUID().slice(0, 8)}`;
const report: Record<string, unknown> = { note: 'All audio is macOS TTS (synthetic). Plumbing check only.' };
try {
  report.health = (await client.health()).body;
  report.creditsBefore = (await client.credits()).body;
  const enrollAudio = tts('Samantha', `${TEXT} ${TEXT}`, 'enroll');
  const sameVoice = tts('Samantha', 'Thank you for having me today. I have worked as a software engineer for six years, mostly on backend systems.', 'same');
  const otherVoice = tts('Daniel', 'Thank you for having me today. I have worked as a software engineer for six years, mostly on backend systems.', 'other');

  const detect = await client.detect(enrollAudio, randomUUID());
  report.detectOnEnrollmentTts = { ...summary(detect), verdict: detect.body?.result?.verdict, decided_by: detect.body?.result?.decided_by };

  const enrollKey = randomUUID();
  const enroll = await client.enroll(speakerId, enrollAudio, enrollKey);
  report.enroll = { ...summary(enroll), speaker: enroll.body?.speaker?.speaker_id, quality: enroll.body?.quality };
  const replay = await client.enroll(speakerId, enrollAudio, enrollKey);
  report.enrollIdempotentReplay = { ...summary(replay), idempotent_replay: replay.body?.idempotent_replay };

  const win = (id: string): AudioWindow => ({ id, sessionId: 'smoke', sequence: 0, startMs: 10_000, endMs: 17_000, answerIds: [], source: 'labelled_upload', purpose: 'monitor', referenceId: 'ref', mimeType: 'audio/wav', sampleRate: 16000, sampleCount: 0, mediaOffsetMs: 0, coverage: 'pending' });
  for (const [label, audio] of [['sameTtsVoice', sameVoice], ['differentTtsVoice', otherVoice]] as const) {
    const r = await client.verify(speakerId, audio, randomUUID());
    const n = normalizeCombined(r, win(label), 0);
    report[`verify_${label}`] = { ...summary(r), speaker: n.speaker.status === 'complete' ? { decision: n.speaker.decision, similarity: n.speaker.similarity, threshold: n.speaker.threshold } : n.speaker,
      authenticity: n.authenticity.status === 'complete' ? { verdict: n.authenticity.verdict, segments: n.authenticity.segments.length } : n.authenticity };
  }
} catch (error) {
  report.error = (error as Error).message;
} finally {
  try { const d = await client.deleteSpeaker(speakerId); report.deleteSpeaker = { ...summary(d), deleted: d.body?.deleted }; } catch (error) { report.deleteSpeaker = (error as Error).message; }
  try { report.creditsAfter = (await client.credits()).body; } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
