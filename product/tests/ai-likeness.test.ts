/** AI-likeness levels from DetectifAI's deepfake score: read from the stored raw response, and the
 * level never contradicts the verdict. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiLikeness } from '../browser/ai-score.js';

const verify = (score: number, threshold = 0.62, verdict = 'real') => ({ status: 200, body: { result: { decision: 'match' }, deepfake: { verdict, score, threshold } } });

test('score becomes a percentage and a level that agrees with the verdict', () => {
  assert.deepEqual(aiLikeness(verify(0.07), 'real'), { score: 0.07, pct: 7, threshold: 0.62, level: 'Very low', tone: 'ok' });
  assert.equal(aiLikeness(verify(0.45), 'real')?.level, 'Low');
  assert.equal(aiLikeness(verify(0.5, 0.62, 'not_sure'), 'not_sure')?.level, 'Borderline');
  assert.equal(aiLikeness(verify(0.7, 0.62, 'fake'), 'fake')?.level, 'High');
  assert.equal(aiLikeness(verify(0.95, 0.62, 'fake'), 'fake')?.level, 'Very high');
  // A real verdict is never shown as High, even with an unusual score.
  assert.equal(aiLikeness(verify(0.9), 'real')?.level, 'Low');
});

test('reads nested result envelopes and the detect endpoint; ignores missing or invalid scores', () => {
  assert.equal(aiLikeness({ body: { deepfake: { result: { verdict: 'real', score: 0.2 } } } }, 'real')?.pct, 20);
  assert.equal(aiLikeness({ body: { partial: { deepfake: { verdict: 'fake', score: 0.8 } } } }, 'fake')?.pct, 80);
  assert.equal(aiLikeness({ status: 200, body: { result: { verdict: 'real', score: 0.1, threshold: 0.6 } } }, 'real')?.threshold, 0.6);
  assert.equal(aiLikeness({ body: { deepfake: { verdict: 'real' } } }, 'real'), undefined);
  assert.equal(aiLikeness({ body: { deepfake: { verdict: 'real', score: 3 } } }, 'real'), undefined);
  assert.equal(aiLikeness(verify(0.2), undefined), undefined);
});
