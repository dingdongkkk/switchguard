/** Local voice-consistency analysis (no network, no ML model). It compares 1.5 s slices of each
 * analysis window with a profile built from the accepted reference, to find stretches that sound
 * like a different voice, or like more than one voice at once. It is a cheap screening heuristic:
 * it can only *request* a targeted DetectifAI check of the suspicious stretch. Only a DetectifAI
 * result can become evidence; the local estimate is shown to reviewers as an estimate. */

const RATE = 16_000;
const FRAME = 400, HOP = 160, NFFT = 512, MELS = 26, CEPS = 13;    // 25 ms frames, 10 ms hop at 16 kHz
const SEG_FRAMES = 150, SEG_HOP = 75;                               // 1.5 s slices, 0.75 s hop
const F0_MIN = 60, F0_MAX = 400;

export interface VoiceProfile {
  version: 1;
  /** Mean and spread of 12 cepstral coefficients (voice timbre) over voiced frames. */
  mean: number[]; std: number[];
  f0Median: number;
  /** How far the reference's own slices sit from its mean: the baseline for "different". */
  segDistMean: number; segDistStd: number;
  segments: number; voicedSec: number;
}

export interface SliceAnalysis { startSec: number; endSec: number; distance: number; f0Median?: number; voicedRatio: number; multi: boolean; different: boolean; vec: number[] }
export interface VoiceSignal {
  kind: 'speaker_change_suspected' | 'multiple_voices_suspected';
  /** Seconds relative to the analysed buffer start. */
  startSec: number; endSec: number;
  /** How far beyond the reference baseline (1 = at threshold). */
  strength: number;
  detail: string;
}
export interface VoiceAnalysis { slices: SliceAnalysis[]; signals: VoiceSignal[]; voicedSec: number }

// ---------------------------------------------------------------- decoding
/** Mono PCM16 WAV (canonical layout validated by inspectWav) → float samples at 16 kHz. */
export function wavTo16k(bytes: Uint8Array, sampleRate: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor((bytes.byteLength - 44) / 2);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = view.getInt16(44 + i * 2, true) / 32768;
  return resampleTo16k(src, sampleRate);
}
export function resampleTo16k(src: Float32Array, rate: number): Float32Array {
  if (rate === RATE) return src;
  const ratio = rate / RATE;
  if (Number.isInteger(ratio)) {
    // Box-car average then decimate (enough anti-aliasing for timbre statistics).
    const out = new Float32Array(Math.floor(src.length / ratio));
    for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < ratio; k++) s += src[i * ratio + k]!; out[i] = s / ratio; }
    return out;
  }
  const out = new Float32Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) { const p = i * ratio, i0 = Math.floor(p), f = p - i0; out[i] = (src[i0] ?? 0) * (1 - f) + (src[i0 + 1] ?? src[i0] ?? 0) * f; }
  return out;
}

// ---------------------------------------------------------------- features
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const hamming = Float64Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const melBank: Array<{ start: number; weights: number[] }> = (() => {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700), inv = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(80), hi = mel(7600), pts = Array.from({ length: MELS + 2 }, (_, i) => inv(lo + ((hi - lo) * i) / (MELS + 1)));
  const bin = (f: number) => Math.floor(((NFFT + 1) * f) / RATE);
  return Array.from({ length: MELS }, (_, m) => {
    const a = bin(pts[m]!), b = bin(pts[m + 1]!), c = bin(pts[m + 2]!), weights: number[] = [];
    for (let k = a; k < c; k++) weights.push(k < b ? (k - a) / Math.max(1, b - a) : (c - k) / Math.max(1, c - b));
    return { start: a, weights };
  });
})();
const dct = Array.from({ length: CEPS }, (_, k) => Array.from({ length: MELS }, (_, m) => Math.cos((Math.PI * k * (m + 0.5)) / MELS)));

interface Frame { cep: number[]; energy: number; f0?: number }

