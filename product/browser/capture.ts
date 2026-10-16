/** Candidate-only microphone (and optional camera) capture. Every PCM chunk is mapped to the shared
 * session clock from its absolute AudioContext frame index, so capture time never depends on message
 * or upload timing. A "segment" is one continuous anchor: callers start a new segment (and a new
 * PcmWindowAssembler) after every pause, mute, context suspension or reconnect. */
import type { SessionClock } from './api.js';

export interface CaptureCallbacks {
  /** Mono PCM at `sampleRate`, `startMs` = session time of the first sample. */
  onChunk?: (samples: Float32Array, startMs: number) => void;
  /** Capture stopped delivering real audio (track muted/ended, context suspended). */
  onInterrupted?: (reason: string) => void;
  /** Audio is flowing again after `onInterrupted` (not called after `ended`; reopen instead). */
  onResumed?: (reason: string) => void;
}

// ---------------------------------------------------------------- permissions
/** Longest we wait for the candidate to answer the browser's permission prompt. */
export const PERMISSION_TIMEOUT_MS = 40_000;
export type CaptureProblemKind = 'denied' | 'dismissed' | 'blocked' | 'no_device' | 'in_use' | 'insecure' | 'unsupported' | 'timeout' | 'unknown';
export type CaptureDevice = 'microphone' | 'camera';

export class CaptureError extends Error {
  constructor(readonly kind: CaptureProblemKind, readonly device: CaptureDevice, message: string) { super(message); this.name = 'CaptureError'; }
}

/** 'granted' | 'denied' | 'prompt', or 'unknown' where the Permissions API cannot tell (e.g. Firefox, Safari). */
export async function permissionState(device: CaptureDevice): Promise<PermissionState | 'unknown'> {
  try { return (await navigator.permissions.query({ name: device as PermissionName })).state; } catch { return 'unknown'; }
}

function browserName(): 'chrome' | 'edge' | 'firefox' | 'safari' | 'other' {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** Plain-language explanation plus steps the candidate can follow to fix it. */
export function describeCaptureProblem(error: CaptureError): { title: string; message: string; steps: string[] } {
  const d = error.device, Device = d === 'microphone' ? 'Microphone' : 'Camera';
  const siteSettings: Record<ReturnType<typeof browserName>, string> = {
    chrome: `Click the icon at the left of the address bar (a lock or "tune" icon), set ${Device} to "Allow", then press "Try again".`,
    edge: `Click the lock icon at the left of the address bar, choose "Permissions for this site", set ${Device} to "Allow", then press "Try again".`,
    firefox: `Click the ${d} icon (crossed out) at the left of the address bar, remove the "Blocked" permission, then press "Try again" and choose "Allow".`,
    safari: `Open Safari › Settings for This Website (or Settings › Websites › ${Device}), set this site to "Allow", then press "Try again".`,
    other: `Open this site's permissions in your browser settings, allow the ${d}, then press "Try again".`,
  };
  const system = `If it is still blocked, check your computer's privacy settings (macOS: System Settings › Privacy & Security › ${Device}; Windows: Settings › Privacy › ${Device}) and allow your browser.`;
  switch (error.kind) {
    case 'denied': return { title: `${Device} access was not allowed`, message: `The interview needs your ${d}. Access was refused when the browser asked.`, steps: [`Press "Try again" and choose "Allow" when your browser asks.`, siteSettings[browserName()], system] };
    case 'dismissed': return { title: `The ${d} request was closed`, message: `The browser's permission prompt was closed without an answer.`, steps: [`Press "Try again" and choose "Allow" in the prompt near the address bar.`] };
    case 'blocked': return { title: `${Device} is blocked for this site`, message: `Your browser is set to block the ${d} here, so it will not ask again until you change the setting.`, steps: [siteSettings[browserName()], system] };
    case 'no_device': return { title: `No ${d} found`, message: `Your browser could not find a ${d}.`, steps: [`Connect a ${d} (or headset) and make sure it is switched on.`, `If you use an external device, select it as the default in your system sound/camera settings.`, `Then press "Try again".`] };
    case 'in_use': return { title: `The ${d} is busy`, message: `Another app or browser tab is using the ${d}, or the device stopped responding.`, steps: [`Close other apps that may use it (video calls, recorders) and other tabs with this interview.`, `Unplug and reconnect the device if it is external.`, `Then press "Try again".`] };
    case 'insecure': return { title: 'This page is not secure', message: 'Browsers only allow the microphone and camera on secure (https://) pages.', steps: ['Open the interview link exactly as you received it, starting with https://.', 'If the problem continues, ask your interviewer for a new link.'] };
    case 'unsupported': return { title: 'This browser cannot record', message: `This browser does not support ${d} access for web pages.`, steps: ['Open the interview link in a current version of Chrome, Edge, Firefox or Safari.'] };
    case 'timeout': return { title: `No answer to the ${d} request`, message: `We waited ${PERMISSION_TIMEOUT_MS / 1000} seconds for the browser's permission prompt without an answer.`, steps: [`Look for the permission prompt near the address bar (it may be hidden behind another window).`, `Press "Try again" and choose "Allow".`, siteSettings[browserName()]] };
    default: return { title: `The ${d} could not start`, message: error.message || `An unexpected error stopped the ${d}.`, steps: ['Press "Try again".', 'If it keeps failing, reload this page or try another browser.'] };
  }
}

function classify(error: unknown, device: CaptureDevice, state: PermissionState | 'unknown'): CaptureError {
  if (error instanceof CaptureError) return error;
  const name = (error as { name?: string })?.name ?? '', text = (error as Error)?.message ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    if (/dismiss/i.test(text)) return new CaptureError('dismissed', device, text);
    return new CaptureError(state === 'denied' ? 'blocked' : 'denied', device, text);
  }
  if (name === 'SecurityError') return new CaptureError('blocked', device, text);
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return new CaptureError('no_device', device, text);
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return new CaptureError('in_use', device, text);
  return new CaptureError('unknown', device, text || name);
}

