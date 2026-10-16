/** Product service for Jobs 3–8. Reuses the foundation verbatim: DetectifClient + normalizeCombined
 * (src/server/detectif.ts), the decision engine (src/shared/decision.ts) and WAV validation
 * (src/media/wav.ts). It never computes its own detection outcome. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DetectifClient, PipelineError, failedResult, normalizeCombined, object, providerMeta } from '../../src/server/detectif.js';
import { addWindow, applyResult, createSession, decide } from '../../src/shared/decision.js';
import { encodeWav, inspectWav } from '../../src/media/wav.js';
import { assignSpeakers, type SpeakerCluster, type VoiceProfile } from './voice-analysis.js';
import { VoicePool, type AnalyseResult } from './voice-pool.js';
import { analyse, buildProfile, wavTo16k } from './voice-analysis.js';
import { StoreConflict, strongEtag, type SharedStore } from './store.js';

/** Voice analysis runner: a worker thread on a long-running server, inline on serverless functions. */
export interface VoiceRunner {
  profile(wav: Uint8Array, sampleRate: number): Promise<VoiceProfile | null>;
  analyse(wavs: Array<{ wav: Uint8Array; sampleRate: number; tailSec?: number }>, profile: VoiceProfile): Promise<AnalyseResult>;
  readonly state: string; readonly queued: number; readonly restarts: number; readonly lastError?: string;
  close(): Promise<void>;
}
class InlineVoice implements VoiceRunner {
  state = 'inline'; queued = 0; restarts = 0; lastError?: string;
  async profile(wav: Uint8Array, sampleRate: number) { return buildProfile(wavTo16k(wav, sampleRate)) ?? null; }
  async analyse(wavs: Array<{ wav: Uint8Array; sampleRate: number; tailSec?: number }>, profile: VoiceProfile): Promise<AnalyseResult> {
    const parts = wavs.map(({ wav, sampleRate, tailSec }) => { const x = wavTo16k(wav, sampleRate); return tailSec ? x.subarray(Math.max(0, x.length - Math.round(tailSec * 16_000))) : x; });
    const buffer = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let k = 0; for (const p of parts) { buffer.set(p, k); k += p.length; }
    const r = analyse(buffer, profile);
    return { signals: r.signals, slices: r.slices, prefixSec: parts.length > 1 ? parts[0]!.length / 16_000 : 0, buffer };
  }
  async close() { /* nothing to stop */ }
}
interface MutationScope { after: Array<() => void>; uploads: Array<Promise<unknown>> }
import { ContextBuffer } from '../../src/media/context-buffer.js';
import type {
  AudioWindow, CaptureInterruption, CheckError, Decision, Interval, InterviewSession, Question, ReviewerResolution,
  VerificationChallenge, WindowResult,
} from '../../src/shared/contracts.js';
import { comparePhrase, generatePhrase } from './phrase.js';

export const QUESTIONS: Question[] = [
  { id: 'q1', text: 'Please introduce yourself and describe your current or most recent role.' },
  { id: 'q2', text: 'Describe a technical problem you solved recently. How did you approach it?' },
  { id: 'q3', text: 'Tell us about a time you disagreed with a teammate. What happened, and what did you learn?' },
  { id: 'q4', text: 'How would you design a service to cope with a sudden tenfold increase in traffic?' },
  { id: 'q5', text: 'What would you want to learn in your first three months in this role?' },
];

export type Status = 'consent' | 'enrollment' | 'ready' | 'live' | 'paused' | 'ended';
export type Kind = 'interview' | 'sandbox';
export interface Consent { voiceAnalysis: boolean; camera: boolean; retention: boolean; atMs: number }
export interface SandboxMeta { scenario: string; label: string; notes?: string; switchOnsetSec?: number }
export interface EnrollmentAttempt {
  id: string; atMs: number; durationMs: number; localVoicedSec: number;
  authenticity?: { status: 'complete' | 'failed' | 'missing' | 'inconclusive'; verdict?: 'real' | 'fake' | 'not_sure'; error?: CheckError };
  enrolled: boolean; reason: string; mediaName?: string;
}
interface MediaEntry {
  name: string; kind: 'window' | 'enrollment' | 'thumbnail' | 'challenge' | 'video' | 'gesture'; createdAtEpochMs: number; atMs: number;
  /** Video clips only: end of the captured interval (session ms). */
  endMs?: number;
  windowId?: string; purgedAtEpochMs?: number; purgeReason?: 'retention' | 'thumbnail_limit' | 'video_buffer';
}
/** A re-evaluation request. Each new voice response is a new version (its own one-use phrase
 * challenge → reverify window → evaluation). Status is derived from the latest version, never stored. */
export interface ReviewRequest {
  id: string; createdAtMs: number; requestedBy: 'candidate' | 'reviewer'; requesterName?: string; reason: string; evidenceId?: string;
  versions: Array<{ version: number; challengeId: string; issuedAtMs: number }>;
  outcome?: { outcome: 'reviewed' | 'escalated'; notes: string; reviewerId: string; atMs: number };
}
export type ReviewRequestStatus = 'awaiting_response' | 'expired' | 'response_submitted' | 'evaluated' | 'reviewed' | 'escalated';
export type JoinStatus = 'waiting_for_candidate' | 'ready_to_join' | 'in_progress' | 'completed' | 'not_applicable';
const MAX_VERSIONS = 3, MAX_REQUESTS = 10, PRESENCE_MS = 15_000;
export interface VoiceSignalRecord {
  id: string; kind: 'speaker_change_suspected' | 'multiple_voices_suspected'; startMs: number; endMs: number;
  strength: number; detail: string; windowIds: string[]; atMs: number;
  /** The targeted DetectifAI check of just this stretch, or why none ran. */
  targetedWindowId?: string; targetedSkipped?: string;
}
export type GestureName = 'thumbs_up' | 'thumbs_down' | 'raise_right_hand' | 'raise_left_hand' | 'point_one_finger' | 'wave_hello';
export const GESTURES: Record<GestureName, string> = {
  thumbs_up: 'Thumbs up', thumbs_down: 'Thumbs down', raise_right_hand: 'Raise your right hand', raise_left_hand: 'Raise your left hand',
  point_one_finger: 'Point one finger up', wave_hello: 'Wave hello',
};
export interface GestureCheck {
  id: string; gesture: GestureName; issuedAtMs: number; deadlineMs: number; requestedBy: string;
  /** Reported by the candidate's browser (MediaPipe runs there; no video is analysed on the server). */
  report?: { status: 'performed' | 'not_performed' | 'unavailable'; reportedAtMs: number; detectedAtMs?: number; confidence?: number;
    observed?: string[]; handFrames?: number; frames?: number; reason?: string; snapshot?: string };
}

interface ChallengeMeta {
  reviewRequestId?: string; version?: number;
  transcript?: string; transcriptSource: 'browser_speech_recognition' | 'none';
  phraseComparison?: { matched: boolean; matchedWords: number; totalWords: number };
  reviewerAssist?: { phraseHeard: boolean; notes: string; reviewerId: string; atMs: number };
}
export interface ProductRecord {
  version: 1; session: InterviewSession; kind: Kind; candidateKey: string; speakerId: string; status: Status;
  consent?: Consent; enrollmentAttempts: EnrollmentAttempt[]; openAnswer?: { id: string; questionId: string; startMs: number };
  media: MediaEntry[]; challengeMeta: Record<string, ChallengeMeta>; sandbox?: SandboxMeta;
  usage: { providerCalls: number; creditsCharged: number };
  /** windowId → Detectif Idempotency-Key. Deterministic, so a restart retry never double-charges. */
  windowOps: Record<string, string>;
  /** Interviewer who joined this interview (reviewer token holder), if any. */
  interviewer?: { joinedAtMs: number; reviewerId: string };
  /** Local voice profile from the accepted reference (timbre + pitch statistics; no audio). */
  voiceProfile?: VoiceProfile;
  /** Local screening signals (estimates) and the targeted DetectifAI checks they triggered. */
  voiceSignals?: VoiceSignalRecord[];
  targetedChecks?: number;
  windowMeta?: Record<string, { targetedFrom?: string[]; signalId?: string }>;
  gestureChecks?: GestureCheck[];
  /** Media entries dropped from the record after the rolling buffer removed the files. */
  mediaPruned?: number;
  /** Local voice analyses that could not run (worker busy/failed); never treated as a pass. */
  voiceScanSkipped?: number;
  /** Voices heard in this session (Person 1 = enrolled reference) and who spoke in each 0.75 s step. */
  speakerClusters?: SpeakerCluster[];
  speakerSlices?: Array<{ s: number; e: number; p: number }>;   // p = person, 0 = several at once
  reviewRequests?: ReviewRequest[];
  /** Completed client logical operations (X-Operation-Id) → payload hash + stored response. */
  operations: Record<string, { hash: string; result: unknown }>;
}

export interface ServiceConfig {
  dataDir: string; windowMs: number; mediaRetentionHours: number; challengeTtlMs: number; maxThumbnails: number;
  /** Rolling video buffer: clips older than this behind the newest clip are deleted unless they are
   * evidence context (or may still become evidence because a check is pending). */
  videoBufferMs: number; videoContextPadMs: number;
  /** Most targeted DetectifAI checks of locally suspicious stretches per session (each costs credits). */
  maxTargetedChecks: number;
  /** Time the candidate has to perform a requested gesture. */
  gestureWindowMs: number;
  /** Session saves are batched this long (atomic tmp+rename; flushed on idle/shutdown). */
  saveDelayMs: number;
  /** Whole sessions (record, media, remote speaker) are deleted after this many days; 0 keeps them. */
  sessionRetentionDays: number;
  /** Below this last-reported credit balance, targeted voice checks are skipped (window checks continue). */
  lowCreditThreshold: number;
  /** Shared storage for multi-instance hosting (Vercel Blob). Unset = single process, local disk. */
  sharedStore?: SharedStore;
  /** Run voice analysis on the request thread (serverless) instead of a worker thread. */
  inlineVoice?: boolean;
  provenance: 'detectif_live' | 'test_fixture'; now: () => number;
}
export const defaultConfig = (dataDir: string): ServiceConfig => ({
  // Each combined check costs provider credits (100 on the free plan as of 2026-10-16), so longer
  // windows stretch a small budget; they must stay >4 s and ≤60 s for the provider.
  dataDir, windowMs: Math.min(60_000, Math.max(5_000, Number(process.env.WINDOW_MS ?? 7000) || 7000)), mediaRetentionHours: Number(process.env.MEDIA_RETENTION_HOURS ?? 24), challengeTtlMs: 120_000,
  maxThumbnails: 600, videoBufferMs: 120_000, videoContextPadMs: 5_000, provenance: 'detectif_live', now: Date.now,
  maxTargetedChecks: Math.max(0, Number(process.env.TARGETED_CHECKS ?? 8) || 0), gestureWindowMs: 30_000,
  saveDelayMs: 250, sessionRetentionDays: Number(process.env.SESSION_RETENTION_DAYS ?? 30),
  lowCreditThreshold: Number(process.env.LOW_CREDIT_THRESHOLD ?? 300),
});

export function fail(code: string, message: string, status = 400): never { throw new PipelineError(code, message, status); }
const MEDIA_NAME = /^[a-z0-9-]{1,80}\.(wav|jpg|webm|mp4)$/;
const CONTENT_TYPES: Record<string, string> = { wav: 'audio/wav', jpg: 'image/jpeg', webm: 'video/webm', mp4: 'video/mp4' };

/** Decodes canonical PCM16 WAV (validated by inspectWav) and estimates speech with a crude energy
 * gate. Used only to avoid sending obvious silence; it can only make a window *skipped*, never positive. */
