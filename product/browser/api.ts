import './shell.js';
import { mountSignal } from './signal.js';
/** Shared browser client for the product API (see product/API.md). No credentials other than the
 * reviewer token / per-session candidate key ever reach the browser. */
import type {
  Answer, AudioWindow, CaptureInterruption, CheckError, Decision, EnrollmentReference, EvidenceInterval,
  Interval, Question, ReviewerResolution, VerificationChallenge, WindowResult,
} from '../../src/shared/contracts.js';

export type Status = 'consent' | 'enrollment' | 'ready' | 'live' | 'paused' | 'ended';
export interface Consent { voiceAnalysis: boolean; camera: boolean; retention: boolean; atMs: number; transcript?: boolean }
export interface TranscriptPhraseView {
  id: string; startMs: number; endMs: number; text: string; tone: 'ok' | 'warn' | 'bad' | 'gap';
  people: Array<{ person: number; seconds: number }>; reasons: string[]; windowId?: string;
}
export interface TranscriptView { enabled: boolean; phrases: TranscriptPhraseView[]; redCount: number; note: string }
export interface CandidateView {
  sessionId: string; displayName: string; status: Status; kind: 'interview' | 'sandbox';
  consent?: Consent; enrolled: boolean; enrollmentAttempts: number;
  questions: Question[]; answeredQuestionIds: string[];
  openAnswer?: { id: string; questionId: string; startMs: number };
  monitoring: 'not_started' | 'checking' | 'interrupted' | 'ended';
  pendingChallenge?: { id: string; phrase: string; expiresAtMs: number; reviewRequestId?: string };
  interviewer: { joined: boolean; connected: boolean };
  pendingGesture?: { id: string; gesture: GestureName; label: string; issuedAtMs: number; deadlineMs: number };
  reviewRequest?: { id: string; status: ReviewRequestStatus; versions: number; requestedBy: 'candidate' | 'reviewer' };
  canRequestReevaluation: boolean;
  windowMs: number; nowMs: number;
}
export interface WindowView extends AudioWindow { result?: WindowResult; mediaName?: string; targetedFrom?: string[] }
export interface EnrollmentAttempt {
  id: string; atMs: number; durationMs: number; localVoicedSec: number;
  authenticity?: { status: 'complete' | 'failed' | 'missing' | 'inconclusive'; verdict?: 'real' | 'fake' | 'not_sure'; error?: CheckError };
  enrolled: boolean; reason: string; mediaName?: string;
}
export interface ChallengeView extends VerificationChallenge {
  status: 'issued' | 'expired' | 'submitted' | 'checked';
  transcript?: string; transcriptSource?: 'browser_speech_recognition' | 'none';
  phraseComparison?: { matched: boolean; matchedWords: number; totalWords: number };
  reviewerAssist?: { phraseHeard: boolean; notes: string; reviewerId: string; atMs: number };
  window?: WindowView;
}
export interface SandboxMeta { scenario: string; label: string; notes?: string; switchOnsetSec?: number }
export interface ReviewerView {
  sessionId: string; kind: 'interview' | 'sandbox'; status: Status; displayName: string;
  candidateUrl: string; createdAtEpochMs: number; nowMs: number; consent?: Consent;
  enrollment?: EnrollmentReference; enrollmentAttempts: EnrollmentAttempt[];
  decision: Decision; checkAgeMs?: number;
  questions: Question[]; answers: Answer[]; openAnswer?: { id: string; questionId: string; startMs: number };
  windows: WindowView[];
  evidence: Array<EvidenceInterval & { resolutions: ReviewerResolution[]; latestDisposition?: ReviewerResolution['disposition']; videoContext?: VideoContext }>;
  interruptions: CaptureInterruption[]; challenges: ChallengeView[];
  thumbnails: { atMs: number; mediaName: string }[];
  /** Retained candidate video clips (visual context only). */
  videoClips?: { startMs: number; endMs: number; mediaName: string }[];
  coverage: { checkedMs: number; skippedMs: number; failedMs: number; pendingMs: number; gaps: Interval[] };
  usage: { providerCalls: number; creditsCharged: number };
  sandbox?: SandboxMeta; retention: { mediaRetentionHours: number };
  joinStatus: JoinStatus;
  interviewer?: { joinedAtMs: number; reviewerId: string; connected: boolean };
  candidateConnected: boolean;
  reviewRequests: ReviewRequestView[];
  voiceProfileReady: boolean;
  speakers: SpeakersView;
  voiceSignals: VoiceSignalView[];
  targetedChecks: { used: number; max: number };
  gestureChecks: GestureCheckView[];
  transcript?: TranscriptView;
}
export interface SessionSummary {
  sessionId: string; kind: 'interview' | 'sandbox'; displayName: string; status: Status;
  createdAtEpochMs: number; state: Decision['state']; evidenceCount: number; sandbox?: SandboxMeta;
  joinStatus: JoinStatus; interviewerJoined: boolean; candidateConnected: boolean;
  openReviewRequests: number; reviewRequestsToReview: number; escalated: number; updatedAtMs: number;
  localSignals: number; suspiciousGestures: number; peopleHeard: number; splitAnswers: number;
}
export interface OpsView {
  detectif: { configured: boolean; health?: unknown; credits?: unknown; error?: string };
  queue: { active: number; waiting: number; concurrency: number; maxWaiting: number };
  sessions: number; mediaRetentionHours: number; storage: string;
}

