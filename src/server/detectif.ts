import { randomUUID } from 'node:crypto';
import type { AudioWindow, AuthenticityResult, CheckError, ProviderMeta, SpeakerResult, WindowResult } from '../shared/contracts.js';

type Json = Record<string, any>;
export function object(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
export interface ProviderResponse { status: number; body: Json; requestId?: string; attempts: number; idempotencyKey?: string; submittedAtEpochMs: number; respondedAtEpochMs: number }
export class PipelineError extends Error { constructor(public code: string, message: string, public status = 503) { super(message); } }
export class BoundedQueue {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(readonly concurrency = 2, readonly maxWaiting = 8) {}
  get stats() { return { active: this.active, waiting: this.waiting.length, concurrency: this.concurrency, maxWaiting: this.maxWaiting }; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new PipelineError('queue_full', 'Analysis queue is full; this interval was not checked', 429);
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await operation(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
export function retryDelay(header: string | null, attempt: number, now = Date.now()): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header); if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 500 * 2 ** attempt;
}
export class DetectifClient {
  readonly queue = new BoundedQueue(2, 8);
  constructor(private readonly token: string | undefined, private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly baseUrl = 'https://platform.detectif.ai/v1') {}
  get configured() { return Boolean(this.token); }
  async request(path: string, method: string, body?: FormData, key?: string, anonymous = false): Promise<ProviderResponse> {
    if (!anonymous && !this.token) throw new PipelineError('credentials_missing', 'Set DETECTIF_API_TOKEN on the server; no live check ran');
    return this.queue.run(async () => {
      const submittedAtEpochMs = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response;
        try {
          response = await this.fetcher(`${this.baseUrl}${path}`, { method, body,
            headers: { ...(!anonymous ? { Authorization: `Bearer ${this.token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, signal: AbortSignal.timeout(90_000) });
        } catch {
          if (attempt < 2) { await this.sleep(retryDelay(null, attempt)); continue; }
          throw new PipelineError('provider_unreachable', 'Detectif request timed out or could not connect; outcome may be unknown. Retry the same logical operation only.');
        }
        const raw = await response.text();
        let parsed: Json;
        try { parsed = object(JSON.parse(raw)); } catch { parsed = { error: { code: 'invalid_provider_response', message: 'Provider returned a non-JSON response' } }; }
        const delay = retryDelay(response.headers.get('retry-after'), attempt);
        // Never shorten a provider Retry-After to fit our budget: stop and expose the error.
        if ([429, 500, 502, 503, 504].includes(response.status) && !parsed.partial && attempt < 2 && delay <= 30_000) { await this.sleep(delay); continue; }
        return { status: response.status, body: parsed, requestId: response.headers.get('x-request-id') ?? parsed.request_id,
          attempts: attempt + 1, idempotencyKey: key, submittedAtEpochMs, respondedAtEpochMs: Date.now() };
      }
      throw new PipelineError('retry_exhausted', 'Retry budget exhausted');
    });
  }
  enroll(speakerId: string, audio: Uint8Array, key: string = randomUUID()) { return this.request('/speakers/enroll', 'POST', this.form(speakerId, audio), key); }
  verify(speakerId: string, audio: Uint8Array, key: string = randomUUID()) { const form = this.form(speakerId, audio); form.append('detect_deepfake', 'true'); return this.request('/speakers/verify', 'POST', form, key); }
  /** Job 3 can use this before enrollment; not automatically invoked by the dev harness. */
  detect(audio: Uint8Array, key: string = randomUUID()) { const form = new FormData(); form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'candidate.wav'); return this.request('/deepfake/detect','POST',form,key); }
  deleteSpeaker(speakerId: string) { return this.request(`/speakers/${encodeURIComponent(speakerId)}`, 'DELETE'); }
  health() { return this.request('/health', 'GET', undefined, undefined, true); }
  credits() { return this.request('/credits', 'GET'); }
  private form(speakerId: string, audio: Uint8Array) { const form = new FormData(); form.append('speaker_id', speakerId); form.append('file', new Blob([new Uint8Array(audio)], {type:'audio/wav'}), 'candidate.wav'); return form; }
}
export function providerMeta(body: Json, fallback?: string): ProviderMeta {
  const model = object(body.model);
  return { requestId: typeof body.request_id === 'string' ? body.request_id : fallback,
    operationId: typeof body.operation_id === 'string' ? body.operation_id : undefined,
    model: typeof model.name === 'string' && typeof model.version === 'string' ? { name: model.name, version: model.version } : undefined,
    credits: body.credits ?? (body.credits_charged !== undefined ? {charged:body.credits_charged} : undefined), latencyMs: body.latency_ms, configVersion: body.config_version };
}
const qualityCodes = new Set(['audio_too_short','audio_too_long','insufficient_speech','silent_audio','corrupt_audio','unsupported_format']);
function failure(value: unknown, status: number, meta: ProviderMeta): Exclude<SpeakerResult, {status:'complete'}> {
  const error = object(value); const code = typeof error.code === 'string' ? error.code : 'missing_check';
  return { status: qualityCodes.has(code) ? 'inconclusive' : code === 'missing_check' ? 'missing' : 'failed',
    error: { code, message: typeof error.message === 'string' ? error.message : 'The provider did not return this check', httpStatus: status }, provider: meta };
}
export function normalizeCombined(response: ProviderResponse, window: AudioWindow, receivedAtMs: number): WindowResult {
  const body = response.body, result = object(body.result), meta = providerMeta(body, response.requestId);
  let speaker: SpeakerResult = failure(body.error, response.status, meta);
  if ((result.decision === 'match' || result.decision === 'no_match') && Number.isFinite(result.similarity) && result.similarity >= -1 && result.similarity <= 1 && Number.isFinite(result.threshold)) {
    speaker = {status:'complete',decision:result.decision,similarity:result.similarity,threshold:result.threshold,provider:meta};
  }
  // Docs expose `deepfake` on successful verify and `partial` when verification failed.
  // Preserve raw data; support a partial embedded result or a full deepfake result envelope.
  const partial = object(body.partial);
  const deepfake = object(body.deepfake ?? partial.deepfake ?? body.partial);
  const value = Object.keys(object(deepfake.result)).length ? object(deepfake.result) : deepfake;
  const deepMeta = { ...providerMeta(deepfake, response.requestId), configVersion: value.config_version };
  let authenticity: AuthenticityResult = failure(deepfake.error ?? body.error, response.status, deepMeta);
  if (['real','fake','not_sure'].includes(value.verdict)) {
    const segments = (Array.isArray(value.segments) ? value.segments : []).flatMap((segment: unknown) => {
      const s = object(segment);
      if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || !Number.isFinite(s.score) || s.end <= s.start || s.score < 0 || s.score > 1) return [];
      const startMs = Math.max(window.startMs, window.startMs + window.mediaOffsetMs + s.start * 1000);
      const endMs = Math.min(window.endMs, window.startMs + window.mediaOffsetMs + s.end * 1000);
      return endMs > startMs ? [{ startMs, endMs, score: s.score, stage: 'first_stage_supporting_only' as const }] : [];
    });
    authenticity = {status:'complete',verdict:value.verdict,segments,provider:deepMeta};
  }
  return {windowId:window.id,referenceId:window.referenceId,receivedAtMs,speaker,authenticity,provenance:'detectif_live',raw:response};
}
export function failedResult(window: AudioWindow, atMs: number, error: unknown): WindowResult {
  const e: CheckError = error instanceof PipelineError ? {code:error.code,message:error.message,httpStatus:error.status} : {code:'pipeline_error',message:'Unexpected pipeline failure'};
  return {windowId:window.id,referenceId:window.referenceId,receivedAtMs:atMs,provenance:'detectif_live',raw:{error:e},speaker:{status:'failed',error:e,provider:{}},authenticity:{status:'failed',error:e,provider:{}}};
}