export function localSpeechSeconds(bytes: Uint8Array, sampleRate: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = (bytes.byteLength - 44) / 2, frame = Math.max(1, Math.round(sampleRate * 0.03));
  const levels: number[] = [];
  for (let i = 0; i + frame <= count; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) { const s = view.getInt16(44 + j * 2, true) / 32768; sum += s * s; }
    levels.push(Math.sqrt(sum / frame));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const threshold = Math.max(0.006, (sorted[Math.floor(sorted.length * 0.1)] ?? 0) * 2.5);
  return levels.filter(l => l > threshold).length * frame / sampleRate;
}

function deepfakeOnly(status: number, body: Record<string, any>): NonNullable<EnrollmentAttempt['authenticity']> {
  const result = object(body.result);
  if (status < 300 && ['real', 'fake', 'not_sure'].includes(result.verdict)) return { status: 'complete', verdict: result.verdict };
  const error = object(body.error);
  const code = typeof error.code === 'string' ? error.code : 'missing_check';
  const quality = ['audio_too_short', 'audio_too_long', 'insufficient_speech', 'silent_audio', 'corrupt_audio', 'unsupported_format'].includes(code);
  return { status: quality ? 'inconclusive' : 'failed', error: { code, message: typeof error.message === 'string' ? error.message : 'Authenticity check did not return a verdict', httpStatus: status } };
}

export class SwitchGuardService {
  readonly records = new Map<string, ProductRecord>();
  private inflight = new Map<string, Promise<unknown>>();
  private enrolling = new Set<string>();
  private checks = new Set<Promise<void>>();
  private opsCache?: { atEpochMs: number; value: unknown };
  /** Last time each side fetched its view (epoch ms). Not persisted: presence is live-only. */
  private presence = new Map<string, { candidate?: number; reviewer?: number }>();
  /** Voice analysis runs in a worker thread so it never blocks requests (inline on serverless). */
  readonly voice: VoiceRunner;
  /** Shared store and the ETag of each cached record (multi-instance mode only). */
  readonly shared?: SharedStore;
  private etags = new Map<string, string>();
  private scope = new AsyncLocalStorage<MutationScope>();
  private dirty = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** Last storage failure (cleared by the next successful save). Reported by /api/health. */
  storageError?: string;
  /** Last credit balance DetectifAI reported (null on unlimited plans). */
  lastBalance?: number | null;
  readonly startedAtEpochMs = Date.now();

  constructor(readonly client: DetectifClient, readonly config: ServiceConfig) {
    mkdirSync(join(config.dataDir, 'sessions'), { recursive: true });
    mkdirSync(join(config.dataDir, 'media'), { recursive: true });
    this.shared = config.sharedStore;
    this.voice = config.inlineVoice ? new InlineVoice() : new VoicePool();
  }

