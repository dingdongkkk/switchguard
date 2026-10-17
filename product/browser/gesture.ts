/** In-browser gesture check with MediaPipe's gesture recognizer. Video frames never leave the
 * candidate's browser for this; only the outcome and one small snapshot are sent to the server.
 * A performed gesture is a liveness signal (a live person responding to a random prompt within
 * 30 s) — it does not prove identity and does not override any voice result. */
import type { GestureRecognizer, GestureRecognizerResult } from '@mediapipe/tasks-vision';

export type GestureName = 'thumbs_up' | 'thumbs_down' | 'raise_hand' | 'point_one_finger' | 'wave_hello';
export const GESTURE_PROMPT: Record<GestureName, { icon: string; text: string }> = {
  thumbs_up: { icon: '👍', text: 'Show a thumbs up to the camera' },
  thumbs_down: { icon: '👎', text: 'Show a thumbs down to the camera' },
  raise_hand: { icon: '✋', text: 'Raise one hand (either hand)' },
  point_one_finger: { icon: '☝️', text: 'Point one finger up' },
  wave_hello: { icon: '👋', text: 'Wave hello at the camera' },
};
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const CATEGORY_LABEL: Record<string, string> = {
  Thumb_Up: 'Thumbs up', Thumb_Down: 'Thumbs down', Pointing_Up: 'Pointing up', Open_Palm: 'Open hand', Closed_Fist: 'Fist', Victory: 'Victory sign', ILoveYou: 'I-love-you sign',
};

let recognizer: Promise<GestureRecognizer> | undefined;
/** Loads once per page (≈8 MB model, cached by the browser afterwards). GPU first, CPU fallback. */
export function loadRecognizer(): Promise<GestureRecognizer> {
  recognizer ??= (async () => {
    const vision: typeof import('@mediapipe/tasks-vision') = await import('/vendor/mediapipe/vision_bundle.mjs' as string);
    const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    const options = (delegate: 'GPU' | 'CPU') => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO' as const, numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { return await vision.GestureRecognizer.createFromOptions(fileset, options('GPU')); }
    catch { return await vision.GestureRecognizer.createFromOptions(fileset, options('CPU')); }
  })();
  recognizer.catch(() => { recognizer = undefined; });   // allow a retry on the next check
  return recognizer;
}

export interface GestureOutcome {
  status: 'performed' | 'not_performed' | 'unavailable';
  detectedAtPerf?: number; confidence?: number; observed?: string[]; frames: number; handFrames: number; reason?: string; snapshot?: string;
}
export interface GestureProgress { frames: number; handFrames: number; seeing?: string; matchedFrames: number }

interface HandObs { category: string; score: number; personHand: 'right' | 'left'; wristX: number; wristY: number; fingersUp: boolean }

function hands(result: GestureRecognizerResult): HandObs[] {
  return result.landmarks.map((lm, i) => {
    const g = result.gestures[i]?.[0], h = result.handedness[i]?.[0];
    // MediaPipe labels handedness as if the image were mirrored (selfie view). Camera frames are not
    // mirrored, so its "Left" is the person's right hand.
    const personHand: 'right' | 'left' = h?.categoryName === 'Left' ? 'right' : 'left';
    const wrist = lm[0]!, middleTip = lm[12]!, indexTip = lm[8]!, ringTip = lm[16]!;
    const fingersUp = middleTip.y < wrist.y - 0.08 && indexTip.y < wrist.y - 0.08 && ringTip.y < wrist.y - 0.05;
    return { category: g?.categoryName ?? 'None', score: g?.score ?? 0, personHand, wristX: wrist.x, wristY: wrist.y, fingersUp };
  });
}