/** getUserMedia with a bounded wait for the permission prompt and a classified error. If the prompt is
 * answered after the timeout, the late stream is released immediately. */
export async function requestMedia(constraints: MediaStreamConstraints, device: CaptureDevice): Promise<MediaStream> {
  if (!window.isSecureContext) throw new CaptureError('insecure', device, 'Insecure context');
  if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError('unsupported', device, 'getUserMedia unavailable');
  let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
  const request = navigator.mediaDevices.getUserMedia(constraints);
  request.then((stream) => { if (settled) stream.getTracks().forEach((t) => t.stop()); }, () => undefined);
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CaptureError('timeout', device, 'Permission prompt not answered')), PERMISSION_TIMEOUT_MS); });
  try { return await Promise.race([request, timeout]); }
  catch (error) { throw classify(error, device, error instanceof CaptureError ? 'unknown' : await permissionState(device)); }
  finally { settled = true; if (timer) clearTimeout(timer); }
}

export class CandidateCapture {
  readonly sampleRate: number;
  /** Smoothed RMS of recent audio, 0..1 linear. */
  level = 0;
  /** True once the microphone track has ended; this instance cannot recover. */
  ended = false;
  muted = false;
  cameraError?: string;
  /** Classified camera failure (audio continues without it). */
  cameraProblem?: CaptureError;
  private anchorFrame = 0;
  private anchorSessionMs = 0;
  private stopped = false;
  private suspendedByContext = false;