  // ---------- shared-store consistency (multi-instance) ----------
  /** Runs `fn` after the current change is committed (immediately in single-process mode). */
  private later(fn: () => void): void { const s = this.scope.getStore(); if (s) s.after.push(fn); else fn(); }
  /** Loads the latest stored copy of a session into this instance (no-op in single-process mode). */
  async pull(id: string): Promise<ProductRecord | undefined> {
    if (!this.shared) return this.records.get(id);
    const stored = await this.shared.getRecord(id);
    if (!stored) { this.records.delete(id); this.etags.delete(id); return undefined; }
    const etag = strongEtag(stored.etag);
    if (this.etags.get(id) !== etag || !this.records.has(id)) {
      this.records.set(id, JSON.parse(stored.json) as ProductRecord); this.etags.set(id, etag);
    }
    return this.records.get(id);
  }
  /** Refreshes every session this instance knows about from the shared store (lists, sweeps). */
  async pullAll(): Promise<void> {
    if (!this.shared) return;
    const listed = await this.shared.listRecords(), ids = new Set(listed.map(r => r.id));
    for (const id of [...this.records.keys()]) if (!ids.has(id)) { this.records.delete(id); this.etags.delete(id); }
    await Promise.all(listed.filter(r => this.etags.get(r.id) !== r.etag).map(r => this.pull(r.id)));
  }
  /** Conditional write of a session (create-only for new ones). Throws StoreConflict. */
  private async commit(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!this.shared || !rec) { this.dirty.delete(id); return; }
    const etag = await this.shared.putRecord(id, JSON.stringify(rec), this.etags.get(id));
    this.etags.set(id, etag); this.dirty.delete(id); this.storageError = undefined;
  }
  /** Stores a newly created session (multi-instance mode). */
  async persistNew(id: string): Promise<void> { if (this.shared) await this.commit(id); }
  /** Applies a change to the latest copy of a session. In multi-instance mode a concurrent write by
   * another instance makes the change replay on the fresh copy, so no update is ever lost. Background
   * work started by the change runs only after it is committed. `missing: 'ignore'` is for background
   * tasks whose session may have been deleted meanwhile. */
  async mutate<T>(id: string, fn: (rec: ProductRecord) => T | Promise<T>, options: { missing?: 'fail' | 'ignore' } = {}): Promise<T | undefined> {
    if (!this.shared) {
      const rec = this.records.get(id);
      if (!rec) { if (options.missing === 'ignore') return undefined; fail('not_found', 'Session not found', 404); }
      return fn(rec);
    }
    for (let attempt = 0; ; attempt++) {
      const rec = await this.pull(id);
      if (!rec) { if (options.missing === 'ignore') return undefined; fail('not_found', 'Session not found', 404); }
      const scope: MutationScope = { after: [], uploads: [] };
      let out: T;
      try { out = await this.scope.run(scope, () => fn(rec)); }
      catch (error) { this.records.delete(id); this.etags.delete(id); this.dirty.delete(id); throw error; }   // drop partial local changes
      if (this.records.get(id) === rec && this.dirty.has(id)) {
        await Promise.all(scope.uploads);   // never reference media that is not stored yet
        try { await this.commit(id); }
        catch (error) {
          this.records.delete(id); this.etags.delete(id); this.dirty.delete(id);
          if (error instanceof StoreConflict) {
            // Jittered exponential backoff; under sustained contention give up with a retryable 503.
            if (attempt < 9) { await new Promise(r => setTimeout(r, Math.min(1500, 40 * 2 ** attempt) * (0.5 + Math.random()))); continue; }
            fail('busy', 'This session is being updated by several requests at once; retry in a moment', 503);
          }
          throw error;
        }
      }
      for (const f of scope.after) f();
      return out;
    }
  }

  // ---------- persistence ----------
  load(): void {
    for (const file of readdirSync(join(this.config.dataDir, 'sessions'))) {
      if (!file.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.config.dataDir, 'sessions', file), 'utf8')) as ProductRecord;
        if (rec.version !== 1) continue;
        this.records.set(rec.session.id, rec);
        // Windows that were pending when the server stopped are retried with the SAME idempotency key.
        for (const w of rec.session.windows) if (w.coverage === 'pending' && rec.windowOps[w.id]) this.scheduleCheck(rec.session.id, w.id);
      } catch (error) {
        const from = join(this.config.dataDir, 'sessions', file), to = `${from}.corrupt-${Date.now()}`;
        try { renameSync(from, to); } catch { /* leave it in place */ }
        console.error(`Unreadable session file ${file} moved aside to ${to}: ${(error as Error).message}`);
      }
    }
  }
  /** Marks a session for saving; writes are batched (saveDelayMs) and stay atomic. */
  private save(rec: ProductRecord): void {
    if (this.records.get(rec.session.id) !== rec) return; // deleted meanwhile
    this.dirty.add(rec.session.id);
    if (this.shared) return;                               // committed by mutate()
    if (this.config.saveDelayMs <= 0) { this.flush(); return; }
    if (!this.flushTimer) { this.flushTimer = setTimeout(() => this.flush(), this.config.saveDelayMs); this.flushTimer.unref?.(); }
  }
  /** Writes every pending session now. A failed write stays pending and is reported by health. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.shared) return;
    for (const id of [...this.dirty]) {
      const rec = this.records.get(id);
      if (!rec) { this.dirty.delete(id); continue; }
      const path = join(this.config.dataDir, 'sessions', `${id}.json`);
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify(rec)); renameSync(`${path}.tmp`, path);
        this.dirty.delete(id); this.storageError = undefined;
      } catch (error) {
        this.storageError = `Could not save session ${id}: ${(error as Error).message}`;
        console.error(this.storageError);
        if (!this.flushTimer) { this.flushTimer = setTimeout(() => this.flush(), 5_000); this.flushTimer.unref?.(); }
      }
    }
  }
  private mediaDir(id: string): string { return join(this.config.dataDir, 'media', id); }
  private writeMedia(rec: ProductRecord, entry: Omit<MediaEntry, 'createdAtEpochMs'>, bytes: Uint8Array): void {
    if (!MEDIA_NAME.test(entry.name)) fail('internal_error', 'Invalid media name', 500);
    try {
      mkdirSync(this.mediaDir(rec.session.id), { recursive: true });
      writeFileSync(join(this.mediaDir(rec.session.id), entry.name), bytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.storageError = `Could not store media (${code ?? (error as Error).message})`;
      console.error(this.storageError);
      fail(code === 'ENOSPC' || code === 'EDQUOT' ? 'storage_full' : 'storage_error', code === 'ENOSPC' || code === 'EDQUOT' ? 'The server is out of storage space; the upload was not saved' : 'The server could not store this upload', 507);
    }
    rec.media.push({ ...entry, createdAtEpochMs: this.config.now() });
    if (this.shared) {
      const upload = this.shared.putMedia(rec.session.id, entry.name, bytes, CONTENT_TYPES[entry.name.split('.').pop()!] ?? 'application/octet-stream');
      const scope = this.scope.getStore();
      if (scope) scope.uploads.push(upload); else this.track(upload.then(() => undefined));
    }
  }
  async readMedia(rec: ProductRecord, name: string): Promise<{ bytes: Buffer; contentType: string }> {
    const entry = rec.media.find(m => m.name === name);
    if (!MEDIA_NAME.test(name) || !entry || entry.purgedAtEpochMs !== undefined) fail('not_found', 'Media not found, deleted, or expired under the retention policy', 404);
    const contentType = CONTENT_TYPES[name.split('.').pop()!] ?? 'application/octet-stream';
    const path = join(this.mediaDir(rec.session.id), name);
    if (existsSync(path)) return { bytes: readFileSync(path), contentType };
    const remote = this.shared ? await this.shared.getMedia(rec.session.id, name) : undefined;
    if (!remote) fail('not_found', 'Media file is no longer stored', 404);
    return { bytes: remote, contentType };
  }
  private purge(rec: ProductRecord, entry: MediaEntry, reason: NonNullable<MediaEntry['purgeReason']>): void {
    rmSync(join(this.mediaDir(rec.session.id), entry.name), { force: true });
    entry.purgedAtEpochMs = this.config.now(); entry.purgeReason = reason;
    if (this.shared) { const sid = rec.session.id, store = this.shared; this.later(() => this.track(store.deleteMedia(sid, entry.name).catch(() => undefined))); }
  }
  /** Deletes media older than the retention window. Records of the analysis remain; the audio does not.
   * Entries already removed by the rolling video buffer or thumbnail cap are dropped from the record
   * after 10 minutes (counted in mediaPruned) so long sessions do not grow without bound. */
  sweepRetention(): number {
    let purged = 0;
    for (const rec of this.records.values()) purged += this.sweepRecord(rec);
    return purged;
  }
  private sweepRecord(rec: ProductRecord): number {
    const now = this.config.now(), cutoff = now - this.config.mediaRetentionHours * 3_600_000;
    let purged = 0, changed = false;
    for (const entry of rec.media) if (entry.purgedAtEpochMs === undefined && entry.createdAtEpochMs < cutoff) { this.purge(rec, entry, 'retention'); purged++; changed = true; }
    const before = rec.media.length;
    rec.media = rec.media.filter(m => !(m.purgedAtEpochMs !== undefined && (m.purgeReason === 'video_buffer' || m.purgeReason === 'thumbnail_limit') && now - m.purgedAtEpochMs > 600_000));
    if (rec.media.length !== before) { rec.mediaPruned = (rec.mediaPruned ?? 0) + before - rec.media.length; changed = true; }
    if (changed) this.save(rec);
    return purged;
  }
  /** Retention sweep across every stored session (cron job in multi-instance mode). */
  async sweepAll(): Promise<{ purged: number; expired: { deleted: number; failed: number } }> {
    await this.pullAll();
    let purged = 0;
    for (const id of [...this.records.keys()]) purged += (await this.mutate(id, rec => this.sweepRecord(rec), { missing: 'ignore' })) ?? 0;
    return { purged, expired: await this.expireSessions() };
  }
  /** Deletes whole sessions older than sessionRetentionDays (record, media, remote speaker profile).
   * A failed remote deletion keeps the session and is retried on the next sweep. */
  async expireSessions(): Promise<{ deleted: number; failed: number }> {
    const days = this.config.sessionRetentionDays;
    if (!(days > 0)) return { deleted: 0, failed: 0 };
    const cutoff = this.config.now() - days * 86_400_000;
    let deleted = 0, failed = 0;
    await this.pullAll();
    for (const rec of [...this.records.values()]) {
      if (rec.session.createdAtEpochMs >= cutoff) continue;
      if (rec.session.windows.some(w => w.coverage === 'pending')) continue;
      try { await this.deleteSession(rec); deleted++; }
      catch (error) { failed++; console.error(`Session ${rec.session.id} expired but could not be deleted yet: ${(error as Error).message}`); }
    }
    return { deleted, failed };
  }
  /** Storage, worker and provider state for /api/health (no secrets). */
  async health() {
    let storage: 'ok' | 'error' = 'ok', detail = this.storageError;
    try { accessSync(join(this.config.dataDir, 'sessions'), fsConstants.W_OK); accessSync(join(this.config.dataDir, 'media'), fsConstants.W_OK); }
    catch (error) { storage = 'error'; detail = `Data directory not writable: ${(error as Error).message}`; }
    if (this.shared) {
      try { await this.shared.ping(); } catch (error) { storage = 'error'; detail = `Shared store (${this.shared.name}) unreachable: ${(error as Error).message}`; }
    }
    if (this.storageError) storage = 'error';
    return { ok: storage === 'ok', storage, storageDetail: detail, pendingSaves: this.dirty.size, sessions: this.records.size,
      uptimeSec: Math.round((Date.now() - this.startedAtEpochMs) / 1000), detectifConfigured: this.client.configured, queue: this.client.queue.stats,
      voiceWorker: { state: this.voice.state, queued: this.voice.queued, restarts: this.voice.restarts, lastError: this.voice.lastError }, backgroundTasks: this.checks.size,
      store: this.shared?.name ?? 'local-disk' };
  }

  // ---------- helpers ----------
  get(id: string): ProductRecord {
    const rec = this.records.get(id);
    if (!rec) fail('not_found', 'Session not found', 404);
    return rec;
  }
  elapsed(rec: ProductRecord): number { return this.config.now() - rec.session.createdAtEpochMs; }
  /** Sandbox runs process prerecorded files faster than real time on a file-relative timeline, so
   * "now" for decision purposes is the end of the latest analysed interval rather than wall time. */
  decisionNow(rec: ProductRecord): number {
    if (rec.kind === 'sandbox') return Math.max(0, ...rec.session.windows.map(w => w.endMs)) + 1;
    return this.elapsed(rec);
  }
  private time(rec: ProductRecord, value: unknown, name: string): number {
    const max = rec.kind === 'sandbox' ? 2 * 3_600_000 : this.elapsed(rec) + 2000;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail('invalid_time', `${name} must be a finite, nonnegative capture time that is not in the future`);
    return value;
  }
  private interval(rec: ProductRecord, meta: Record<string, any>): Interval {
    const startMs = this.time(rec, meta.startMs, 'startMs'), endMs = this.time(rec, meta.endMs, 'endMs');
    if (endMs <= startMs) fail('invalid_interval', 'Capture interval must have positive duration');
    return { startMs, endMs };
  }
  private wav(audio: Uint8Array) {
    try { return inspectWav(audio); } catch (error) { return fail('invalid_audio', (error as Error).message, 422); }
  }
  private interrupt(rec: ProductRecord, kind: CaptureInterruption['kind'], reason: string, atMs = this.elapsed(rec)): void {
    if (rec.session.interruptions.length >= 2000) fail('session_limit', 'Too many capture events', 429);
    rec.session = { ...rec.session, interruptions: [...rec.session.interruptions, { atMs, kind, reason }] };
  }
  /** Same X-Operation-Id + same payload → same response; different payload → 409. Never runs twice. */
  async logical<T>(rec: ProductRecord, opId: string, payload: Uint8Array | string, operation: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(opId)) fail('invalid_operation_id', 'Provide a stable X-Operation-Id (8–128 chars) for this logical operation');
    const hash = createHash('sha256').update(payload).digest('hex');
    const done = rec.operations[opId];
    if (done) { if (done.hash !== hash) fail('operation_id_reuse', 'Operation ID was already used for different input', 409); return done.result as T; }
    const key = `${rec.session.id}:${opId}`;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    if (Object.keys(rec.operations).length >= 3000) fail('session_limit', 'Session operation limit reached', 429);
    const promise = operation().then(result => { rec.operations[opId] = { hash, result }; this.save(rec); return result; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  private countUsage(rec: ProductRecord, body: Record<string, any>): void {
    rec.usage.providerCalls++;
    const credits = object(body.credits);
    if (credits.unlimited === true || credits.balance === null) this.lastBalance = null;
    else if (typeof credits.balance === 'number' && Number.isFinite(credits.balance)) this.lastBalance = credits.balance;
    const charged = object(body.credits).charged;
    if (typeof charged === 'number' && Number.isFinite(charged)) rec.usage.creditsCharged += charged;
  }

  // ---------- sessions ----------
  createSession(input: { displayName?: unknown; kind?: unknown; sandbox?: unknown }): ProductRecord {
    if (this.records.size >= 500) fail('session_limit', 'Session limit reached; delete old sessions first', 429);
    const kind: Kind = input.kind === 'sandbox' ? 'sandbox' : 'interview';
    const id = randomBytes(12).toString('hex');
    const name = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim().slice(0, 128) : kind === 'sandbox' ? 'Sandbox sample' : 'Consenting participant';
    const session = { ...createSession(id, this.config.now(), name), questions: kind === 'interview' ? QUESTIONS.map(q => ({ ...q })) : [] };
    let sandbox: SandboxMeta | undefined;
    if (kind === 'sandbox') {
      const s = object(input.sandbox);
      const onset = Number(s.switchOnsetSec);
      sandbox = { scenario: String(s.scenario ?? 'unspecified').slice(0, 64), label: String(s.label ?? '').slice(0, 256), notes: typeof s.notes === 'string' ? s.notes.slice(0, 2000) : undefined,
        switchOnsetSec: s.switchOnsetSec !== undefined && s.switchOnsetSec !== null && s.switchOnsetSec !== '' && Number.isFinite(onset) && onset >= 0 ? onset : undefined };
    }
    const rec: ProductRecord = { version: 1, session, kind, candidateKey: randomBytes(24).toString('hex'), speakerId: `sg-${id}`, status: 'consent',
      enrollmentAttempts: [], media: [], challengeMeta: {}, sandbox, usage: { providerCalls: 0, creditsCharged: 0 }, windowOps: {}, operations: {}, reviewRequests: [] };
    this.records.set(id, rec); this.save(rec);
    return rec;
  }

  consent(rec: ProductRecord, input: Record<string, any>): void {
    if (rec.status !== 'consent' && rec.status !== 'enrollment') fail('invalid_state', 'Consent was already recorded', 409);
    if (input.voiceAnalysis !== true || input.retention !== true) fail('consent_required', 'Voice analysis and evidence retention consent are required to continue');
    if (rec.kind === 'sandbox' && input.camera === true) fail('invalid_parameter', 'Sandbox runs have no camera');
    rec.consent = { voiceAnalysis: true, camera: input.camera === true, retention: true, atMs: this.elapsed(rec) };
    rec.status = 'enrollment'; this.save(rec);
  }

  /** Job 3: authenticity precheck, then enrollment. Only a final `real` verdict admits the reference. */
  enroll(rec: ProductRecord, audio: Uint8Array, meta: Record<string, any>, opId: string): Promise<{ accepted: boolean; reason: string; attempt: EnrollmentAttempt }> {
    return this.logical(rec, opId, Buffer.concat([Buffer.from(`enroll:${JSON.stringify(meta)}:`), audio]), async () => {
      if (!rec.consent) fail('consent_required', 'Record consent before enrollment', 409);
      if (rec.session.enrollment) fail('original_reference_locked', 'This session already has its original reference; it cannot be replaced', 409);
      if (this.enrolling.has(rec.session.id)) fail('operation_pending', 'An enrollment attempt is already running', 409);
      if (rec.enrollmentAttempts.length >= 6) fail('attempt_limit', 'Too many enrollment attempts; a reviewer should start a new session', 429);
      const times = this.interval(rec, meta), wav = this.wav(audio);
      if (Math.abs((times.endMs - times.startMs) - wav.durationMs) > 25) fail('duration_mismatch', 'Capture interval differs from WAV sample duration', 422);
      const n = rec.enrollmentAttempts.length + 1;
      const attempt: EnrollmentAttempt = { id: `enroll-${n}`, atMs: this.elapsed(rec), durationMs: wav.durationMs, localVoicedSec: Math.round(localSpeechSeconds(audio, wav.sampleRate) * 10) / 10, enrolled: false, reason: '', mediaName: `enroll-${n}.wav` };
      this.writeMedia(rec, { name: attempt.mediaName!, kind: 'enrollment', atMs: times.startMs }, audio);
      this.enrolling.add(rec.session.id);
      try {
        if (wav.durationMs < 15_000 || wav.durationMs > 60_000) attempt.reason = `Recording is ${(wav.durationMs / 1000).toFixed(1)} s; enrollment needs 15–60 s with at least 10 s of clear speech.`;
        else if (attempt.localVoicedSec < 10) attempt.reason = `Only about ${attempt.localVoicedSec} s of speech was detected locally; at least 10 s of clear speech is needed. Please read the paragraph aloud again, closer to the microphone.`;
        else {
          try {
            const df = await this.client.detect(audio, `${rec.session.id}:${attempt.id}:detect`);
            this.countUsage(rec, df.body); attempt.authenticity = deepfakeOnly(df.status, df.body);
          } catch (error) {
            const e = error instanceof PipelineError ? error : new PipelineError('pipeline_error', 'Unexpected authenticity check failure', 500);
            attempt.authenticity = { status: 'failed', error: { code: e.code, message: e.message, httpStatus: e.status } };
          }
          const a = attempt.authenticity;
          if (a.status !== 'complete') attempt.reason = `The authenticity check did not complete (${a.error?.code}: ${a.error?.message}). The reference was not accepted; please retry.`;
          else if (a.verdict === 'fake') attempt.reason = 'The final authenticity verdict for this recording is synthetic speech. The reference was not accepted. A reviewer has been shown this attempt and decides how to proceed.';
          else if (a.verdict === 'not_sure') attempt.reason = 'Authenticity could not be determined for this recording. Please record again in a quieter place with clear speech.';
          else {
            try {
              const response = await this.client.enroll(rec.speakerId, audio, `${rec.session.id}:${attempt.id}:enroll`);
              this.countUsage(rec, response.body);
              const b = response.body;
              if (response.status < 300 && object(b.speaker).speaker_id === rec.speakerId) {
                rec.session = { ...rec.session, enrollment: { id: `ref-${rec.session.id}`, speakerId: rec.speakerId, participantId: rec.session.candidate.id, enrolledAtMs: this.elapsed(rec), provider: providerMeta(b, response.requestId), authenticity: 'real' } };
                attempt.enrolled = true;
                const speech = object(b.quality).speech_seconds;
                attempt.reason = `Reference accepted: final authenticity verdict real; enrolled with DetectifAI${typeof speech === 'number' ? ` (${speech.toFixed(1)} s of speech)` : ''}. This establishes voice continuity for this interview, not real-world identity.`;
                rec.status = 'ready';
                try { rec.voiceProfile = (await this.voice.profile(audio, wav.sampleRate)) ?? undefined; }
                catch (error) { console.error(`Voice profile not built for ${rec.session.id}: ${(error as Error).message}`); }
              } else {
                const e = object(b.error);
                attempt.reason = `Enrollment was not accepted by DetectifAI (${e.code ?? response.status}: ${e.message ?? 'no message'}). Please record again.`;
              }
            } catch (error) {
              const e = error instanceof PipelineError ? error : new PipelineError('pipeline_error', 'Unexpected enrollment failure', 500);
              attempt.reason = `Enrollment request failed (${e.code}: ${e.message}).`;
            }
          }
        }
      } finally { this.enrolling.delete(rec.session.id); }
      rec.enrollmentAttempts.push(attempt); this.save(rec);
      return { accepted: attempt.enrolled, reason: attempt.reason, attempt };
    });
  }

  // ---------- interview control (Job 4) ----------
  control(rec: ProductRecord, action: unknown): void {
    const now = this.elapsed(rec);
    if (action === 'start') {
      if (!rec.session.enrollment || rec.session.enrollment.deletedAtMs !== undefined) fail('enrollment_required', 'An accepted reference is required before the interview starts', 409);
      if (rec.status !== 'ready') fail('invalid_state', `Cannot start from ${rec.status}`, 409);
      rec.status = 'live';
    } else if (action === 'pause') {
      if (rec.status !== 'live') fail('invalid_state', 'Interview is not live', 409);
      rec.status = 'paused'; this.interrupt(rec, 'interrupted', 'Interview paused', now);
    } else if (action === 'resume') {
      if (rec.status !== 'paused') fail('invalid_state', 'Interview is not paused', 409);
      rec.status = 'live'; this.interrupt(rec, 'resumed', 'Interview resumed', now);
    } else if (action === 'end') {
      if (rec.status !== 'live' && rec.status !== 'paused' && rec.status !== 'ready') fail('invalid_state', `Cannot end from ${rec.status}`, 409);
      this.closeAnswer(rec, now); rec.status = 'ended'; this.interrupt(rec, 'interrupted', 'Session ended', now);
    } else fail('invalid_parameter', 'Unknown action');
    this.save(rec);
  }
  startAnswer(rec: ProductRecord, questionId: unknown): void {
    if (rec.status !== 'live') fail('invalid_state', 'Answers can only start while the interview is live', 409);
    const q = rec.session.questions.find(x => x.id === questionId);
    if (!q) fail('invalid_parameter', 'Unknown question');
    const now = this.elapsed(rec);
    this.closeAnswer(rec, now);
    rec.openAnswer = { id: `a${rec.session.answers.length + 1}-${q.id}`, questionId: q.id, startMs: now };
    this.save(rec);
  }
  endAnswer(rec: ProductRecord): void {
    if (!rec.openAnswer) fail('invalid_state', 'No answer is in progress', 409);
    this.closeAnswer(rec, this.elapsed(rec)); this.save(rec);
  }
  private closeAnswer(rec: ProductRecord, nowMs: number): void {
    const open = rec.openAnswer;
    if (!open) return;
    rec.openAnswer = undefined;
    rec.session = { ...rec.session, answers: [...rec.session.answers, { id: open.id, questionId: open.questionId, startMs: open.startMs, endMs: Math.max(open.startMs + 1, nowMs) }] };
  }
  private answerIdsFor(rec: ProductRecord, iv: Interval): string[] {
    const ids = rec.session.answers.filter(a => a.startMs < iv.endMs && a.endMs > iv.startMs).map(a => a.id);
    if (rec.openAnswer && rec.openAnswer.startMs < iv.endMs) ids.push(rec.openAnswer.id);
    return ids;
  }
  candidateInterruption(rec: ProductRecord, input: Record<string, any>): void {
    if (input.kind !== 'interrupted' && input.kind !== 'resumed') fail('invalid_kind', 'Invalid capture event');
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 256) : fail('invalid_parameter', 'reason is required');
    this.interrupt(rec, input.kind, reason, this.time(rec, input.atMs, 'atMs')); this.save(rec);
  }

  // ---------- analysis windows ----------
  submitWindow(rec: ProductRecord, audio: Uint8Array, meta: Record<string, any>, opId: string, purpose: AudioWindow['purpose'] = 'monitor', challengeId?: string) {
    return this.logical(rec, opId, Buffer.concat([Buffer.from(`window:${purpose}:${challengeId ?? ''}:${JSON.stringify(meta)}:`), audio]), async () => this.addAnalysisWindow(rec, audio, meta, purpose));
  }
  private addAnalysisWindow(rec: ProductRecord, audio: Uint8Array, meta: Record<string, any>, purpose: AudioWindow['purpose']): { windowId: string; coverage: AudioWindow['coverage']; reason?: string } {
    const reference = rec.session.enrollment;
    if (!reference || reference.deletedAtMs !== undefined) fail('enrollment_required', 'An active original reference is required before audio is checked', 409);
    if (rec.status === 'consent' || rec.status === 'enrollment' || (rec.status === 'ready' && purpose === 'monitor')) fail('invalid_state', 'The interview has not started', 409);
    const source = rec.kind === 'sandbox' ? 'labelled_upload' : 'candidate_microphone';
    if (meta.source !== undefined && meta.source !== source) fail('invalid_source', `This session only accepts ${source} audio`);
    if (rec.session.windows.length >= 1500) fail('session_limit', 'Window limit reached', 429);
    const times = this.interval(rec, meta), wav = this.wav(audio);
    if (Math.abs((times.endMs - times.startMs) - wav.durationMs) > 25) fail('duration_mismatch', 'Capture interval differs from WAV sample duration', 422);
    if (wav.durationMs > 60_000) fail('audio_too_long', 'Analysis windows must be at most 60 seconds', 422);
    const voiced = localSpeechSeconds(audio, wav.sampleRate);
    let coverage: AudioWindow['coverage'] = 'pending', reason: string | undefined;
    if (wav.durationMs <= 4000) { coverage = 'skipped'; reason = `Short fragment (${(wav.durationMs / 1000).toFixed(1)} s): combined checking needs more than 4 s, so this interval was not checked`; }
    else if (voiced < 2) { coverage = 'skipped'; reason = `Local estimate found ${voiced.toFixed(1)} s of speech (needs ≥2 s): silence or very quiet audio was not checked`; }
    const sequence = rec.session.windows.length, id = `w${sequence}`;
    const window: AudioWindow = { id, sessionId: rec.session.id, sequence, ...times, answerIds: purpose === 'monitor' ? this.answerIdsFor(rec, times) : [], source, purpose,
      referenceId: reference.id, mimeType: 'audio/wav', sampleRate: wav.sampleRate, sampleCount: wav.sampleCount, mediaOffsetMs: 0, coverage, reason,
      submittedAtMs: coverage === 'pending' ? this.elapsed(rec) : undefined };
    try { rec.session = addWindow(rec.session, window); } catch (error) { fail('invalid_window', (error as Error).message, 409); }
    this.writeMedia(rec, { name: `${id}.wav`, kind: purpose === 'reverify' ? 'challenge' : 'window', atMs: times.startMs, windowId: id }, audio);
    if (coverage === 'pending') { rec.windowOps[id] = `${rec.session.id}:${id}`; this.scheduleCheck(rec.session.id, id); }
    if (purpose === 'monitor' && rec.voiceProfile && voiced >= 2) { const sid = rec.session.id; this.later(() => this.track(this.voiceScan(sid, id))); }
    this.save(rec);
    return { windowId: id, coverage, reason };
  }
  private track(p: Promise<void>): void {
    const q = p.catch(error => console.error('background task failed', error)).finally(() => this.checks.delete(q));
    this.checks.add(q);
  }

  // ---------- local voice screening → targeted checks ----------
  /** Scans one window (joined to the tail of the previous contiguous window, so switches across a
   * boundary are seen) for stretches that do not sound like the reference, then checks exactly
   * those stretches with DetectifAI. Only DetectifAI results become evidence. */
  private async voiceScan(sessionId: string, windowId: string): Promise<void> {
    await new Promise(r => setImmediate(r));                      // let the upload response go first
    // 1. Read a snapshot and run the (slow) analysis outside any write.
    const snap = this.shared ? await this.pull(sessionId) : this.records.get(sessionId);
    const w = snap?.session.windows.find(x => x.id === windowId), profile = snap?.voiceProfile;
    if (!snap || !w || !profile) return;
    const meta = snap.windowMeta ?? {};
    let current: Uint8Array;
    try { current = new Uint8Array((await this.readMedia(snap, `${w.id}.wav`)).bytes); } catch { return; }
    const prev = snap.session.windows
      .filter(x => x.purpose === 'monitor' && x.id !== w.id && !meta[x.id]?.targetedFrom && Math.abs(w.startMs - x.endMs) <= 300)
      .sort((a, b) => b.endMs - a.endMs)[0];
    const inputs: Array<{ wav: Uint8Array; sampleRate: number; tailSec?: number }> = [];
    if (prev) { try { inputs.push({ wav: new Uint8Array((await this.readMedia(snap, `${prev.id}.wav`)).bytes), sampleRate: prev.sampleRate, tailSec: 4 }); } catch { /* previous audio purged */ } }
    inputs.push({ wav: current, sampleRate: w.sampleRate });
    let result: AnalyseResult;
    try { result = await this.voice.analyse(inputs, profile); }
    catch (error) {
      console.error(`Voice screening skipped for ${sessionId}/${w.id}: ${(error as Error).message}`);
      await this.mutate(sessionId, rec => { rec.voiceScanSkipped = (rec.voiceScanSkipped ?? 0) + 1; this.save(rec); }, { missing: 'ignore' });
      return;
    }
    // 2. Apply the outcome to the latest copy (replayed on the fresh copy if another write won).
    await this.mutate(sessionId, rec => this.applyVoiceScan(rec, windowId, prev?.id, result), { missing: 'ignore' });
  }
  private applyVoiceScan(rec: ProductRecord, windowId: string, prevId: string | undefined, result: AnalyseResult): void {
    const w = rec.session.windows.find(x => x.id === windowId), profile = rec.voiceProfile;
    if (!w || !profile) return;
    if ((rec.speakerSlices ?? []).some(sl => sl.s >= w.startMs && sl.e <= w.endMs)) return;   // already applied (replay)
    const buffer = result.buffer, bufferStartMs = w.startMs - result.prefixSec * 1000;
    // Who is speaking: label each slice of THIS window (the previous tail was labelled last time).
    const own = result.slices.filter(sl => (sl.startSec + sl.endSec) / 2 >= result.prefixSec);
    const labels = assignSpeakers(own, profile, rec.speakerClusters ??= []);
    const turns = rec.speakerSlices ??= [];
    own.forEach((sl, i) => {
      const centre = bufferStartMs + ((sl.startSec + sl.endSec) / 2) * 1000;
      const s0 = Math.max(w.startMs, centre - 375), e0 = Math.min(w.endMs, centre + 375);
      if (e0 > s0) turns.push({ s: Math.round(s0), e: Math.round(e0), p: labels[i] === 'several' ? 0 : labels[i] as number });
    });
    const signals = rec.voiceSignals ?? (rec.voiceSignals = []);
    for (const sig of result.signals) {
      const startMs = bufferStartMs + sig.startSec * 1000, endMs = Math.min(bufferStartMs + sig.endSec * 1000, w.endMs);
      if (endMs - startMs < 1000) continue;
      // The boundary pass re-reads the previous tail: skip stretches already reported.
      if (signals.some(o => o.kind === sig.kind && Math.min(o.endMs, endMs) - Math.max(o.startMs, startMs) > 0.5 * (endMs - startMs))) continue;
      const record: VoiceSignalRecord = { id: `vs${signals.length + 1}`, kind: sig.kind, startMs, endMs, strength: Math.round(sig.strength * 100) / 100, detail: sig.detail,
        windowIds: [prevId && startMs < w.startMs ? prevId : undefined, w.id].filter((x): x is string => !!x), atMs: this.elapsed(rec) };
      signals.push(record);
      if ((rec.targetedChecks ?? 0) >= this.config.maxTargetedChecks) { record.targetedSkipped = `Targeted-check budget (${this.config.maxTargetedChecks} per session) used up — listen to this stretch`; continue; }
      if (typeof this.lastBalance === 'number' && this.lastBalance < this.config.lowCreditThreshold) { record.targetedSkipped = `DetectifAI credits are low (${this.lastBalance} left) — targeted check skipped; listen to this stretch`; continue; }
      // Clip = suspicious stretch ± 0.5 s, at least 4.5 s (combined checks need > 4 s), at most 15 s.
      let a = Math.max(0, Math.floor(((startMs - 500 - bufferStartMs) / 1000) * 16_000)), b = Math.min(buffer.length, Math.ceil(((endMs + 500 - bufferStartMs) / 1000) * 16_000));
      const min = 4.5 * 16_000, max = 15 * 16_000;
      while (b - a < min && (a > 0 || b < buffer.length)) { a = Math.max(0, a - 1600); b = Math.min(buffer.length, b + 1600); }
      if (b - a > max) b = a + max;
      if (b - a <= 4 * 16_000) { record.targetedSkipped = 'Too little surrounding audio for a combined check (needs > 4 s)'; continue; }
      record.targetedWindowId = this.addTargetedWindow(rec, encodeWav(buffer.slice(a, b), 16_000), { startMs: bufferStartMs + (a / 16_000) * 1000, endMs: bufferStartMs + (b / 16_000) * 1000 }, record);
      rec.targetedChecks = (rec.targetedChecks ?? 0) + 1;
    }
    this.save(rec);
  }
  private addTargetedWindow(rec: ProductRecord, wavBytes: Uint8Array, times: Interval, signal: VoiceSignalRecord): string {
    const reference = rec.session.enrollment!;
    const wav = inspectWav(wavBytes);
    const sequence = rec.session.windows.length, id = `w${sequence}`;
    const window: AudioWindow = { id, sessionId: rec.session.id, sequence, ...times, answerIds: this.answerIdsFor(rec, times), source: rec.kind === 'sandbox' ? 'labelled_upload' : 'candidate_microphone',
      purpose: 'monitor', referenceId: reference.id, mimeType: 'audio/wav', sampleRate: wav.sampleRate, sampleCount: wav.sampleCount, mediaOffsetMs: 0, coverage: 'pending',
      reason: `Targeted check of a locally suspicious stretch (${signal.kind === 'multiple_voices_suspected' ? 'more than one voice' : 'possible different voice'})`, submittedAtMs: this.elapsed(rec) };
    rec.session = addWindow(rec.session, window);
    this.writeMedia(rec, { name: `${id}.wav`, kind: 'window', atMs: times.startMs, windowId: id }, wavBytes);
    (rec.windowMeta ??= {})[id] = { targetedFrom: signal.windowIds, signalId: signal.id };
    rec.windowOps[id] = `${rec.session.id}:${id}`;
    this.scheduleCheck(rec.session.id, id);
    return id;
  }
  /** Starts the DetectifAI check for a window once the change that created it is committed. */
  private scheduleCheck(sessionId: string, windowId: string): void {
    this.later(() => {
      const p = this.runCheck(sessionId, windowId).catch(error => console.error('check failed unexpectedly', error)).finally(() => this.checks.delete(p));
      this.checks.add(p);
    });
  }
  /** Waits for all background checks (tests, graceful shutdown, Vercel waitUntil). */
  async idle(): Promise<void> { while (this.checks.size) await Promise.allSettled([...this.checks]); this.flush(); }
  private async runCheck(sessionId: string, windowId: string): Promise<void> {
    const snap = this.shared ? await this.pull(sessionId) : this.records.get(sessionId);
    const window = snap?.session.windows.find(w => w.id === windowId);
    const reference = snap?.session.enrollment;
    if (!snap || !window || !reference || window.coverage !== 'pending' || snap.session.results.some(r => r.windowId === windowId)) return;
    let result: WindowResult, body: Record<string, any> | undefined;
    try {
      const audio = (await this.readMedia(snap, `${windowId}.wav`)).bytes;
      const response = await this.client.verify(reference.speakerId, new Uint8Array(audio), snap.windowOps[windowId]);
      body = response.body;
      result = normalizeCombined(response, window, this.resultTime(snap));
    } catch (error) {
      result = failedResult(window, this.resultTime(snap), error);
    }
    result.provenance = this.config.provenance;
    await this.mutate(sessionId, rec => {
      if (!rec.session.windows.some(w => w.id === windowId) || rec.session.results.some(r => r.windowId === windowId)) return;
      if (body) this.countUsage(rec, body);
      rec.session = applyResult(rec.session, result);
      this.save(rec);
    }, { missing: 'ignore' });
  }
  /** Interview: wall-clock session time. Sandbox: file timeline + processing time, so latency stays measurable. */
  private resultTime(rec: ProductRecord): number { return this.elapsed(rec); }

  // ---------- thumbnails (navigation aid only) ----------
  addThumbnail(rec: ProductRecord, jpeg: Uint8Array, atMsHeader: unknown): void {
    if (!rec.consent?.camera) fail('consent_required', 'Camera consent was not given', 403);
    if (rec.status !== 'live' && rec.status !== 'paused') fail('invalid_state', 'Thumbnails are only kept during the interview', 409);
    if (jpeg.byteLength > 200_000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('invalid_image', 'Thumbnail must be a JPEG under 200 KB', 422);
    const atMs = Math.round(this.time(rec, Number(atMsHeader), 'x-at-ms'));
    const n = rec.media.filter(m => m.kind === 'thumbnail').length;
    this.writeMedia(rec, { name: `thumb-${atMs}-${n}.jpg`, kind: 'thumbnail', atMs }, jpeg);
    const live = rec.media.filter(m => m.kind === 'thumbnail' && m.purgedAtEpochMs === undefined);
    for (const old of live.slice(0, Math.max(0, live.length - this.config.maxThumbnails))) this.purge(rec, old, 'thumbnail_limit');
    this.save(rec);
  }

  // ---------- synchronized video context (visual context only, never detection evidence) ----------
  /** Stores one independently decodable clip (each MediaRecorder run is a complete file) on the session
   * clock, then trims the rolling buffer. Clips overlapping evidence or pending checks are kept. */
  addVideoClip(rec: ProductRecord, bytes: Uint8Array, meta: Record<string, any>, contentType: unknown): { mediaName: string; evicted: string[] } {
    if (!rec.consent?.camera) fail('consent_required', 'Camera consent was not given', 403);
    if (rec.status !== 'live' && rec.status !== 'paused') fail('invalid_state', 'Video context is only kept during the interview', 409);
    const type = String(contentType ?? '').split(';')[0]!.trim();
    const ext = type === 'video/webm' && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? 'webm'
      : type === 'video/mp4' && Buffer.from(bytes.subarray(4, 8)).toString('latin1') === 'ftyp' ? 'mp4'
      : fail('invalid_video', 'Video clips must be complete WebM or MP4 files', 422);
    const times = this.interval(rec, meta);
    if (times.endMs - times.startMs > 30_000) fail('invalid_interval', 'Video clips must be at most 30 seconds', 422);
    const n = rec.media.filter(m => m.kind === 'video').length;
    const mediaName = `vid-${Math.round(times.startMs)}-${n}.${ext}`;
    this.writeMedia(rec, { name: mediaName, kind: 'video', atMs: times.startMs, endMs: times.endMs }, bytes);
    const evicted = this.trimVideoBuffer(rec);
    this.save(rec);
    return { mediaName, evicted };
  }
  private trimVideoBuffer(rec: ProductRecord): string[] {
    const live = rec.media.filter(m => m.kind === 'video' && m.purgedAtEpochMs === undefined);
    if (!live.length) return [];
    const newest = Math.max(...live.map(m => m.endMs ?? m.atMs)), pad = this.config.videoContextPadMs;
    const protectedIntervals = [
      ...(rec.voiceSignals ?? []),
      ...(rec.gestureChecks ?? []).map(g => ({ startMs: g.issuedAtMs, endMs: g.deadlineMs })),
      ...this.speakerSwitches(rec).map(sw => ({ startMs: sw.atMs - 8_000, endMs: sw.atMs + 8_000 })),
      ...rec.session.evidence,
      ...rec.session.windows.filter(w => w.coverage === 'pending'),
    ].map(i => ({ startMs: i.startMs - pad, endMs: i.endMs + pad }));
    const evicted: string[] = [];
    for (const clip of live) {
      const end = clip.endMs ?? clip.atMs;
      if (end >= newest - this.config.videoBufferMs) continue;
      if (protectedIntervals.some(p => clip.atMs < p.endMs && end > p.startMs)) continue;
      this.purge(rec, clip, 'video_buffer'); evicted.push(clip.name);
    }
    return evicted;
  }
  /** Visual context around an interval, with explicit gaps, computed by the foundation ContextBuffer. */
  videoContext(rec: ProductRecord, interval: Interval) {
    const buffer = new ContextBuffer(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    for (const m of rec.media) if (m.kind === 'video' && m.purgedAtEpochMs === undefined && m.endMs !== undefined && m.endMs > m.atMs) {
      buffer.add({ id: m.name, startMs: m.atMs, endMs: m.endMs, blob: new Blob([]), mimeType: CONTENT_TYPES[m.name.split('.').pop()!]! });
    }
    const context = buffer.context(interval, this.config.videoContextPadMs);
    return { requested: context.requested, complete: context.complete, gaps: context.gaps,
      clips: context.clips.map(c => ({ startMs: c.startMs, endMs: c.endMs, mediaName: c.id, mimeType: c.mimeType })) };
  }

  // ---------- interviewer join & presence ----------
  touch(rec: ProductRecord, side: 'candidate' | 'reviewer'): void {
    const p = this.presence.get(rec.session.id) ?? {};
    p[side] = this.config.now(); this.presence.set(rec.session.id, p);
  }
  connected(rec: ProductRecord, side: 'candidate' | 'reviewer'): boolean {
    const at = this.presence.get(rec.session.id)?.[side];
    return at !== undefined && this.config.now() - at < PRESENCE_MS;
  }
  joinStatus(rec: ProductRecord): JoinStatus {
    if (rec.kind !== 'interview') return 'not_applicable';
    if (rec.status === 'ended') return 'completed';
    if (rec.status === 'live' || rec.status === 'paused') return 'in_progress';
    if (rec.status === 'ready') return 'ready_to_join';
    return 'waiting_for_candidate';
  }
  /** Reviewer-token holders may join any interview that is not complete. The interviewer and the
   * candidate share one session: same id, same clock, same evidence. */
  join(rec: ProductRecord, input: Record<string, any>): void {
    if (rec.kind !== 'interview') fail('not_an_interview', 'Sandbox runs have no live interview to join', 409);
    if (rec.status === 'ended') fail('interview_completed', 'This interview has already been completed. Open the review to see its evidence.', 410);
    const reviewerId = typeof input.reviewerId === 'string' && input.reviewerId.trim() ? input.reviewerId.trim().slice(0, 128) : 'Interviewer';
    if (!rec.interviewer) rec.interviewer = { joinedAtMs: this.elapsed(rec), reviewerId };
    this.touch(rec, 'reviewer');
    this.save(rec);
  }

  // ---------- reviewer actions (Job 5) ----------
  resolve(rec: ProductRecord, evidenceId: string, input: Record<string, any>): void {
    if (!rec.session.evidence.some(e => e.id === evidenceId)) fail('not_found', 'Evidence not found', 404);
    const disposition = input.disposition;
    if (!['request_reverification', 'reviewed', 'escalate'].includes(disposition)) fail('invalid_parameter', 'Invalid disposition');
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 4000) : '';
    if (!notes) fail('invalid_parameter', 'Notes are required for every resolution');
    const reviewerId = typeof input.reviewerId === 'string' && input.reviewerId.trim() ? input.reviewerId.trim().slice(0, 128) : fail('invalid_parameter', 'Reviewer name is required');
    const resolution: ReviewerResolution = { id: `res-${rec.session.resolutions.length + 1}`, evidenceId, reviewerId, atMs: this.elapsed(rec), disposition, notes };
    rec.session = { ...rec.session, resolutions: [...rec.session.resolutions, resolution] };
    if (disposition === 'request_reverification' && rec.kind === 'interview' && !this.openReviewRequest(rec) && this.canIssue(rec))
      this.createReviewRequest(rec, { requestedBy: 'reviewer', requesterName: reviewerId, reason: notes, evidenceId }, false);
    this.save(rec);
  }

  // ---------- re-verification (Job 6) ----------
  private activeChallenge(rec: ProductRecord): VerificationChallenge | undefined {
    const now = this.elapsed(rec);
    return rec.session.challenges.find(c => c.usedAtMs === undefined && c.expiresAtMs > now);
  }
  /** Challenges can be issued once the reference exists — also after the interview ended, so a
   * candidate's re-evaluation request can still collect a fresh response. */
  private canIssue(rec: ProductRecord): boolean {
    const reference = rec.session.enrollment;
    return rec.kind === 'interview' && !!reference && reference.deletedAtMs === undefined && rec.status !== 'consent' && rec.status !== 'enrollment';
  }
  issueChallenge(rec: ProductRecord, save = true, link?: { reviewRequestId: string; version: number }): VerificationChallenge {
    const reference = rec.session.enrollment;
    if (!reference || reference.deletedAtMs !== undefined) fail('enrollment_required', 'Re-verification needs the original active reference', 409);
    if (!this.canIssue(rec)) fail('invalid_state', 'Re-verification starts after the voice reference is accepted', 409);
    if (this.activeChallenge(rec)) fail('challenge_active', 'A challenge is already waiting for the candidate', 409);
    if (rec.session.challenges.length >= 50) fail('session_limit', 'Too many challenges', 429);
    const now = this.elapsed(rec);
    const challenge: VerificationChallenge = { id: `c${rec.session.challenges.length + 1}-${randomBytes(4).toString('hex')}`, sessionId: rec.session.id, referenceId: reference.id,
      issuedAtMs: now, expiresAtMs: now + this.config.challengeTtlMs, phrase: generatePhrase(), gestures: [] };
    rec.session = { ...rec.session, challenges: [...rec.session.challenges, challenge] };
    rec.challengeMeta[challenge.id] = { transcriptSource: 'none', ...link };
    if (save) this.save(rec);
    return challenge;
  }

  // ---------- gesture checks (liveness prompt; detection runs in the candidate's browser) ----------
  private static readonly GESTURE_GRACE_MS = 10_000;   // delivery + upload allowance after the 30 s window
  requestGesture(rec: ProductRecord, input: Record<string, any>): GestureCheck {
    if (rec.kind !== 'interview') fail('not_an_interview', 'Gesture checks are part of a live interview', 409);
    if (rec.status !== 'live' && rec.status !== 'paused') fail('invalid_state', 'Gesture checks can be requested while the interview is in progress', 409);
    if (!rec.consent?.camera) fail('camera_not_consented', 'The candidate did not allow the camera, so gestures cannot be checked. Use a voice phrase re-evaluation instead.', 409);
    const list = rec.gestureChecks ?? (rec.gestureChecks = []);
    const open = list.find(g => this.gestureView(rec, g).verdict === 'pending');
    if (open) fail('gesture_pending', `The candidate is still being asked to: ${GESTURES[open.gesture]}`, 409);
    if (list.length >= 30) fail('session_limit', 'Too many gesture checks in this session', 429);
    const names = Object.keys(GESTURES) as GestureName[];
    const gesture: GestureName = input.gesture === 'random' || input.gesture === undefined ? names[randomBytes(1)[0]! % names.length]!
      : names.includes(input.gesture) ? input.gesture : fail('invalid_parameter', `Unknown gesture. Use one of: ${names.join(', ')} or random`);
    const now = this.elapsed(rec);
    const check: GestureCheck = { id: `g${list.length + 1}-${randomBytes(3).toString('hex')}`, gesture, issuedAtMs: now, deadlineMs: now + this.config.gestureWindowMs,
      requestedBy: typeof input.reviewerId === 'string' && input.reviewerId.trim() ? input.reviewerId.trim().slice(0, 128) : 'Interviewer' };
    list.push(check); this.save(rec);
    return check;
  }
  reportGesture(rec: ProductRecord, gid: string, input: Record<string, any>): void {
    const g = (rec.gestureChecks ?? []).find(x => x.id === gid);
    if (!g) fail('not_found', 'Gesture check not found', 404);
    if (g.report) fail('already_reported', 'This gesture check already has a result', 409);
    const status = input.status;
    if (status !== 'performed' && status !== 'not_performed' && status !== 'unavailable') fail('invalid_parameter', 'Invalid status');
    const now = this.elapsed(rec);
    const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
    const report: NonNullable<GestureCheck['report']> = { status, reportedAtMs: now,
      detectedAtMs: status === 'performed' ? num(input.detectedAtMs, g.issuedAtMs - 2000, now + 2000) : undefined,
      confidence: num(input.confidence, 0, 1), handFrames: num(input.handFrames, 0, 100_000), frames: num(input.frames, 0, 100_000),
      observed: Array.isArray(input.observed) ? input.observed.filter((x: unknown): x is string => typeof x === 'string').slice(0, 8).map((x: string) => x.slice(0, 40)) : undefined,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 300) : undefined };
    if (status === 'performed' && report.detectedAtMs === undefined) fail('invalid_parameter', 'detectedAtMs is required for a performed gesture');
    if (typeof input.snapshot === 'string' && input.snapshot) {
      const jpeg = Buffer.from(input.snapshot.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
      if (jpeg.byteLength > 200_000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('invalid_image', 'Snapshot must be a JPEG under 200 KB', 422);
      report.snapshot = `gesture-${g.id}.jpg`;
      this.writeMedia(rec, { name: report.snapshot, kind: 'gesture', atMs: report.detectedAtMs ?? now }, new Uint8Array(jpeg));
    }
    g.report = report; this.save(rec);
  }
  /** Verdicts are derived, so a candidate who never answers becomes "suspicious" once the time is up. */
  gestureView(rec: ProductRecord, g: GestureCheck) {
    const now = this.elapsed(rec), r = g.report, grace = SwitchGuardService.GESTURE_GRACE_MS;
    let verdict: 'pending' | 'completed' | 'suspicious' | 'unverified', remark: string;
    const label = GESTURES[g.gesture];
    if (!r) {
      if (now <= g.deadlineMs + grace) { verdict = 'pending'; remark = `Waiting for the candidate (${Math.max(0, Math.ceil((g.deadlineMs - now) / 1000))} s left)`; }
      else { verdict = 'suspicious'; remark = `Suspicious: no response from the candidate's device within ${this.config.gestureWindowMs / 1000} s. Check the video context for this time.`; }
    } else if (r.reportedAtMs > g.deadlineMs + grace) {
      verdict = 'suspicious'; remark = `Suspicious: the result arrived ${Math.round((r.reportedAtMs - g.deadlineMs) / 1000)} s after the deadline.`;
    } else if (r.status === 'performed' && r.detectedAtMs !== undefined && r.detectedAtMs <= g.deadlineMs + 2000) {
      verdict = 'completed';
      remark = `“${label}” seen ${Math.max(0, (r.detectedAtMs - g.issuedAtMs) / 1000).toFixed(1)} s after the request${r.confidence !== undefined ? ` (confidence ${Math.round(r.confidence * 100)}%)` : ''}. A liveness signal from the candidate's browser — not proof of identity; check the snapshot.`;
    } else if (r.status === 'unavailable') {
      verdict = 'unverified'; remark = `Could not check: ${r.reason ?? 'camera or gesture detector unavailable'}. Follow up with the candidate or use a voice phrase re-evaluation.`;
    } else {
      verdict = 'suspicious';
      const seen = r.observed?.length ? ` Seen instead: ${r.observed.join(', ')}.` : r.handFrames === 0 ? ' No hand was visible.' : '';
      remark = `Suspicious: “${label}” was not seen within ${this.config.gestureWindowMs / 1000} s.${seen}`;
    }
    const snapshot = r?.snapshot && rec.media.some(m => m.name === r.snapshot && m.purgedAtEpochMs === undefined) ? r.snapshot : undefined;
    return { ...g, label, verdict, remark, report: r ? { ...r, snapshot } : undefined };
  }

  // ---------- re-evaluation requests ----------
  private openReviewRequest(rec: ProductRecord): ReviewRequest | undefined {
    return (rec.reviewRequests ?? []).find(r => { const s = this.reviewStatus(rec, r); return s === 'awaiting_response' || s === 'response_submitted' || s === 'expired'; });
  }
  reviewStatus(rec: ProductRecord, rr: ReviewRequest): ReviewRequestStatus {
    if (rr.outcome) return rr.outcome.outcome;
    const last = rr.versions.at(-1);
    const c = last ? rec.session.challenges.find(x => x.id === last.challengeId) : undefined;
    if (!c) return 'awaiting_response';
    const status = this.challengeView(rec, c).status;
    return status === 'checked' ? 'evaluated' : status === 'submitted' ? 'response_submitted' : status === 'expired' ? 'expired' : 'awaiting_response';
  }
  /** Creates a request with a unique id and issues version 1 (a fresh one-use phrase). */
  createReviewRequest(rec: ProductRecord, input: { requestedBy: 'candidate' | 'reviewer'; reason?: unknown; requesterName?: string; evidenceId?: string }, save = true): ReviewRequest {
    if (!this.canIssue(rec)) fail('invalid_state', 'A re-evaluation can be requested once the voice reference has been accepted', 409);
    const open = this.openReviewRequest(rec);
    if (open) fail('review_request_open', `Re-evaluation ${open.id} is already in progress`, 409);
    if (this.activeChallenge(rec)) fail('challenge_active', 'A phrase is already waiting for the candidate', 409);
    const list = rec.reviewRequests ?? (rec.reviewRequests = []);
    if (list.length >= MAX_REQUESTS) fail('session_limit', 'Too many re-evaluation requests in this session', 429);
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 1000)
      : input.requestedBy === 'candidate' ? 'Candidate asked for a re-evaluation' : 'Reviewer asked for a fresh voice response';
    const rr: ReviewRequest = { id: `rr-${list.length + 1}-${randomBytes(3).toString('hex')}`, createdAtMs: this.elapsed(rec), requestedBy: input.requestedBy,
      requesterName: input.requesterName, reason, evidenceId: input.evidenceId, versions: [] };
    list.push(rr);
    this.addVersion(rec, rr);
    if (save) this.save(rec);
    return rr;
  }
  /** A new voice response for an open request (new phrase, new version). Earlier versions are kept. */
  newVersion(rec: ProductRecord, rid: string, by: 'candidate' | 'reviewer'): ReviewRequest {
    const rr = (rec.reviewRequests ?? []).find(r => r.id === rid);
    if (!rr) fail('not_found', 'Re-evaluation request not found', 404);
    const status = this.reviewStatus(rec, rr);
    if (rr.outcome) fail('review_request_closed', 'This re-evaluation is already closed', 409);
    if (by === 'candidate' && status !== 'expired') fail('invalid_state', 'A new phrase is only needed when the previous one expired', 409);
    if (status === 'awaiting_response' || status === 'response_submitted') fail('invalid_state', 'Wait for the current response before asking for another', 409);
    if (rr.versions.length >= MAX_VERSIONS) fail('version_limit', `At most ${MAX_VERSIONS} responses per re-evaluation`, 429);
    this.addVersion(rec, rr);
    this.save(rec);
    return rr;
  }
  private addVersion(rec: ProductRecord, rr: ReviewRequest): void {
    const version = rr.versions.length + 1;
    const challenge = this.issueChallenge(rec, false, { reviewRequestId: rr.id, version });
    rr.versions.push({ version, challengeId: challenge.id, issuedAtMs: challenge.issuedAtMs });
  }
  closeReviewRequest(rec: ProductRecord, rid: string, input: Record<string, any>): void {
    const rr = (rec.reviewRequests ?? []).find(r => r.id === rid);
    if (!rr) fail('not_found', 'Re-evaluation request not found', 404);
    if (rr.outcome) fail('review_request_closed', 'This re-evaluation is already closed', 409);
    if (input.outcome !== 'reviewed' && input.outcome !== 'escalated') fail('invalid_parameter', 'Outcome must be reviewed or escalated');
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 4000) : '';
    if (!notes) fail('invalid_parameter', 'Notes are required');
    const reviewerId = typeof input.reviewerId === 'string' && input.reviewerId.trim() ? input.reviewerId.trim().slice(0, 128) : fail('invalid_parameter', 'Reviewer name is required');
    const now = this.elapsed(rec);
    rr.outcome = { outcome: input.outcome, notes, reviewerId, atMs: now };
    // Withdraw any phrase from this request that the candidate has not answered yet.
    const ids = new Set(rr.versions.map(v => v.challengeId));
    rec.session = { ...rec.session, challenges: rec.session.challenges.map(c => ids.has(c.id) && c.usedAtMs === undefined && c.expiresAtMs > now ? { ...c, expiresAtMs: now } : c) };
    this.save(rec);
  }
  reviewRequestView(rec: ProductRecord, rr: ReviewRequest) {
    const versions = rr.versions.map(v => {
      const c = rec.session.challenges.find(x => x.id === v.challengeId);
      const cv = c ? this.challengeView(rec, c) : undefined;
      return { ...v, challenge: cv, submittedAtMs: cv?.usedAtMs, transcript: cv?.transcript, audioMediaName: cv?.window?.mediaName,
        evaluation: cv?.window?.result ? { windowId: cv.window.id, speaker: cv.window.result.speaker, authenticity: cv.window.result.authenticity, provenance: cv.window.result.provenance, phraseMatched: cv.phraseMatched } : undefined };
    });
    const evaluated = versions.filter(v => v.evaluation);
    return { ...rr, status: this.reviewStatus(rec, rr), evaluationVersion: evaluated.at(-1)?.version, versions };
  }
  submitChallenge(rec: ProductRecord, challengeId: string, audio: Uint8Array, meta: Record<string, any>, transcriptHeader: unknown, opId: string) {
    let transcript = '';
    try { transcript = decodeURIComponent(String(transcriptHeader ?? '')).trim().slice(0, 500); } catch { fail('invalid_parameter', 'Invalid x-transcript header'); }
    return this.logical(rec, opId, Buffer.concat([Buffer.from(`challenge:${challengeId}:${transcript}:${JSON.stringify(meta)}:`), audio]), async () => {
      const challenge = rec.session.challenges.find(c => c.id === challengeId);
      if (!challenge) fail('not_found', 'Challenge not found', 404);
      if (challenge.usedAtMs !== undefined) fail('challenge_used', 'This challenge was already used; ask the reviewer for a new one', 409);
      if (this.elapsed(rec) > challenge.expiresAtMs) fail('challenge_expired', 'This challenge has expired; ask the reviewer for a new one', 410);
      // Consume first: a failed upload still uses the challenge, so it can never be replayed.
      const usedAtMs = this.elapsed(rec);
      rec.session = { ...rec.session, challenges: rec.session.challenges.map(c => c.id === challengeId ? { ...c, usedAtMs } : c) };
      const cm = rec.challengeMeta[challengeId] ?? (rec.challengeMeta[challengeId] = { transcriptSource: 'none' });
      let phraseMatched: boolean | undefined;
      if (transcript) {
        const cmp = comparePhrase(challenge.phrase, transcript);
        cm.transcript = transcript; cm.transcriptSource = 'browser_speech_recognition';
        cm.phraseComparison = { matched: cmp.matched, matchedWords: cmp.matchedWords, totalWords: cmp.totalWords };
        phraseMatched = cmp.matched;
      }
      this.save(rec);
      const added = this.addAnalysisWindow(rec, audio, meta, 'reverify');
      rec.session = { ...rec.session, challenges: rec.session.challenges.map(c => c.id === challengeId ? { ...c, phraseMatched, resultWindowId: added.windowId } : c) };
      this.save(rec);
      return { challenge: this.challengeView(rec, rec.session.challenges.find(c => c.id === challengeId)!) };
    });
  }
  assistChallenge(rec: ProductRecord, challengeId: string, input: Record<string, any>): void {
    const challenge = rec.session.challenges.find(c => c.id === challengeId);
    if (!challenge) fail('not_found', 'Challenge not found', 404);
    if (typeof input.phraseHeard !== 'boolean') fail('invalid_parameter', 'phraseHeard must be true or false');
    const reviewerId = typeof input.reviewerId === 'string' && input.reviewerId.trim() ? input.reviewerId.trim().slice(0, 128) : fail('invalid_parameter', 'Reviewer name is required');
    const cm = rec.challengeMeta[challengeId] ?? (rec.challengeMeta[challengeId] = { transcriptSource: 'none' });
    cm.reviewerAssist = { phraseHeard: input.phraseHeard, notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '', reviewerId, atMs: this.elapsed(rec) };
    this.save(rec);
  }

  // ---------- deletion (Job 8) ----------
  async deleteProfile(rec: ProductRecord): Promise<void> {
    const ref = rec.session.enrollment;
    if (!ref) fail('not_found', 'No enrolled profile', 404);
    if (ref.deletedAtMs !== undefined) return;
    if (rec.session.windows.some(w => w.coverage === 'pending')) fail('operation_pending', 'Wait for pending checks before deleting the profile', 409);
    await this.deleteRemoteSpeaker(rec);
    rec.session = { ...rec.session, enrollment: { ...ref, deletedAtMs: this.elapsed(rec) } };
    this.interrupt(rec, 'interrupted', 'Original speaker profile deleted');
    if (rec.status === 'live' || rec.status === 'paused') { this.closeAnswer(rec, this.elapsed(rec)); rec.status = 'ended'; }
    this.save(rec);
  }
  private async deleteRemoteSpeaker(rec: ProductRecord): Promise<void> {
    const reachedEnroll = rec.session.enrollment || rec.enrollmentAttempts.some(a => a.authenticity?.status === 'complete' && a.authenticity.verdict === 'real');
    if (!reachedEnroll) return;
    const response = await this.client.deleteSpeaker(rec.speakerId);
    const code = object(object(response.body).error).code;
    if (!(response.status < 300 && response.body.deleted === true) && !(response.status === 404 && code === 'speaker_not_found'))
      fail('remote_delete_failed', `DetectifAI did not confirm speaker deletion (${code ?? response.status}); nothing was removed locally, retry`, 502);
  }
  async deleteSession(rec: ProductRecord): Promise<void> {
    // Also covers an enrollment that may have succeeded remotely after a local timeout.
    if (rec.session.enrollment?.deletedAtMs === undefined) await this.deleteRemoteSpeaker(rec);
    if (this.shared) { await this.shared.deleteSessionMedia(rec.session.id); await this.shared.deleteRecord(rec.session.id); this.etags.delete(rec.session.id); }
    this.records.delete(rec.session.id); this.dirty.delete(rec.session.id); this.presence.delete(rec.session.id);
    rmSync(this.mediaDir(rec.session.id), { recursive: true, force: true });
    rmSync(join(this.config.dataDir, 'sessions', `${rec.session.id}.json`), { force: true });
  }

  // ---------- who is speaking ----------
  /** Consecutive steps by the same person merged into turns (gaps ≤ 1 s bridged). */
  speakerTurns(rec: ProductRecord): Array<{ startMs: number; endMs: number; person: number }> {
    const out: Array<{ startMs: number; endMs: number; person: number }> = [];
    for (const sl of [...(rec.speakerSlices ?? [])].sort((a, b) => a.s - b.s)) {
      const last = out.at(-1);
      if (last && last.person === sl.p && sl.s - last.endMs <= 1000) last.endMs = Math.max(last.endMs, sl.e);
      else out.push({ startMs: sl.s, endMs: sl.e, person: sl.p });
    }
    return out;
  }
  /** Moments where the voice changed from one person to another (each side ≥ 1.5 s). */
  speakerSwitches(rec: ProductRecord): Array<{ atMs: number; from: number; to: number }> {
    const turns = this.speakerTurns(rec).filter(t => t.endMs - t.startMs >= 1500);
    const out: Array<{ atMs: number; from: number; to: number }> = [];
    for (let i = 1; i < turns.length; i++) if (turns[i]!.person !== turns[i - 1]!.person && turns[i]!.startMs - turns[i - 1]!.endMs <= 3000) out.push({ atMs: turns[i]!.startMs, from: turns[i - 1]!.person, to: turns[i]!.person });
    return out;
  }
  /** For every answer: who spoke and for how long. An answer is "split" when a second person spoke a
   * real part of it (≥ 2.25 s and ≥ 15 % of the voiced time), or "other person" when Person 1 did not. */
  answerSpeakers(rec: ProductRecord) {
    const slices = rec.speakerSlices ?? [], switches = this.speakerSwitches(rec);
    const answers = [...rec.session.answers, ...(rec.openAnswer ? [{ ...rec.openAnswer, endMs: this.elapsed(rec) }] : [])];
    return answers.map(a => {
      const secs = new Map<number, number>();
      for (const sl of slices) { const o = Math.min(sl.e, a.endMs) - Math.max(sl.s, a.startMs); if (o > 0) secs.set(sl.p, (secs.get(sl.p) ?? 0) + o / 1000); }
      const total = [...secs.values()].reduce((x, y) => x + y, 0);
      const people = [...secs.entries()].map(([person, seconds]) => ({ person, seconds: Math.round(seconds * 10) / 10 })).sort((x, y) => y.seconds - x.seconds);
      const present = people.filter(p => p.person > 0 && p.seconds >= 2.25 && p.seconds >= total * 0.15);
      const verdict: 'one_person' | 'split' | 'other_person' | 'unclear' = total < 3 ? 'unclear'
        : present.length >= 2 ? 'split' : present.length === 1 && present[0]!.person !== 1 ? 'other_person' : 'one_person';
      const inside = switches.filter(sw => sw.atMs > a.startMs && sw.atMs < a.endMs && present.some(p => p.person === sw.to) && present.some(p => p.person === sw.from));
      return { answerId: a.id, questionId: a.questionId, startMs: a.startMs, endMs: a.endMs, people, verdict, switches: inside, voicedSec: Math.round(total * 10) / 10 };
    });
  }
  speakersView(rec: ProductRecord) {
    const turns = this.speakerTurns(rec), clusters = rec.speakerClusters ?? [];
    const seconds = new Map<number, number>();
    for (const sl of rec.speakerSlices ?? []) seconds.set(sl.p, (seconds.get(sl.p) ?? 0) + (sl.e - sl.s) / 1000);
    const people = clusters.filter(c => c.person === 1 || (seconds.get(c.person) ?? 0) > 0).map(c => ({ person: c.person,
      label: c.person === 1 ? 'Person 1 — enrolled voice' : `Person ${c.person}`, seconds: Math.round((seconds.get(c.person) ?? 0) * 10) / 10,
      firstAtMs: turns.find(t => t.person === c.person)?.startMs, pitchHz: c.f0 ? Math.round(c.f0) : undefined }));
    return { people, several: Math.round((seconds.get(0) ?? 0) * 10) / 10, turns, switches: this.speakerSwitches(rec), answers: this.answerSpeakers(rec),
      note: 'Voices are grouped locally by how they sound. Person numbers are estimates, not identities; DetectifAI confirms only whether a stretch is the enrolled voice.' };
  }

  // ---------- views ----------
  candidateView(rec: ProductRecord) {
    const nowMs = this.elapsed(rec), decision = decide(rec.session, this.decisionNow(rec));
    const pending = this.activeChallenge(rec);
    const latest = rec.reviewRequests?.at(-1);
    return {
      sessionId: rec.session.id, displayName: rec.session.candidate.displayName, status: rec.status, kind: rec.kind, consent: rec.consent,
      enrolled: Boolean(rec.session.enrollment && rec.session.enrollment.deletedAtMs === undefined), enrollmentAttempts: rec.enrollmentAttempts.length,
      questions: rec.session.questions, answeredQuestionIds: [...new Set(rec.session.answers.map(a => a.questionId))], openAnswer: rec.openAnswer,
      monitoring: rec.status === 'ended' ? 'ended' : rec.status === 'paused' ? 'interrupted' : rec.status !== 'live' ? 'not_started' : decision.state === 'monitoring_interrupted' ? 'interrupted' : 'checking',
      pendingChallenge: pending ? { id: pending.id, phrase: pending.phrase, expiresAtMs: pending.expiresAtMs, reviewRequestId: rec.challengeMeta[pending.id]?.reviewRequestId } : undefined,
      interviewer: { joined: !!rec.interviewer, connected: this.connected(rec, 'reviewer') },
      pendingGesture: (() => { const g = (rec.gestureChecks ?? []).find(x => !x.report && this.gestureView(rec, x).verdict === 'pending');
        return g ? { id: g.id, gesture: g.gesture, label: GESTURES[g.gesture], issuedAtMs: g.issuedAtMs, deadlineMs: g.deadlineMs } : undefined; })(),
      reviewRequest: latest ? { id: latest.id, status: this.reviewStatus(rec, latest), versions: latest.versions.length, requestedBy: latest.requestedBy } : undefined,
      canRequestReevaluation: this.canIssue(rec) && !this.openReviewRequest(rec) && !pending && (rec.reviewRequests?.length ?? 0) < MAX_REQUESTS,
      windowMs: this.config.windowMs, nowMs,
    };
  }
  private windowView(rec: ProductRecord, w: AudioWindow) {
    const media = rec.media.find(m => m.windowId === w.id && m.purgedAtEpochMs === undefined);
    return { ...w, result: rec.session.results.find(r => r.windowId === w.id), mediaName: media?.name, targetedFrom: rec.windowMeta?.[w.id]?.targetedFrom };
  }
  challengeView(rec: ProductRecord, c: VerificationChallenge) {
    const nowMs = this.elapsed(rec), cm = rec.challengeMeta[c.id] ?? { transcriptSource: 'none' as const };
    const window = c.resultWindowId ? rec.session.windows.find(w => w.id === c.resultWindowId) : undefined;
    const status = c.usedAtMs === undefined ? (nowMs > c.expiresAtMs ? 'expired' : 'issued') : window && window.coverage !== 'pending' ? 'checked' : 'submitted';
    return { ...c, status, ...cm, window: window ? this.windowView(rec, window) : undefined };
  }
  coverage(rec: ProductRecord) {
    const sum = (k: AudioWindow['coverage'][]) => rec.session.windows.filter(w => k.includes(w.coverage)).reduce((s, w) => s + (w.endMs - w.startMs), 0);
    const gaps: Interval[] = rec.session.windows.filter(w => w.coverage === 'skipped' || w.coverage === 'failed').map(w => ({ startMs: w.startMs, endMs: w.endMs }));
    const monitor = rec.session.windows.filter(w => w.purpose === 'monitor').sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < monitor.length; i++) if (monitor[i]!.startMs - monitor[i - 1]!.endMs > 300) gaps.push({ startMs: monitor[i - 1]!.endMs, endMs: monitor[i]!.startMs });
    gaps.sort((a, b) => a.startMs - b.startMs);
    return { checkedMs: sum(['complete', 'partial']), skippedMs: sum(['skipped']), failedMs: sum(['failed']), pendingMs: sum(['pending']), gaps };
  }
  reviewerView(rec: ProductRecord) {
    const nowMs = this.decisionNow(rec), decision: Decision = decide(rec.session, nowMs);
    return {
      sessionId: rec.session.id, kind: rec.kind, status: rec.status, displayName: rec.session.candidate.displayName,
      candidateUrl: `/candidate.html#s=${rec.session.id}&k=${rec.candidateKey}`, createdAtEpochMs: rec.session.createdAtEpochMs, nowMs,
      consent: rec.consent, enrollment: rec.session.enrollment, enrollmentAttempts: rec.enrollmentAttempts,
      decision, checkAgeMs: decision.latestCompletedCheckMs !== undefined ? nowMs - decision.latestCompletedCheckMs : undefined,
      questions: rec.session.questions, answers: rec.session.answers, openAnswer: rec.openAnswer,
      windows: rec.session.windows.map(w => this.windowView(rec, w)),
      evidence: rec.session.evidence.map(e => {
        const resolutions = rec.session.resolutions.filter(r => r.evidenceId === e.id);
        return { ...e, resolutions, latestDisposition: resolutions.at(-1)?.disposition, videoContext: this.videoContext(rec, e) };
      }),
      interruptions: rec.session.interruptions, challenges: rec.session.challenges.map(c => this.challengeView(rec, c)),
      thumbnails: rec.media.filter(m => m.kind === 'thumbnail' && m.purgedAtEpochMs === undefined).map(m => ({ atMs: m.atMs, mediaName: m.name })),
      videoClips: rec.media.filter(m => m.kind === 'video' && m.purgedAtEpochMs === undefined).map(m => ({ startMs: m.atMs, endMs: m.endMs ?? m.atMs, mediaName: m.name })),
      coverage: this.coverage(rec), usage: rec.usage, sandbox: rec.sandbox, retention: { mediaRetentionHours: this.config.mediaRetentionHours },
      joinStatus: this.joinStatus(rec), interviewer: rec.interviewer ? { ...rec.interviewer, connected: this.connected(rec, 'reviewer') } : undefined,
      candidateConnected: this.connected(rec, 'candidate'),
      reviewRequests: (rec.reviewRequests ?? []).map(r => this.reviewRequestView(rec, r)),
      voiceProfileReady: !!rec.voiceProfile,
      speakers: this.speakersView(rec),
      voiceSignals: (rec.voiceSignals ?? []).map(s => {
        const t = s.targetedWindowId ? rec.session.windows.find(w => w.id === s.targetedWindowId) : undefined;
        const r = t ? rec.session.results.find(x => x.windowId === t.id) : undefined;
        return { ...s, targeted: t ? { windowId: t.id, startMs: t.startMs, endMs: t.endMs, coverage: t.coverage, speaker: r?.speaker, authenticity: r?.authenticity, flagged: rec.session.evidence.some(e => e.windowId === t.id) } : undefined };
      }),
      targetedChecks: { used: rec.targetedChecks ?? 0, max: this.config.maxTargetedChecks, skippedAnalyses: rec.voiceScanSkipped ?? 0, lowCredits: typeof this.lastBalance === 'number' && this.lastBalance < this.config.lowCreditThreshold },
      gestureChecks: (rec.gestureChecks ?? []).map(g => this.gestureView(rec, g)),
    };
  }
  summaries() {
    return [...this.records.values()].sort((a, b) => b.session.createdAtEpochMs - a.session.createdAtEpochMs).map(rec => {
      const d = decide(rec.session, this.decisionNow(rec));
      const requests = rec.reviewRequests ?? [];
      const escalated = rec.session.evidence.filter(e => rec.session.resolutions.filter(r => r.evidenceId === e.id).at(-1)?.disposition === 'escalate').length
        + requests.filter(r => r.outcome?.outcome === 'escalated').length;
      return { sessionId: rec.session.id, kind: rec.kind, displayName: rec.session.candidate.displayName, status: rec.status, createdAtEpochMs: rec.session.createdAtEpochMs, state: d.state, evidenceCount: rec.session.evidence.length, sandbox: rec.sandbox,
        joinStatus: this.joinStatus(rec), interviewerJoined: !!rec.interviewer, candidateConnected: this.connected(rec, 'candidate'),
        openReviewRequests: requests.filter(r => { const s = this.reviewStatus(rec, r); return s === 'awaiting_response' || s === 'response_submitted' || s === 'expired'; }).length,
        reviewRequestsToReview: requests.filter(r => this.reviewStatus(rec, r) === 'evaluated').length, escalated,
        localSignals: rec.voiceSignals?.length ?? 0,
        peopleHeard: (rec.speakerClusters ?? []).filter(c => c.person === 1 || (rec.speakerSlices ?? []).some(sl => sl.p === c.person)).length,
        splitAnswers: this.answerSpeakers(rec).filter(a => a.verdict === 'split' || a.verdict === 'other_person').length,
        suspiciousGestures: (rec.gestureChecks ?? []).filter(g => this.gestureView(rec, g).verdict === 'suspicious').length,
        updatedAtMs: Math.max(0, ...rec.session.results.map(r => r.receivedAtMs), ...rec.session.challenges.map(c => c.usedAtMs ?? c.issuedAtMs), ...rec.session.resolutions.map(r => r.atMs)) };
    });
  }
  exportSession(rec: ProductRecord) {
    const view = this.reviewerView(rec);
    return {
      format: 'switchguard-evidence-export/1', exportedAtEpochMs: this.config.now(),
      notice: 'Detection results are signals, not proof. Speaker similarity is not a probability. A human reviewer makes every decision; the system never rejects a candidate. Media is not included in this export.',
      ...view, candidateUrl: undefined,
      media: rec.media.map(m => ({ name: m.name, kind: m.kind, atMs: m.atMs, stored: m.purgedAtEpochMs === undefined, purgeReason: m.purgeReason })),
    };
  }
  async ops() {
    const cached = this.opsCache;
    if (cached && this.config.now() - cached.atEpochMs < 10_000) return { ...(cached.value as object), queue: this.client.queue.stats, sessions: this.records.size };
    const detectif: { configured: boolean; health?: unknown; credits?: unknown; error?: string } = { configured: this.client.configured };
    try { detectif.health = (await this.client.health()).body; } catch (error) { detectif.error = (error as Error).message; }
    if (this.client.configured) {
      try { const r = await this.client.credits(); detectif.credits = r.status < 300 ? r.body : { error: r.body.error ?? r.status }; } catch (error) { detectif.error = (error as Error).message; }
    }
    const value = { detectif, queue: this.client.queue.stats, sessions: this.records.size, mediaRetentionHours: this.config.mediaRetentionHours, storage: `local disk (${this.config.dataDir}); reviewer-only access` };
    this.opsCache = { atEpochMs: this.config.now(), value };
    return value;
  }
}
