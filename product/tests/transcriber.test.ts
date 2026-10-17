/** LiveTranscriber against a fake Chrome SpeechRecognition (no microphone, no network): phrase
 * timing is bounded by the words, a stalled recogniser is restarted, and text Chrome never
 * finalised is still kept. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let T = 0;   // fake performance.now() and session clock (ms)
Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true });
const sent: Array<{ id: string; startMs: number; endMs: number; text: string }> = [];

class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
  onresult: ((e: any) => void) | null = null; onerror: ((e: any) => void) | null = null; onend: (() => void) | null = null;
  started = false; stopped = false;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() { FakeRecognition.all.push(this); }
  start() { this.started = true; }
  stop() { this.stopped = true; queueMicrotask(() => this.onend?.()); }
  abort() { this.stop(); }
  say(index: number, text: string, isFinal: boolean) {
    this.results[index] = { isFinal, 0: { transcript: text } };
    this.onresult?.({ resultIndex: index, results: this.results });
  }
}
(globalThis as any).webkitSpeechRecognition = FakeRecognition;

const { LiveTranscriber } = await import('../browser/transcriber.js');
const clock = { now: (p?: number) => p ?? T };
const tick = () => new Promise((r) => setImmediate(r));

test('phrases are timed by their words, stalls restart, and unfinished text is kept', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let level = 0;
  const t = new LiveTranscriber(async (p) => { sent.push(...p); }, clock, { onError: () => undefined, voiceLevel: () => level });
  T = 10_000; t.set(true);
  const r1 = FakeRecognition.all.at(-1)!;
  assert.ok(r1.started && r1.continuous && r1.interimResults);

  // Chrome shows an early interim at 10 s but only finalises six words at 65 s (what we saw live).
  r1.say(0, 'we', false);
  T = 65_000; r1.say(0, 'we used a queue for spikes', true);
  // Normal phrase right after.
  T = 66_000; r1.say(1, 'then we measured', false);
  T = 68_000; r1.say(1, 'then we measured the latency', true);

  // The mic hears speech but recognition goes silent: restarted after the stall window.
  level = 0.8;
  for (let i = 0; i < 20; i++) { T += 500; mock.timers.tick(500); }
  await tick();
  assert.equal(r1.stopped, true, 'stalled recogniser was stopped');
  mock.timers.tick(400); await tick();
  const r2 = FakeRecognition.all.at(-1)!;
  assert.notEqual(r2, r1); assert.ok(r2.started, 'and started again');

  // Text that is still interim when the transcript is paused is not lost.
  T = 90_000; r2.say(0, 'and alerts on errors', false);
  t.set(false);

  mock.timers.tick(2000); await tick(); await tick();
  mock.timers.tick(2000); await tick(); await tick();
  mock.timers.reset();
  clearInterval(t.flushTimer);

  assert.deepEqual(sent.map((p) => p.text), ['we used a queue for spikes', 'then we measured the latency', 'and alerts on errors']);
  const [a, b, c] = sent;
  assert.equal(a!.endMs, 65_000);
  assert.ok(a!.startMs >= 65_000 - 15_000 && a!.startMs <= 65_000 - 1500, `start bounded by its words, not the early interim: ${a!.startMs}`);
  assert.ok(b!.startMs >= 65_000 && b!.startMs <= 66_000 - 700 + 1, `second phrase starts after the first: ${b!.startMs}`);
  assert.equal(c!.endMs, 90_000);
  assert.ok(new Set(sent.map((p) => p.id)).size === 3);
});