  private constructor(
    readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly clock: SessionClock,
    readonly callbacks: CaptureCallbacks,
  ) {
    this.sampleRate = Math.round(ctx.sampleRate);
    node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; startFrame: number }>) => this.receive(event.data);
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      audio.addEventListener('ended', () => this.trackEnded('Microphone disconnected'));
      audio.addEventListener('mute', () => { if (!this.muted) { this.muted = true; this.callbacks.onInterrupted?.('Microphone muted or taken by another app'); } });
      audio.addEventListener('unmute', () => { if (this.muted) { this.muted = false; this.reanchor(); this.callbacks.onResumed?.('Microphone unmuted'); } });
      this.muted = audio.muted;
    }
    ctx.addEventListener('statechange', () => {
      if (this.stopped) return;
      if (ctx.state === 'running' && this.suspendedByContext) {
        this.suspendedByContext = false; this.reanchor(); this.callbacks.onResumed?.('Audio resumed');
      } else if (ctx.state !== 'running' && !this.suspendedByContext) {
        this.suspendedByContext = true; this.callbacks.onInterrupted?.(`Audio context ${ctx.state}`);
      }
    });
  }

  /** Requests the microphone (and camera when consented). Camera failure falls back to audio-only.
   * Throws CaptureError (classified, with a 40 s cap on the permission prompt) when the microphone fails. */
  static async open(clock: SessionClock, options: { video: boolean }, callbacks: CaptureCallbacks = {}): Promise<CandidateCapture> {
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    let stream: MediaStream, cameraProblem: CaptureError | undefined;
    if (options.video) {
      try { stream = await requestMedia({ audio, video: { width: { ideal: 640 }, height: { ideal: 480 } } }, 'camera'); }
      catch (error) {
        // An unanswered prompt is not retried (the total wait stays within PERMISSION_TIMEOUT_MS).
        if (error instanceof CaptureError && error.kind === 'timeout') throw new CaptureError('timeout', 'microphone', error.message);
        // Tell microphone problems apart from camera-only problems by asking for audio alone.
        stream = await requestMedia({ audio }, 'microphone');
        cameraProblem = error instanceof CaptureError ? error : new CaptureError('unknown', 'camera', String(error));
      }
    } else {
      stream = await requestMedia({ audio }, 'microphone');
    }
    const cameraError = cameraProblem ? `${describeCaptureProblem(cameraProblem).title} — continuing with audio only.` : undefined;
    let ctx: AudioContext | undefined;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });   // device rate: no resampling before encodeWav
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      const sink = ctx.createGain(); sink.gain.value = 0;      // keeps the graph pulled without audible output
      source.connect(node); node.connect(sink); sink.connect(ctx.destination);
      const capture = new CandidateCapture(stream, ctx, node, source, clock, callbacks);
      capture.cameraError = cameraError; capture.cameraProblem = cameraProblem;
      await capture.resume();
      return capture;
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      await ctx?.close().catch(() => undefined);
      throw error;
    }
  }

  get running(): boolean { return !this.stopped && !this.ended && this.ctx.state === 'running'; }
  /** Audio is real and flowing (not muted, ended or suspended). */
  get healthy(): boolean { return this.running && !this.muted; }
  get videoTrack(): MediaStreamTrack | undefined { return this.stream.getVideoTracks()[0]; }

  /** Resumes a suspended context (needs a user gesture on some browsers) and re-anchors. */
  async resume(): Promise<boolean> {
    if (this.ctx.state !== 'running') await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    if (this.ctx.state === 'running') { this.suspendedByContext = false; this.reanchor(); }
    return this.ctx.state === 'running';
  }

  /** Starts a new capture segment: fresh frame↔session-time anchor. Call before each new assembler. */
  reanchor(): void {
    const stamp = this.ctx.getOutputTimestamp?.();
    let contextSec: number, perfMs: number;
    if (stamp && stamp.contextTime && stamp.performanceTime) { contextSec = stamp.contextTime; perfMs = stamp.performanceTime; }
    else { contextSec = this.ctx.currentTime; perfMs = performance.now(); }
    this.anchorFrame = contextSec * this.ctx.sampleRate;
    this.anchorSessionMs = this.clock.now(perfMs) - (this.ctx.baseLatency || 0) * 1000;
  }

  /** Session ms of an absolute context frame index, under the current anchor. */
  sessionMsAt(frame: number): number {
    return this.anchorSessionMs + (frame - this.anchorFrame) / this.ctx.sampleRate * 1000;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.node.port.onmessage = null;
    try { this.source.disconnect(); this.node.disconnect(); } catch { /* already disconnected */ }
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => undefined);
  }

  private receive(data: { samples: Float32Array; startFrame: number }): void {
    if (this.stopped || !data?.samples?.length) return;
    const { samples } = data;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sum / samples.length);
    this.level = Math.max(rms, this.level * 0.8);
    if (this.muted || this.ended) return;
    const startMs = this.sessionMsAt(data.startFrame);
    if (startMs < 0) return;   // audio from before the session clock origin cannot be placed
    this.callbacks.onChunk?.(samples, startMs);
  }

  private trackEnded(reason: string): void {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.callbacks.onInterrupted?.(reason);
  }
}

/** Meter fill 0..1 from linear RMS on a -60..0 dBFS scale. */
export function meterFraction(rms: number): number {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}