/** Does this frame show the requested gesture? `history` holds recent wrist positions for waving. */
function matches(target: GestureName, obs: HandObs[], history: Array<{ t: number; x: number }>): { ok: boolean; score: number } {
  const best = (pred: (h: HandObs) => boolean) => { const h = obs.filter(pred).sort((a, b) => b.score - a.score)[0]; return { ok: !!h, score: h?.score ?? 0 }; };
  switch (target) {
    case 'thumbs_up': return best((h) => h.category === 'Thumb_Up' && h.score >= 0.6);
    case 'thumbs_down': return best((h) => h.category === 'Thumb_Down' && h.score >= 0.6);
    case 'point_one_finger': return best((h) => h.category === 'Pointing_Up' && h.score >= 0.6);
    case 'raise_hand':
      // Either hand, in the upper part of the picture with fingers pointing up.
      return best((h) => h.wristY < 0.55 && h.fingersUp);
    case 'wave_hello': {
      const open = obs.some((h) => (h.category === 'Open_Palm' || h.fingersUp));
      if (!open || history.length < 6) return { ok: false, score: 0 };
      // At least two direction changes of a side-to-side movement within the last 1.5 s.
      let turns = 0, dir = 0, last = history[0]!.x;
      for (const p of history.slice(1)) {
        const d = p.x - last;
        if (Math.abs(d) < 0.02) continue;
        const s = Math.sign(d);
        if (dir && s !== dir) turns++;
        dir = s; last = p.x;
      }
      return { ok: turns >= 2, score: Math.min(1, 0.5 + turns * 0.15) };
    }
  }
}

/** Pure per-frame decision, exported for tests: does this recognizer result show `target`? */
export function frameMatches(target: GestureName, result: GestureRecognizerResult, history: Array<{ t: number; x: number }> = []): { ok: boolean; score: number; seeing?: string } {
  const obs = hands(result);
  const main = [...obs].sort((a, b) => b.score - a.score)[0];
  return { ...matches(target, obs, history), seeing: main ? describe(main) : undefined };
}

function describe(obs: HandObs): string | undefined {
  if (obs.wristY < 0.55 && obs.fingersUp && (obs.category === 'None' || obs.category === 'Open_Palm')) return 'Raised hand';
  return obs.category !== 'None' && obs.score >= 0.6 ? CATEGORY_LABEL[obs.category] ?? obs.category : undefined;
}

/** Watches the preview video until the gesture is held briefly (~0.4 s) or the deadline passes. */
export async function watchGesture(video: HTMLVideoElement, target: GestureName, deadlinePerf: number,
  onProgress: (p: GestureProgress) => void, signal: { cancelled: boolean }): Promise<GestureOutcome> {
  if (!video.srcObject || !(video.srcObject as MediaStream).getVideoTracks().some((t) => t.readyState === 'live')) {
    return { status: 'unavailable', frames: 0, handFrames: 0, reason: 'The camera is not on' };
  }
  let rec: GestureRecognizer;
  try { rec = await loadRecognizer(); }
  catch (error) { return { status: 'unavailable', frames: 0, handFrames: 0, reason: `The gesture detector could not load (${(error as Error).message || 'network or browser problem'})` }; }
  const seen = new Map<string, number>(), recent: number[] = [], wrist: Array<{ t: number; x: number }> = [];
  let frames = 0, handFrames = 0, lastVideoTime = -1;
  return new Promise<GestureOutcome>((resolve) => {
    const tick = () => {
      if (signal.cancelled) { resolve({ status: 'not_performed', frames, handFrames, reason: 'cancelled' }); return; }
      const now = performance.now();
      if (now > deadlinePerf) {
        const observed = [...seen.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 3).slice(0, 3).map(([k]) => k);
        resolve({ status: 'not_performed', frames, handFrames, observed });
        return;
      }
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime && video.videoWidth) {
        lastVideoTime = video.currentTime;
        let result: GestureRecognizerResult | undefined;
        try { result = rec.recognizeForVideo(video, now); } catch { /* skip a bad frame */ }
        if (result) {
          frames++;
          const obs = hands(result);
          if (obs.length) handFrames++;
          for (const o of obs) { const d = describe(o); if (d) seen.set(d, (seen.get(d) ?? 0) + 1); }
          const main = obs.sort((a, b) => b.score - a.score)[0];
          if (main) { wrist.push({ t: now, x: main.wristX }); while (wrist.length && now - wrist[0]!.t > 1500) wrist.shift(); }
          const m = matches(target, obs, wrist);
          if (m.ok) recent.push(now);
          while (recent.length && now - recent[0]! > 1000) recent.shift();
          onProgress({ frames, handFrames, seeing: main ? describe(main) : undefined, matchedFrames: recent.length });
          if (recent.length >= 6) {
            resolve({ status: 'performed', detectedAtPerf: recent[0], confidence: m.score, frames, handFrames, snapshot: snapshot(video) });
            return;
          }
        }
      }
      setTimeout(tick, 60);   // ~15 checks per second keeps CPU use modest
    };
    tick();
  });
}

function snapshot(video: HTMLVideoElement): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = Math.round(320 * video.videoHeight / video.videoWidth);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch { return undefined; }
}