function frames(x: Float32Array): Frame[] {
  const out: Frame[] = [];
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let start = 0; start + FRAME <= x.length; start += HOP) {
    re.fill(0); im.fill(0);
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = x[start + i]! - 0.97 * (start + i > 0 ? x[start + i - 1]! : 0);
      re[i] = s * hamming[i]!; energy += x[start + i]! * x[start + i]!;
    }
    fft(re, im);
    const logMel = melBank.map(({ start: s0, weights }) => {
      let e = 1e-10;
      for (let k = 0; k < weights.length; k++) { const b = s0 + k; e += (re[b]! * re[b]! + im[b]! * im[b]!) * weights[k]!; }
      return Math.log(e);
    });
    const cep = dct.slice(1).map((row) => row.reduce((acc, c, m) => acc + c * logMel[m]!, 0));   // drop c0 (loudness)
    out.push({ cep, energy: Math.sqrt(energy / FRAME) });
  }
  // Pitch every second frame (20 ms) by normalised autocorrelation on 40 ms.
  const win = 640, minLag = Math.floor(RATE / F0_MAX), maxLag = Math.ceil(RATE / F0_MIN);
  for (let f = 0; f < out.length; f += 2) {
    const start = f * HOP;
    if (start + win + maxLag > x.length) break;
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[start + i]! * x[start + i]!;
    if (e0 < 1e-6) continue;
    const r = new Float64Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let num = 0, e1 = 0;
      for (let i = 0; i < win; i++) { num += x[start + i]! * x[start + i + lag]!; e1 += x[start + i + lag]! * x[start + i + lag]!; }
      r[lag] = num / Math.sqrt(e0 * e1 + 1e-12);
      if (lag <= maxLag && r[lag]! > best) best = r[lag]!;
    }
    // First local peak close to the best one: avoids octave-down errors (picking 2× the period).
    let bestLag = 0;
    for (let lag = minLag + 1; lag <= maxLag; lag++) if (r[lag]! >= 0.85 * best && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) { bestLag = lag; break; }
    if (best > 0.5 && bestLag) { out[f]!.f0 = RATE / bestLag; if (out[f + 1]) out[f + 1]!.f0 = RATE / bestLag; }
  }
  // Voiced = above an adaptive energy floor.
  const sorted = out.map((fr) => fr.energy).sort((a, b) => a - b);
  const floor = Math.max(0.006, (sorted[Math.floor(sorted.length * 0.1)] ?? 0) * 2.5);
  return out.map((fr) => (fr.energy > floor ? fr : { ...fr, cep: [], f0: undefined }));
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const voiced = (fr: Frame) => fr.cep.length > 0;

/** Overlapping speakers show up as pitch jumping back and forth between two distinct levels. */
function multipleVoices(f0s: number[]): boolean {
  if (f0s.length < 20) return false;
  const logs = f0s.map(Math.log2), mid = median(logs);
  const low = logs.filter((v) => v < mid - 0.05), high = logs.filter((v) => v > mid + 0.05);
  if (low.length < f0s.length * 0.25 || high.length < f0s.length * 0.25) return false;
  if (median(high) - median(low) < 0.45) return false;          // ≥ ~37 % apart: two pitch tracks, not intonation
  // Each level must be steady (two voices), not one voice sweeping continuously through the range.
  const spread = (v: number[]) => { const m = median(v); return median(v.map((x) => Math.abs(x - m))); };
  if (spread(low) > 0.1 || spread(high) > 0.1) return false;
  // Rapid alternation in short runs (turn-taking or talking over each other), not one long change.
  let switches = 0, side = 0, run = 0;
  const runs: number[] = [];
  for (const v of logs) { const s = v > mid ? 1 : -1; if (side && s !== side) { switches++; runs.push(run); run = 0; } side = s; run++; }
  return switches >= 6 && median(runs) <= 25;               // runs of ≤ 250 ms (10 ms frames)
}

function sliceStats(fr: Frame[], from: number): { vec?: number[]; f0Median?: number; voicedRatio: number; multi: boolean } {
  const seg = fr.slice(from, from + SEG_FRAMES), v = seg.filter(voiced);
  const voicedRatio = v.length / Math.max(1, seg.length);
  if (v.length < SEG_FRAMES * 0.35) return { voicedRatio, multi: false };
  const vec = Array.from({ length: CEPS - 1 }, (_, k) => v.reduce((a, f) => a + f.cep[k]!, 0) / v.length);
  const f0s = seg.map((f) => f.f0).filter((x): x is number => x !== undefined);
  return { vec, f0Median: f0s.length >= 10 ? median(f0s) : undefined, voicedRatio, multi: multipleVoices(f0s) };
}

