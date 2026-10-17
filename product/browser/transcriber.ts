/** Live transcript on the candidate's device (Chrome speech recognition). Each final phrase is
 * stamped on the session clock and sent in small batches; the server colours phrases using the
 * voice grouping and DetectifAI results at the same time. Chrome runs one recogniser at a time, so
 * the page turns this off while a challenge phrase is being recorded. */
import type { SessionClock } from './api.js';

export interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort?(): void;
}
export const SpeechRecognitionCtor: (new () => SpeechRecognitionLike) | undefined =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export type Phrase = { id: string; startMs: number; endMs: number; text: string };
/** Recognition reports a phrase a little after speech starts; pull the start back by this much. */
const LEAD_MS = 700;
const FLUSH_MS = 2000;
/** Chrome's first (interim) result can arrive long before the words, so a phrase's start is also
 * bounded by how long its words take to say. */
const MS_PER_WORD = 420, MIN_PHRASE_MS = 1500, MAX_PHRASE_MS = 15_000;
/** Restart when the microphone hears speech but recognition has produced nothing for this long. */
const STALL_MS = 8000;
/** Chrome's long continuous sessions degrade; rotate at the next pause, and always after this long. */
const ROTATE_AFTER_MS = 50_000, FORCE_ROTATE_MS = 90_000;

export class LiveTranscriber {
  private rec: SpeechRecognitionLike | undefined;
  private wanted = false;
  private disabled = false;
  private starts = new Map<number, number>();
  /** Latest interim text per result index, emitted if Chrome stops before finalising it. */
  private interim = new Map<number, string>();
  private lastResultAt = 0;
  private lastVoiceAt = 0;
  private lastEndMs = 0;
  /** A planned restart is in progress (not counted as a failure). */
  private stopping = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private queue: Phrase[] = [];
  private sending = false;
  private quickEnds = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  readonly flushTimer: ReturnType<typeof setInterval>;
  phrases = 0;

  constructor(private readonly send: (phrases: Phrase[]) => Promise<unknown>, private readonly clock: Pick<SessionClock, 'now'>,
    private readonly hooks: { onError: (text: string) => void; onChange?: () => void; voiceLevel?: () => number }) {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.watchdog = setInterval(() => this.check(), 500);
  }

  /** Restarts a stalled recogniser and rotates long sessions so speech is not silently lost. */
  private check(): void {
    const now = performance.now();
    if ((this.hooks.voiceLevel?.() ?? 0) > 0.35) this.lastVoiceAt = now;
    const r = this.rec;
    if (!r) return;
    const age = now - this.startedAt, sinceResult = now - Math.max(this.lastResultAt, this.startedAt);
    const stalled = sinceResult > STALL_MS && this.lastVoiceAt > Math.max(this.lastResultAt, this.startedAt) + 1000;
    const rotate = (age > ROTATE_AFTER_MS && this.interim.size === 0 && sinceResult > 1200) || age > FORCE_ROTATE_MS;
    if ((stalled || rotate) && !this.stopping) { this.stopping = true; try { r.stop(); } catch { /* onend restarts */ } }
  }

  private emit(index: number, text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    const firstSeen = this.starts.get(index);
    this.starts.delete(index); this.interim.delete(index);
    if (!clean) return;
    const endMs = Math.round(this.clock.now());
    const words = clean.split(' ').length;
    const span = Math.min(MAX_PHRASE_MS, Math.max(MIN_PHRASE_MS, words * MS_PER_WORD + 600));
    const first = firstSeen ?? endMs - span;
    const startMs = Math.round(Math.max(first, endMs - span, Math.min(this.lastEndMs, endMs - MIN_PHRASE_MS), 0));
    this.lastEndMs = endMs;
    this.queue.push({ id: phraseId(), startMs: Math.min(startMs, endMs), endMs, text: clean.slice(0, 500) });
    if (this.queue.length > 300) this.queue.splice(0, this.queue.length - 300);
    this.phrases++;
  }
  /** Text Chrome showed but never finalised (it was stopped or restarted) is kept, not dropped. */
  private emitPending(): void { for (const [i, text] of [...this.interim]) this.emit(i, text); this.starts.clear(); }

  get active(): boolean { return !!this.rec; }
  get unavailable(): boolean { return this.disabled || !SpeechRecognitionCtor; }

  /** Turn recognition on or off; restarts by itself when Chrome ends a session. */
  set(wanted: boolean): void {
    this.wanted = wanted;
    if (wanted && !this.rec && !this.restartTimer) this.begin();
    if (!wanted) {
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
      const r = this.rec; this.rec = undefined;
      if (r) { this.emitPending(); r.onend = null; r.onresult = null; r.onerror = null; try { (r.abort ?? r.stop).call(r); } catch { /* already stopped */ } this.hooks.onChange?.(); }
    }
  }

  private begin(): void {
    if (this.disabled || !SpeechRecognitionCtor || !this.wanted) return;
    let r: SpeechRecognitionLike;
    try { r = new SpeechRecognitionCtor(); } catch { this.disabled = true; return; }
    const lang = navigator.language ?? 'en-US';
    r.lang = /^en\b/i.test(lang) ? lang : 'en-US';
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    this.starts.clear(); this.interim.clear(); this.stopping = false;
    r.onresult = (event: any) => {
      this.lastResultAt = performance.now();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result?.[0] ? String(result[0].transcript) : '';
        if (text.trim() && !this.starts.has(i)) this.starts.set(i, Math.max(0, this.clock.now() - LEAD_MS));
        if (result?.isFinal) this.emit(i, text);
        else if (text.trim()) this.interim.set(i, text);
      }
    };
    r.onerror = (event: any) => {
      const code = String(event?.error ?? '');
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'language-not-supported') {
        this.disabled = true;
        this.hooks.onError(`Live transcript is off: this browser blocked speech recognition (${code}). The interview continues normally.`);
      }
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.emitPending();
      this.rec = undefined;
      // Chrome ends sessions after silence or a network hiccup; restart, slowing down if it keeps ending at once.
      this.quickEnds = !this.stopping && performance.now() - this.startedAt < 1500 ? this.quickEnds + 1 : 0;
      this.stopping = false;
      const delay = this.quickEnds >= 5 ? 5000 : 300;
      if (this.wanted && !this.disabled) this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.begin(); }, delay);
      this.hooks.onChange?.();
    };
    try { r.start(); } catch { this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.begin(); }, 2000); return; }
    this.rec = r; this.startedAt = performance.now(); this.lastResultAt = 0;
    this.hooks.onChange?.();
  }

  /** Sends queued phrases; phrase ids make a retried batch harmless. */
  async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    const batch = this.queue.slice(0, 20);
    try {
      await this.send(batch);
      this.queue.splice(0, batch.length);
    } catch { /* kept in the queue for the next flush */ }
    finally { this.sending = false; }
  }
}

function phraseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `p-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