/** Video clips around an evidence interval (±5 s) with explicit gaps where nothing was recorded or retained. */
export interface VideoContext {
  requested: { startMs: number; endMs: number }; complete: boolean; gaps: { startMs: number; endMs: number }[];
  clips: { startMs: number; endMs: number; mediaName: string; mimeType: string }[];
}

export type GestureName = 'thumbs_up' | 'thumbs_down' | 'raise_hand' | 'point_one_finger' | 'wave_hello';
export const GESTURE_LABEL: Record<GestureName, string> = {
  thumbs_up: 'Thumbs up', thumbs_down: 'Thumbs down', raise_hand: 'Raise a hand', point_one_finger: 'Point one finger', wave_hello: 'Wave hello',
};
/** Local screening estimate plus the targeted DetectifAI check it triggered (the only part that can become evidence). */
export interface VoiceSignalView {
  id: string; kind: 'speaker_change_suspected' | 'multiple_voices_suspected'; startMs: number; endMs: number; strength: number; detail: string;
  windowIds: string[]; atMs: number; targetedWindowId?: string; targetedSkipped?: string;
  targeted?: { windowId: string; startMs: number; endMs: number; coverage: string; speaker?: WindowResult['speaker']; authenticity?: WindowResult['authenticity']; flagged: boolean };
}
/** Who spoke when (local estimate). Person 1 is the enrolled voice; 0 means several voices at once. */
export interface SpeakersView {
  people: Array<{ person: number; label: string; seconds: number; firstAtMs?: number; pitchHz?: number }>;
  several: number;
  turns: Array<{ startMs: number; endMs: number; person: number }>;
  switches: Array<{ atMs: number; from: number; to: number }>;
  answers: Array<{ answerId: string; questionId: string; startMs: number; endMs: number; voicedSec: number;
    people: Array<{ person: number; seconds: number }>; verdict: 'one_person' | 'split' | 'other_person' | 'unclear';
    switches: Array<{ atMs: number; from: number; to: number }> }>;
  note: string;
}
export interface GestureCheckView {
  id: string; gesture: GestureName; label: string; issuedAtMs: number; deadlineMs: number; requestedBy: string;
  verdict: 'pending' | 'completed' | 'suspicious' | 'unverified'; remark: string;
  report?: { status: 'performed' | 'not_performed' | 'unavailable'; reportedAtMs: number; detectedAtMs?: number; confidence?: number; observed?: string[]; handFrames?: number; frames?: number; reason?: string; snapshot?: string };
}
export type JoinStatus = 'waiting_for_candidate' | 'ready_to_join' | 'in_progress' | 'completed' | 'not_applicable';
export const JOIN_LABEL: Record<JoinStatus, string> = {
  waiting_for_candidate: 'Waiting for candidate', ready_to_join: 'Ready to join', in_progress: 'In progress', completed: 'Completed', not_applicable: 'Sandbox run',
};
export type ReviewRequestStatus = 'awaiting_response' | 'expired' | 'response_submitted' | 'evaluated' | 'reviewed' | 'escalated';
export const REVIEW_STATUS_LABEL: Record<ReviewRequestStatus, string> = {
  awaiting_response: 'Waiting for candidate response', expired: 'Phrase expired — new phrase needed', response_submitted: 'Response received — evaluating',
  evaluated: 'Evaluated — ready for review', reviewed: 'Reviewed', escalated: 'Escalated',
};
/** A re-evaluation request; each voice response is a version linked to its own evaluation. */
export interface ReviewRequestView {
  id: string; createdAtMs: number; requestedBy: 'candidate' | 'reviewer'; requesterName?: string; reason: string; evidenceId?: string;
  status: ReviewRequestStatus; evaluationVersion?: number;
  outcome?: { outcome: 'reviewed' | 'escalated'; notes: string; reviewerId: string; atMs: number };
  versions: Array<{
    version: number; challengeId: string; issuedAtMs: number; submittedAtMs?: number; transcript?: string; audioMediaName?: string;
    challenge?: ChallengeView;
    evaluation?: { windowId: string; speaker: WindowResult['speaker']; authenticity: WindowResult['authenticity']; provenance: WindowResult['provenance']; phraseMatched?: boolean };
  }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Reviewer (token), candidate (per-session key) or judge (public demo: demo sessions only). */
export type Auth = { reviewerToken: string } | { candidateKey: string } | { demo: true };

export function reviewerToken(): string | undefined {
  try { return sessionStorage.getItem('sg.reviewerToken') ?? undefined; } catch { return undefined; }
}
export function setReviewerToken(token: string): void {
  try { sessionStorage.setItem('sg.reviewerToken', token); } catch { /* private mode: token lives only in memory */ }
}
const wantsSignIn = () => { try { return sessionStorage.getItem('sg.signIn') === '1'; } catch { return false; } };
const setWantsSignIn = (on: boolean) => { try { if (on) sessionStorage.setItem('sg.signIn', '1'); else sessionStorage.removeItem('sg.signIn'); } catch { /* optional */ } };
async function judgeDemoEnabled(): Promise<boolean> {
  try { return (await (await fetch('/api/demo')).json() as { enabled?: boolean }).enabled === true; } catch { return false; }
}
/** Banner shown above every reviewer page in judge mode, with a way to sign in for real sessions. */
function showJudgeBanner(): void {
  if (document.getElementById('judge-banner')) return;
  const signIn = el('button', { type: 'button' }, 'Interviewer sign-in');
  signIn.addEventListener('click', () => { setWantsSignIn(true); location.reload(); });
  const banner = el('div', { id: 'judge-banner', class: 'notice warn judge-banner', role: 'status' },
    el('strong', {}, 'Judge demo · '), 'No login needed. Create an interview, open its candidate link in another tab, and review it here. You only see demo sessions; they are deleted after 24 hours. ', signIn);
  const main = document.querySelector('main');
  if (main?.parentElement) main.parentElement.insertBefore(banner, main); else document.body.prepend(banner);
}
/** In-page, accessible sign-in; validates before retaining the reviewer token. When the server runs
 * the judge demo, pages open without a login in judge mode (demo sessions only). */
export async function requireReviewer(): Promise<Auth> {
  const token = reviewerToken();
  if (token) {
    try {
      const result = await fetch('/api/sessions', { headers: { 'x-reviewer-token': token } });
      if (result.status !== 401 && result.status !== 403) return { reviewerToken: token };
    } catch { return { reviewerToken: token }; }
    sessionStorage.removeItem('sg.reviewerToken');
  }
  const demo = await judgeDemoEnabled();
  if (demo && !wantsSignIn()) { document.body.classList.add('judge-mode'); showJudgeBanner(); return { demo: true }; }
  document.body.classList.add('signed-out');
  const input = el('input', { type: 'password', required: '', autocomplete: 'current-password', placeholder: 'Paste the reviewer token', id: 'reviewer-access', spellcheck: 'false' });
  const button = el('button', { class: 'primary', type: 'submit' }, 'Open workspace →');
  const error = el('p', { class: 'auth-error', role: 'alert' });
  const form = el('form', { class: 'auth-access', 'aria-labelledby': 'auth-access-title' },
    el('h2', { id: 'auth-access-title' }, 'Reviewer access'),
    el('label', { for: 'reviewer-access' }, 'Access token'),
    el('div', { class: 'auth-field' }, input, button), error,
    el('p', { class: 'auth-help' }, 'The server prints this token when it starts, or your operator sets it. It stays in this browser tab only.'));
  if (demo) {
    const back = el('button', { type: 'button' }, '← Back to the judge demo (no login)');
    back.addEventListener('click', () => { setWantsSignIn(false); location.reload(); });
    form.append(back);
  }
  const art = el('div', { class: 'auth-signal' });
  const figure = el('figure', { class: 'auth-figure' }, art,
    el('span', { class: 'auth-tag auth-tag-tl' }, 'Fig. 1'),
    el('span', { class: 'auth-tag auth-tag-tr' }, 'A study in continuity'),
    el('span', { class: 'auth-tag auth-tag-x' }, 'frequency →'),
    el('span', { class: 'auth-tag auth-tag-t' }, '← earlier · now'),
    el('figcaption', {}, 'A continuous ribbon, folded in space. Interactive illustration — not analysis output.'));
  const page = el('section', { class: 'auth-page' },
    el('a', { class: 'auth-brand', href: '/' }, 'SwitchGuard', el('span', {}, '.')),
    figure,
    el('div', { class: 'auth-body' },
      el('div', { class: 'auth-copy' },
        el('h1', {}, 'Listen closely.', el('br'), 'Decide fairly.'),
        el('p', {}, 'Speaker continuity and voice authenticity, kept as separate signals and tied to the answer they came from. The evidence is yours to review; the decision stays with you.')),
      form),
    el('p', { class: 'auth-foot' }, 'Technology informs. People decide.'));
  const main = document.querySelector('main') ?? document.body;
  main.replaceChildren(page);
  void mountSignal(art);
  return new Promise<Auth>(resolve => {
    form.addEventListener('submit', async event => {
      event.preventDefault(); const value = input.value.trim(); if (!value) return;
      button.disabled = true; button.textContent = 'Opening workspace…'; error.textContent = '';
      try {
        const result = await fetch('/api/sessions', { headers: { 'x-reviewer-token': value } });
        if (!result.ok) throw new Error(result.status === 401 || result.status === 403 ? 'That token was not recognized. Please try again.' : 'The workspace is unavailable. Please try again.');
        setReviewerToken(value); setWantsSignIn(false); document.body.classList.remove('signed-out'); main.replaceChildren(); resolve({ reviewerToken: value });
      } catch(e) { error.textContent = e instanceof Error ? e.message : 'Could not connect.'; }
      finally { button.disabled = false; button.textContent = 'Open workspace →'; }
    });
  });
}
/** Reads `#s=<id>&k=<key>` from the candidate link. */
export function candidateFromHash(): { sessionId: string; auth: Auth } | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  const sessionId = params.get('s'), key = params.get('k');
  return sessionId && key ? { sessionId, auth: { candidateKey: key } } : undefined;
}