function distance(vec: number[], p: VoiceProfile): number {
  let s = 0;
  for (let k = 0; k < vec.length; k++) { const d = (vec[k]! - p.mean[k]!) / Math.max(p.std[k]!, 1e-3); s += d * d; }
  return Math.sqrt(s / vec.length);
}

// ---------------------------------------------------------------- profile & analysis
export function buildProfile(x16k: Float32Array): VoiceProfile | undefined {
  const fr = frames(x16k), v = fr.filter(voiced);
  if (v.length < 300) return undefined;                          // < 3 s of voiced audio: no reliable profile
  const mean = Array.from({ length: CEPS - 1 }, (_, k) => v.reduce((a, f) => a + f.cep[k]!, 0) / v.length);
  const std = mean.map((m, k) => Math.sqrt(v.reduce((a, f) => a + (f.cep[k]! - m) ** 2, 0) / v.length));
  const f0s = fr.map((f) => f.f0).filter((x): x is number => x !== undefined);
  const partial: VoiceProfile = { version: 1, mean, std, f0Median: f0s.length ? median(f0s) : NaN, segDistMean: 0, segDistStd: 0, segments: 0, voicedSec: v.length * HOP / RATE };
  const dists: number[] = [];
  for (let i = 0; i + SEG_FRAMES <= fr.length; i += SEG_HOP) { const s = sliceStats(fr, i); if (s.vec) dists.push(distance(s.vec, partial)); }
  if (dists.length < 3) return undefined;
  const dm = dists.reduce((a, b) => a + b, 0) / dists.length;
  const ds = Math.sqrt(dists.reduce((a, b) => a + (b - dm) ** 2, 0) / dists.length);
  return { ...partial, segDistMean: dm, segDistStd: ds, segments: dists.length };
}

export function analyse(x16k: Float32Array, profile: VoiceProfile): VoiceAnalysis {
  const fr = frames(x16k);
  // Timbre must sit well outside the reference's own slice-to-slice variation, with an absolute floor
  // so ordinary intonation and loudness changes from the same person do not trigger it.
  const threshold = Math.max(profile.segDistMean + 4 * profile.segDistStd, 1.5);
  const slices: SliceAnalysis[] = [];
  const last = Math.max(0, fr.length - SEG_FRAMES);
  for (let i = 0; i <= last; i += SEG_HOP) {
    const s = sliceStats(fr, i);
    if (!s.vec) continue;
    const d = distance(s.vec, profile);
    const pitchShift = s.f0Median && Number.isFinite(profile.f0Median) ? Math.abs(Math.log2(s.f0Median / profile.f0Median)) : 0;
    // Timbre far outside the reference's own spread, or a large pitch shift with some timbre change.
    const different = d > threshold || (pitchShift > 0.5 && d > threshold * 0.7);
    slices.push({ startSec: (i * HOP) / RATE, endSec: ((i + Math.min(SEG_FRAMES, fr.length - i)) * HOP + FRAME) / RATE, distance: d / threshold, f0Median: s.f0Median, voicedRatio: s.voicedRatio, multi: s.multi, different, vec: s.vec.map((v) => Math.round(v * 1000) / 1000) });
  }
  const signals: VoiceSignal[] = [];
  const runs = (pick: (s: SliceAnalysis) => boolean, kind: VoiceSignal['kind']) => {
    let run: SliceAnalysis[] = [];
    const close = () => {
      if (run.length >= 2) {
        const strength = Math.max(...run.map((s) => s.distance));
        signals.push({ kind, startSec: run[0]!.startSec, endSec: run.at(-1)!.endSec, strength,
          detail: kind === 'multiple_voices_suspected' ? 'Pitch alternates rapidly between two distinct levels, as when two people take quick turns or talk over each other.'
            : `Different voice, or more than one voice: timbre ${strength.toFixed(1)}× beyond the reference's own variation${run.some((s) => s.f0Median) ? `; pitch ≈${Math.round(median(run.map((s) => s.f0Median ?? NaN).filter(Number.isFinite)))} Hz vs reference ≈${Math.round(profile.f0Median)} Hz` : ''}.` });
      }
      run = [];
    };
    for (const s of slices) { if (pick(s)) run.push(s); else close(); }
    close();
  };
  runs((s) => s.different && !s.multi, 'speaker_change_suspected');
  runs((s) => s.multi, 'multiple_voices_suspected');
  return { slices, signals, voicedSec: fr.filter(voiced).length * HOP / RATE };
}

