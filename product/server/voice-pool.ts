/** One background worker for voice analysis with a bounded queue and a per-job timeout. A worker that
 * hangs or crashes is replaced; the caller gets an error and records "analysis skipped" — never a pass. */
import { Worker } from 'node:worker_threads';
import type { SliceAnalysis, VoiceProfile, VoiceSignal } from './voice-analysis.js';

export interface AnalyseResult { signals: VoiceSignal[]; slices: SliceAnalysis[]; prefixSec: number; buffer: Float32Array }
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class VoicePool {
  private worker?: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: Array<() => void> = [];
  private busy = 0;
  restarts = 0;
  lastError?: string;

  constructor(private readonly timeoutMs = 15_000, private readonly maxQueue = 100) {}

  get state(): 'idle' | 'busy' { return this.busy ? 'busy' : 'idle'; }
  get queued(): number { return this.queue.length + this.busy; }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./voice-worker.js', import.meta.url));
    worker.on('message', (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id); if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error ?? 'voice analysis failed'));
    });
    const fail = (why: string) => {
      if (this.worker !== worker) return;
      this.worker = undefined; this.restarts++; this.lastError = why;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(id); }
    };
    worker.on('error', (e) => fail(`voice worker error: ${e.message}`));
    worker.on('exit', (code) => { if (code !== 0) fail(`voice worker exited (${code})`); else if (this.worker === worker) this.worker = undefined; });
    // unref after the listeners (adding a 'message' listener re-references the port), so an idle
    // worker never keeps the process alive.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /** Runs jobs one at a time so analysis never competes with itself for the CPU. */
  private run<T>(message: Record<string, unknown>, transfer: ArrayBuffer[]): Promise<T> {
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('voice analysis queue is full'));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.busy++;
        const id = this.nextId++, worker = this.ensure();
        const done = () => {
          this.busy--;
          const next = this.queue.shift();
          if (next) next(); else this.scheduleIdleStop();
        };
        const timer = setTimeout(() => {
          this.pending.delete(id); this.lastError = 'voice analysis timed out';
          void worker.terminate(); if (this.worker === worker) { this.worker = undefined; this.restarts++; }
          reject(new Error('voice analysis timed out')); done();
        }, this.timeoutMs);
        this.pending.set(id, { resolve: (v) => { resolve(v); done(); }, reject: (e) => { reject(e); done(); }, timer });
        worker.postMessage({ ...message, id }, transfer);
      };
      if (this.busy) this.queue.push(start); else start();
    });
  }

  profile(wav: Uint8Array, sampleRate: number): Promise<VoiceProfile | null> {
    const copy = wav.slice();
    return this.run({ op: 'profile', wav: copy, sampleRate }, [copy.buffer as ArrayBuffer]);
  }
  analyse(wavs: Array<{ wav: Uint8Array; sampleRate: number; tailSec?: number }>, profile: VoiceProfile): Promise<AnalyseResult> {
    const copies = wavs.map((w) => ({ ...w, wav: w.wav.slice() }));
    return this.run({ op: 'analyse', wavs: copies, profile }, copies.map((c) => c.wav.buffer as ArrayBuffer));
  }
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** Stops the worker after 30 s without work; the next job starts a fresh one (~50 ms). */
  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.busy && this.worker) { const w = this.worker; this.worker = undefined; void w.terminate(); } }, 30_000);
    this.idleTimer.unref();
  }
  async close(): Promise<void> { const w = this.worker; this.worker = undefined; if (w) await w.terminate(); }
}
