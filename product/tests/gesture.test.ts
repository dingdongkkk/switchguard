/** Gesture rules on simulated MediaPipe results (no camera, no model): category mapping,
 * mirrored handedness → the person's own left/right, raised-hand geometry and waving. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GestureRecognizerResult } from '@mediapipe/tasks-vision';
import { frameMatches } from '../browser/gesture.js';

type Pt = { x: number; y: number; z: number; visibility: number };
/** 21 landmarks: wrist at (x, y); fingertips above it when `up`. */
function hand(x: number, y: number, up: boolean): Pt[] {
  const pts: Pt[] = Array.from({ length: 21 }, () => ({ x, y, z: 0, visibility: 1 }));
  for (const tip of [8, 12, 16, 20]) pts[tip] = { x, y: up ? y - 0.2 : y + 0.05, z: 0, visibility: 1 };
  return pts;
}
function result(...hs: Array<{ category: string; score?: number; label: 'Left' | 'Right'; x?: number; y?: number; up?: boolean }>): GestureRecognizerResult {
  return {
    landmarks: hs.map((h) => hand(h.x ?? 0.5, h.y ?? 0.6, h.up ?? false)),
    worldLandmarks: hs.map(() => []),
    handedness: hs.map((h) => [{ categoryName: h.label, displayName: h.label, score: 0.95, index: 0 }]),
    handednesses: hs.map((h) => [{ categoryName: h.label, displayName: h.label, score: 0.95, index: 0 }]),
    gestures: hs.map((h) => [{ categoryName: h.category, displayName: h.category, score: h.score ?? 0.9, index: 0 }]),
  } as unknown as GestureRecognizerResult;
}

test('recognizer categories map to the requested gestures', () => {
  assert.equal(frameMatches('thumbs_up', result({ category: 'Thumb_Up', label: 'Left' })).ok, true);
  assert.equal(frameMatches('thumbs_up', result({ category: 'Thumb_Down', label: 'Left' })).ok, false);
  assert.equal(frameMatches('thumbs_down', result({ category: 'Thumb_Down', label: 'Right' })).ok, true);
  assert.equal(frameMatches('point_one_finger', result({ category: 'Pointing_Up', label: 'Right' })).ok, true);
  assert.equal(frameMatches('thumbs_up', result({ category: 'Thumb_Up', score: 0.4, label: 'Left' })).ok, false, 'low confidence is not enough');
  assert.equal(frameMatches('thumbs_up', result()).ok, false, 'no hand');
});

test('raise a hand: either hand counts, but it must be up high with fingers up', () => {
  const rightRaised = result({ category: 'Open_Palm', label: 'Left', x: 0.3, y: 0.35, up: true });   // MediaPipe "Left" = person's right
  const leftRaised = result({ category: 'Open_Palm', label: 'Right', x: 0.7, y: 0.35, up: true });
  assert.equal(frameMatches('raise_hand', rightRaised).ok, true);
  assert.equal(frameMatches('raise_hand', leftRaised).ok, true);
  assert.equal(frameMatches('raise_hand', rightRaised).seeing, 'Raised hand');
  // A hand low in the frame, or fingers pointing down, is not "raised".
  assert.equal(frameMatches('raise_hand', result({ category: 'Open_Palm', label: 'Right', y: 0.8, up: true })).ok, false);
  assert.equal(frameMatches('raise_hand', result({ category: 'None', label: 'Right', y: 0.35, up: false })).ok, false);
  assert.equal(frameMatches('raise_hand', result({ category: 'None', label: 'Left', y: 0.35, up: true })).ok, true);
});

test('waving needs an open hand moving side to side', () => {
  const open = result({ category: 'Open_Palm', label: 'Left', y: 0.4, up: true });
  const waving = [0.40, 0.46, 0.52, 0.46, 0.40, 0.46, 0.52].map((x, i) => ({ t: i * 100, x }));
  const still = [0.45, 0.46, 0.45, 0.46, 0.45, 0.46, 0.45].map((x, i) => ({ t: i * 100, x }));
  assert.equal(frameMatches('wave_hello', open, waving).ok, true);
  assert.equal(frameMatches('wave_hello', open, still).ok, false, 'small jitter is not a wave');
  assert.equal(frameMatches('wave_hello', result({ category: 'Closed_Fist', label: 'Left', y: 0.6, up: false }), waving).ok, false, 'a moving fist is not a wave');
});
