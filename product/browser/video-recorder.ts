/** Synchronized visual context for the reviewer. Records the candidate's camera as short,
 * independently decodable clips (one MediaRecorder run per clip, so every upload is a complete
 * WebM/MP4 file — never a fragment) and stamps each with session-clock capture times.
 * Clips are visual context only; they are never used as detection evidence.
 * Server side keeps a bounded rolling buffer plus any clip near a flagged or pending interval. */
import { api, type Auth, type SessionClock } from './api.js';

export interface VideoRecorderOptions {
  /** Clip length; short clips bound loss on disconnect and keep the server buffer granular. */
  clipMs?: number;
  /** Target bitrate for the low-resolution context stream. */
  videoBitsPerSecond?: number;
  onError?: (message: string) => void;
  onUploaded?: (info: { startMs: number; endMs: number; bytes: number }) => void;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const type of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']) if (MediaRecorder.isTypeSupported(type)) return type;
  return undefined;
}

export class VideoContextRecorder {
  private recorder?: MediaRecorder;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private uploads: Promise<void> = Promise.resolve();
  readonly mimeType = pickMimeType();
  pending = 0;
  failed = 0;

  constructor(private readonly auth: Auth, private readonly sessionId: string, private readonly clock: SessionClock,
    readonly track: MediaStreamTrack, private readonly options: VideoRecorderOptions = {}) {}

  get supported(): boolean { return Boolean(this.mimeType); }
  get running(): boolean { return !this.stopped; }

  start(): void {
    if (!this.supported) { this.options.onError?.('This browser cannot record video clips; thumbnails remain the only visual context.'); return; }
    if (!this.stopped) return;
    this.stopped = false;
    this.cycle();
  }

  /** Stops after the current clip is finalized and uploaded (the final clip is kept, not dropped). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    await new Promise(r => setTimeout(r, 0));
    await this.uploads;
  }

  private cycle(): void {
    if (this.stopped || this.track.readyState !== 'live') return;
    const stream = new MediaStream([this.track]);
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { mimeType: this.mimeType, videoBitsPerSecond: this.options.videoBitsPerSecond ?? 250_000 }); }
    catch (error) { this.stopped = true; this.options.onError?.(`Video recorder unavailable: ${(error as Error).message}`); return; }
    this.recorder = recorder;
    const chunks: Blob[] = [];
    let startMs = 0;
    recorder.onstart = () => { startMs = this.clock.now(); };
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => this.options.onError?.('Video recording error; visual context has a gap.');
    recorder.onstop = () => {
      const endMs = this.clock.now();
      // Start the next clip immediately so consecutive clips abut on the session clock.
      if (!this.stopped) this.cycle();
      const blob = new Blob(chunks, { type: (this.mimeType ?? 'video/webm').split(';')[0] });
      if (blob.size && endMs - startMs >= 500) this.enqueue(blob, startMs, endMs);
    };
    recorder.start();
    this.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, this.options.clipMs ?? 5000);
  }

  private enqueue(blob: Blob, startMs: number, endMs: number): void {
    this.pending++;
    this.uploads = this.uploads.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.video(this.auth, this.sessionId, blob, Math.max(0, startMs), endMs);
          this.options.onUploaded?.({ startMs, endMs, bytes: blob.size });
          return;
        } catch (error) {
          const status = (error as { status?: number }).status ?? 0;
          if (status >= 400 && status < 500) break; // consent/state/format errors will not succeed on retry
          await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      this.failed++;
      this.options.onError?.('A video context clip could not be uploaded; the reviewer will see a gap.');
    }).finally(() => { this.pending--; });
  }
}
