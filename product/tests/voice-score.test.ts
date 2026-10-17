/** Slice scoring calibrated on a live interview: a second voice sat only 0.6–0.9 from the reference
 * on the timbre scale (the old fixed 1.5 floor never fired), usually with a pitch jump. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFERENT_SCORE, sliceScore, timbreThreshold, type VoiceProfile } from '../server/voice-analysis.js';

const profile: VoiceProfile = { version: 1, mean: [], std: [], f0Median: 116, segDistMean: 0.283, segDistStd: 0.102, segments: 20, voicedSec: 18 };

test('threshold follows the reference spread with a realistic floor', () => {
  assert.ok(Math.abs(timbreThreshold(profile) - 0.691) < 0.001);
  assert.equal(timbreThreshold({ ...profile, segDistMean: 0.1, segDistStd: 0.02 }), 0.55, 'floor for a very steady reference');
});

test('a second voice with a moderate timbre change and a pitch jump is different; normal intonation is not', () => {
  const T = timbreThreshold(profile);
  const different = (d: number, f0?: number) => sliceScore(d, f0, profile, T) > DIFFERENT_SCORE;
  // Live second speaker: timbre 0.62–0.76, pitch 133–154 Hz against a 116 Hz reference.
  assert.equal(different(0.62, 147), true);
  assert.equal(different(0.76, 154), true);
  // Large timbre change alone is enough.
  assert.equal(different(0.85, 116), true);
  // Same speaker: ordinary spread (0.3–0.6) with intonation between ~95 and ~130 Hz.
  for (const [d, f0] of [[0.45, 98], [0.6, 125], [0.56, 134], [0.5, 96], [0.33, 112]] as const) assert.equal(different(d, f0), false, `${d} @ ${f0} Hz`);
  // No pitch estimate: timbre decides.
  assert.equal(different(0.6), false);
});