export function authHeaders(auth: Auth): Record<string, string> {
  return 'reviewerToken' in auth ? { 'x-reviewer-token': auth.reviewerToken } : 'candidateKey' in auth ? { 'x-session-key': auth.candidateKey } : { 'x-demo': '1' };
}
function headers(auth: Auth, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...authHeaders(auth) };
}

export async function request<T>(auth: Auth, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof Blob || body instanceof Uint8Array || body instanceof ArrayBuffer;
  const response = await fetch(path, {
    method,
    headers: headers(auth, { ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}), ...extraHeaders }),
    body: body === undefined ? undefined : isRaw ? body as BodyInit : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { code: 'invalid_response', message: text.slice(0, 200) } }; }
  if (!response.ok) {
    if (response.status === 401 && 'reviewerToken' in auth) { try { sessionStorage.removeItem('sg.reviewerToken'); } catch { /* ignore */ } }
    throw new ApiError(response.status, parsed?.error?.code ?? 'http_error', parsed?.error?.message ?? `HTTP ${response.status}`);
  }
  return parsed as T;
}

export function operationId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Uploads one complete WAV with capture metadata. A retry of the same logical upload must pass the same opId. */
export function uploadWav<T>(auth: Auth, path: string, wav: Uint8Array, metadata: Record<string, unknown>, opId = operationId(), extra: Record<string, string> = {}): Promise<T> {
  return request<T>(auth, 'POST', path, new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), {
    'content-type': 'audio/wav', 'x-capture-metadata': encodeURIComponent(JSON.stringify(metadata)), 'x-operation-id': opId, ...extra,
  });
}

