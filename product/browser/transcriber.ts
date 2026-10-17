/** Live transcript on the candidate's device (Chrome speech recognition). Each final phrase is
 * stamped on the session clock and sent in small batches; the server colours phrases using the
 * voice grouping and DetectifAI results at the same time. Chrome runs one recogniser at a time, so
 * the page turns this off while a challenge phrase is being recorded. */
import { api, type Auth, type SessionClock } from './api.js';

export interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort?(): void;
}
export const SpeechRecognitionCtor: (new () => SpeechRecognitionLike) | undefined =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

type Phrase = { id: string; startMs: number; endMs: number; text: string };
/** Recognition reports a phrase a little after speech starts; pull the start back by this much. */
const LEAD_MS = 700;
const FLUSH_MS = 3000;

export class LiveTranscriber {
  private rec: SpeechRecognitionLike | undefined;
  private wanted = false;
  private disabled = false;
  private starts = new Map<number, number>();
  private queue: Phrase[] = [];
  private sending = false;
  private quickEnds = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  readonly flushTimer: ReturnType<typeof setInterval>;
  phrases = 0;

  constructor(private readonly auth: Auth, private readonly sessionId: string, private readonly clock: SessionClock,
    private readonly hooks: { onError: (text: string) => void; onChange?: () => void }) {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  get active(): boolean { return !!this.rec; }
  get unavailable(): boolean { return this.disabled || !SpeechRecognitionCtor; }

  /** Turn recognition on or off; restarts by itself when Chrome ends a session. */
  set(wanted: boolean): void {
    this.wanted = wanted;
    if (wanted && !this.rec && !this.restartTimer) this.begin();
    if (!wanted) {
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
      const r = this.rec; this.rec = undefined;
      if (r) { r.onend = null; r.onresult = null; r.onerror = null; try { (r.abort ?? r.stop).call(r); } catch { /* already stopped */ } this.hooks.onChange?.(); }
    }
  }

  private begin(): void {
    if (this.disabled || !SpeechRecognitionCtor || !this.wanted) return;
    let r: SpeechRecognitionLike;
    try { r = new SpeechRecognitionCtor(); } catch { this.disabled = true; return; }
    const lang = navigator.language ?? 'en-US';
    r.lang = /^en\b/i.test(lang) ? lang : 'en-US';
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    this.starts.clear();
    r.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!this.starts.has(i)) this.starts.set(i, Math.max(0, this.clock.now() - LEAD_MS));
        if (!result?.isFinal || !result[0]) continue;
        const text = String(result[0].transcript).replace(/\s+/g, ' ').trim();
        const endMs = Math.round(this.clock.now());
        if (text) {
          this.queue.push({ id: phraseId(), startMs: Math.round(Math.min(this.starts.get(i)!, endMs)), endMs, text: text.slice(0, 500) });
          if (this.queue.length > 300) this.queue.splice(0, this.queue.length - 300);
          this.phrases++;
        }
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
      this.rec = undefined;
      // Chrome ends sessions after silence or a network hiccup; restart, slowing down if it keeps ending at once.
      this.quickEnds = performance.now() - this.startedAt < 1500 ? this.quickEnds + 1 : 0;
      const delay = this.quickEnds >= 5 ? 5000 : 300;
      if (this.wanted && !this.disabled) this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.begin(); }, delay);
      this.hooks.onChange?.();
    };
    try { r.start(); } catch { this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.begin(); }, 2000); return; }
    this.rec = r; this.startedAt = performance.now();
    this.hooks.onChange?.();
  }

  /** Sends queued phrases; phrase ids make a retried batch harmless. */
  async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    const batch = this.queue.slice(0, 20);
    try {
      await api.transcript(this.auth, this.sessionId, batch);
      this.queue.splice(0, batch.length);
    } catch { /* kept in the queue for the next flush */ }
    finally { this.sending = false; }
  }
}

function phraseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `p-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
