/** Worker thread for local voice analysis, so FFT and pitch tracking never block HTTP requests. */
import { parentPort } from 'node:worker_threads';
import { analyse, buildProfile, wavTo16k, type VoiceProfile } from './voice-analysis.js';

export type VoiceJob =
  | { id: number; op: 'profile'; wav: Uint8Array; sampleRate: number }
  | { id: number; op: 'analyse'; wavs: Array<{ wav: Uint8Array; sampleRate: number; tailSec?: number }>; profile: VoiceProfile };

parentPort?.on('message', (job: VoiceJob) => {
  try {
    if (job.op === 'profile') {
      parentPort!.postMessage({ id: job.id, ok: true, value: buildProfile(wavTo16k(job.wav, job.sampleRate)) ?? null });
      return;
    }
    // Join an optional tail of the previous window to the current one (boundary pass).
    const parts = job.wavs.map(({ wav, sampleRate, tailSec }) => {
      const x = wavTo16k(wav, sampleRate);
      return tailSec ? x.subarray(Math.max(0, x.length - Math.round(tailSec * 16_000))) : x;
    });
    const buffer = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let k = 0; for (const p of parts) { buffer.set(p, k); k += p.length; }
    const result = analyse(buffer, job.profile);
    parentPort!.postMessage({ id: job.id, ok: true, value: { signals: result.signals, slices: result.slices, prefixSec: parts.length > 1 ? parts[0]!.length / 16_000 : 0, buffer } }, [buffer.buffer]);
  } catch (error) {
    parentPort!.postMessage({ id: job.id, ok: false, error: (error as Error).message });
  }
});