// ---------------------------------------------------------------- speaker grouping (Person 1, 2, 3…)
/** A voice heard in this session. Person 1 is the enrolled reference; later people are created when a
 * slice is clearly unlike every voice heard so far. Labels are local estimates, not identities. */
export interface SpeakerCluster { person: number; centroid: number[]; f0?: number; slices: number }
export type SliceSpeaker = number | 'several';

/** Same scale as the reference check: RMS of per-dimension z-scores using the reference's spread. */
function zDistance(a: number[], b: number[], p: VoiceProfile): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) { const d = (a[k]! - b[k]!) / Math.max(p.std[k]!, 1e-3); s += d * d; }
  return Math.sqrt(s / a.length);
}

/** Assigns each slice to Person 1 (reference), an existing extra person, or a new person (up to
 * `maxPeople`). Slices with two voices at once are 'several'. Clusters are updated in place. */
export function assignSpeakers(slices: SliceAnalysis[], profile: VoiceProfile, clusters: SpeakerCluster[], maxPeople = 6): SliceSpeaker[] {
  const threshold = Math.max(profile.segDistMean + 4 * profile.segDistStd, 1.5);
  if (!clusters.some((c) => c.person === 1)) clusters.unshift({ person: 1, centroid: [...profile.mean], f0: profile.f0Median, slices: 0 });
  const known = new Set(clusters.map((c) => c.person));
  const labels = slices.map((slice) => label(slice));
  // A slice straddling a switch (half one voice, half another) can look like nobody heard so far. A
  // new person is only kept when at least two slices agree; a lone one joins its neighbour.
  for (const c of [...clusters]) {
    if (known.has(c.person) || c.slices >= 2) continue;
    clusters.splice(clusters.indexOf(c), 1);
    labels.forEach((l, i) => {
      if (l !== c.person) return;
      const next = labels.slice(i + 1).find((x) => x !== c.person), prev = labels.slice(0, i).reverse().find((x) => x !== c.person);
      labels[i] = next ?? prev ?? 'several';
    });
  }
  // Number the people confirmed in this pass consecutively after everyone already known.
  let nextPerson = Math.max(...known);
  const renumber = new Map<number, number>();
  for (const c of clusters) if (!known.has(c.person)) { renumber.set(c.person, ++nextPerson); c.person = nextPerson; }
  return labels.map((l) => (typeof l === 'number' && renumber.has(l) ? renumber.get(l)! : l));

  function label(slice: SliceAnalysis): SliceSpeaker {
    if (slice.multi) return 'several';
    if (!slice.different) { clusters.find((c) => c.person === 1)!.slices++; return 1; }
    // Nearest voice heard so far (excluding the reference, which this slice already failed).
    let best: SpeakerCluster | undefined, bestD = Infinity;
    for (const c of clusters) {
      if (c.person === 1) continue;
      let d = zDistance(slice.vec, c.centroid, profile);
      if (c.f0 && slice.f0Median) d += Math.max(0, Math.abs(Math.log2(slice.f0Median / c.f0)) - 0.25) * 2;   // big pitch gaps separate voices too
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best && bestD <= threshold) {
      // Running mean with bounded memory so a voice's profile settles but can still adapt.
      const w = Math.min(best.slices, 20);
      best.centroid = best.centroid.map((v, k) => (v * w + slice.vec[k]!) / (w + 1));
      if (slice.f0Median) best.f0 = best.f0 ? (best.f0 * w + slice.f0Median) / (w + 1) : slice.f0Median;
      best.slices++;
      return best.person;
    }
    if (clusters.length >= maxPeople) return best?.person ?? 'several';
    const person = Math.max(...clusters.map((c) => c.person)) + 1;
    clusters.push({ person, centroid: [...slice.vec], f0: slice.f0Median, slices: 1 });
    return person;
  }
}