export const api = {
  ops: (a: Auth) => request<OpsView>(a, 'GET', '/api/ops'),
  sessions: (a: Auth) => request<{ sessions: SessionSummary[] }>(a, 'GET', '/api/sessions'),
  createSession: (a: Auth, input: { displayName: string; kind: 'interview' | 'sandbox'; sandbox?: SandboxMeta }) =>
    request<{ sessionId: string; candidateKey: string; candidateUrl: string; view: ReviewerView }>(a, 'POST', '/api/sessions', input),
  reviewer: (a: Auth, id: string) => request<ReviewerView>(a, 'GET', `/api/sessions/${id}`),
  candidate: (a: Auth, id: string) => request<CandidateView>(a, 'GET', `/api/sessions/${id}/candidate`),
  clock: (a: Auth, id: string) => request<{ sessionMs: number }>(a, 'GET', `/api/sessions/${id}/clock`),
  consent: (a: Auth, id: string, c: { voiceAnalysis: boolean; camera: boolean; retention: boolean; transcript?: boolean }) => request<CandidateView>(a, 'POST', `/api/sessions/${id}/consent`, c),
  enroll: (a: Auth, id: string, wav: Uint8Array, startMs: number, endMs: number, opId?: string) =>
    uploadWav<{ accepted: boolean; reason: string; attempt: EnrollmentAttempt }>(a, `/api/sessions/${id}/enrollment`, wav, { startMs, endMs }, opId),
  control: (a: Auth, id: string, action: 'start' | 'pause' | 'resume' | 'end') => request<CandidateView>(a, 'POST', `/api/sessions/${id}/control`, { action }),
  startAnswer: (a: Auth, id: string, questionId: string) => request<CandidateView>(a, 'POST', `/api/sessions/${id}/answers/start`, { questionId }),
  endAnswer: (a: Auth, id: string) => request<CandidateView>(a, 'POST', `/api/sessions/${id}/answers/end`, {}),
  window: (a: Auth, id: string, wav: Uint8Array, meta: { startMs: number; endMs: number; source: 'candidate_microphone' | 'labelled_upload' }, opId?: string) =>
    uploadWav<{ windowId: string; coverage: string; reason?: string }>(a, `/api/sessions/${id}/windows`, wav, meta, opId),
  interruption: (a: Auth, id: string, kind: 'interrupted' | 'resumed', reason: string, atMs: number) =>
    request<{ ok: true }>(a, 'POST', `/api/sessions/${id}/interruptions`, { kind, reason, atMs }),
  video: (a: Auth, id: string, clip: Blob, startMs: number, endMs: number) =>
    request<{ mediaName: string; evicted: string[] }>(a, 'POST', `/api/sessions/${id}/video`, clip, {
      'content-type': clip.type || 'video/webm', 'x-capture-metadata': encodeURIComponent(JSON.stringify({ startMs, endMs })) }),
  transcript: (a: Auth, id: string, phrases: Array<{ id: string; startMs: number; endMs: number; text: string }>) =>
    request<{ accepted: number }>(a, 'POST', `/api/sessions/${id}/transcript`, { phrases }),
  thumbnail: (a: Auth, id: string, jpeg: Blob, atMs: number) =>
    request<{ ok: true }>(a, 'POST', `/api/sessions/${id}/thumbnails`, jpeg, { 'content-type': 'image/jpeg', 'x-at-ms': String(Math.round(atMs)) }),
  resolve: (a: Auth, id: string, evidenceId: string, r: { disposition: ReviewerResolution['disposition']; notes: string; reviewerId: string }) =>
    request<ReviewerView>(a, 'POST', `/api/sessions/${id}/evidence/${encodeURIComponent(evidenceId)}/resolutions`, r),
  issueChallenge: (a: Auth, id: string) => request<ReviewerView>(a, 'POST', `/api/sessions/${id}/challenges`, {}),
  submitChallenge: (a: Auth, id: string, cid: string, wav: Uint8Array, startMs: number, endMs: number, transcript: string, opId?: string) =>
    uploadWav<{ challenge: ChallengeView }>(a, `/api/sessions/${id}/challenges/${cid}/submit`, wav, { startMs, endMs }, opId, { 'x-transcript': encodeURIComponent(transcript) }),
  assistChallenge: (a: Auth, id: string, cid: string, body: { phraseHeard: boolean; notes: string; reviewerId: string }) =>
    request<ReviewerView>(a, 'POST', `/api/sessions/${id}/challenges/${cid}/assist`, body),
  deleteProfile: (a: Auth, id: string) => request<ReviewerView>(a, 'DELETE', `/api/sessions/${id}/profile`),
  deleteSession: (a: Auth, id: string) => request<{ deleted: true }>(a, 'DELETE', `/api/sessions/${id}`),
  requestGesture: (a: Auth, id: string, gesture: GestureName | 'random', reviewerId: string) => request<ReviewerView>(a, 'POST', `/api/sessions/${id}/gestures`, { gesture, reviewerId }),
  reportGesture: (a: Auth, id: string, gid: string, body: { status: 'performed' | 'not_performed' | 'unavailable'; detectedAtMs?: number; confidence?: number; observed?: string[]; frames?: number; handFrames?: number; reason?: string; snapshot?: string }) =>
    request<CandidateView>(a, 'POST', `/api/sessions/${id}/gestures/${gid}/report`, body),
  join: (a: Auth, id: string, reviewerId: string) => request<ReviewerView>(a, 'POST', `/api/sessions/${id}/join`, { reviewerId }),
  reviewerControl: (a: Auth, id: string, action: 'start' | 'pause' | 'resume' | 'end') => request<CandidateView>(a, 'POST', `/api/sessions/${id}/control`, { action }),
  requestReevaluation: <T extends CandidateView | ReviewerView>(a: Auth, id: string, reason: string, reviewerId?: string) =>
    request<T>(a, 'POST', `/api/sessions/${id}/review-requests`, { reason, reviewerId }),
  newReviewVersion: <T extends CandidateView | ReviewerView>(a: Auth, id: string, rid: string) => request<T>(a, 'POST', `/api/sessions/${id}/review-requests/${rid}/versions`, {}),
  closeReviewRequest: (a: Auth, id: string, rid: string, body: { outcome: 'reviewed' | 'escalated'; notes: string; reviewerId: string }) =>
    request<ReviewerView>(a, 'POST', `/api/sessions/${id}/review-requests/${rid}/close`, body),
};

/** Fetches reviewer-only media with the token header and returns an object URL (media is never public). */
export async function mediaUrl(a: Auth, id: string, name: string): Promise<string> {
  const response = await fetch(`/api/sessions/${id}/media/${encodeURIComponent(name)}`, { headers: headers(a) });
  if (!response.ok) throw new ApiError(response.status, 'media_unavailable', response.status === 404 ? 'Media deleted or expired under the retention policy' : `HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

/** Session clock anchored once to the server with a midpoint round-trip estimate (see ARCHITECTURE.md timebase). */
export class SessionClock {
  private offset = 0;
  static async sync(a: Auth, id: string): Promise<SessionClock> {
    const clock = new SessionClock();
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now(); const { sessionMs } = await api.clock(a, id); const t1 = performance.now();
      if (t1 - t0 < best) { best = t1 - t0; clock.offset = sessionMs + (t1 - t0) / 2 - t1; }
    }
    return clock;
  }
  /** Session ms for a performance.now() timestamp (default: now). */
  now(perfNow = performance.now()): number { return perfNow + this.offset; }
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, ms) / 1000; const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | undefined>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== undefined) node.append(c);
  return node;
}
