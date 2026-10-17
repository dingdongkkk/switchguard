/** Candidate page: consent → voice reference → live interview capture → re-verification challenges.
 * The candidate never sees detection outcomes; only capture/monitoring state. */
import { encodeWav, PcmWindowAssembler, type PcmClip } from '../../src/media/wav.js';
import { api, ApiError, candidateFromHash, el, fmtMs, operationId, SessionClock, type Auth, type CandidateView } from './api.js';
import { CandidateCapture, CaptureError, describeCaptureProblem, meterFraction, PERMISSION_TIMEOUT_MS } from './capture.js';
import { VideoContextRecorder } from './video-recorder.js';
import { GESTURE_PROMPT, loadRecognizer, watchGesture, type GestureProgress } from './gesture.js';

const ENROLL_PARAGRAPH =
  'The library opens at nine every morning, and most visitors arrive a little later, once the coffee shop next door ' +
  'has started serving. On quiet days the staff sort returned books, repair torn covers, and plan small exhibitions about ' +
  'local history. Children usually head straight for the picture books, while older readers settle near the tall windows ' +
  'overlooking the garden and the old stone bridge.';
// 40 s cap: within DetectifAI's 15–60 s and under hosted upload limits (4.5 MB at 48 kHz).
const ENROLL_TARGET_SEC = 20, ENROLL_MIN_SEC = 15, ENROLL_MAX_SEC = 40;
const CHALLENGE_TARGET_SEC = 8, CHALLENGE_MIN_SEC = 5;
const POLL_MS = 1500, THUMB_MS = 3000, MAX_RETRIES = 3;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};
const show = (id: string, visible: boolean) => { $(id).hidden = !visible; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------- errors
function showError(text: string): void {
  const box = $('errors');
  if ([...box.children].some((c) => c.textContent === text)) return;
  const note = el('div', { class: 'notice bad' }, text);
  box.append(note);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => note.remove(), 15000);
}

// ---------------------------------------------------------------- state
let target: { sessionId: string; auth: Auth };
let clock: SessionClock;
let view: CandidateView | undefined;
let capture: CandidateCapture | undefined;
let opening: Promise<CandidateCapture | undefined> | undefined;
/** Live-window assembler for the current capture segment; undefined while not streaming. */
let segment: PcmWindowAssembler | undefined;
/** An `interrupted` has been posted without a matching `resumed`. */
let interruptionOpen = false;
/** Exclusive recording (enrollment or challenge); window streaming is suspended while it runs. */
let recording: Recording | undefined;
/** Capture is opened automatically once per page load; afterwards only on a user action (Reconnect). */
let autoOpenTried = false;
/** Why the microphone could not start (shown with fix-it steps and a retry until it works). */
let permissionProblem: CaptureError | undefined;
/** performance.now() when the current permission request started (for the 40 s countdown). */
let permissionAskedAt: number | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** One continuous recording, assembled with the foundation window assembler (single ≤60 s clip). */
class Recording {
  clip?: PcmClip;
  broken?: string;
  readonly startedPerf = performance.now();
  private readonly assembler: PcmWindowAssembler;
  constructor(sampleRate: number) {
    this.assembler = new PcmWindowAssembler(sampleRate, ENROLL_MAX_SEC * 1000,
      (clip) => { if (!this.clip) this.clip = clip; },
      () => { this.broken ??= 'The audio was interrupted during the recording.'; });
  }
  get elapsedSec(): number { return (performance.now() - this.startedPerf) / 1000; }
  push(samples: Float32Array, startMs: number): void {
    if (this.broken || this.clip) return;
    try { this.assembler.push(samples, startMs); } catch (error) { this.broken = message(error); }
  }
  finish(): PcmClip | undefined {
    if (!this.clip && !this.broken) this.assembler.flush(true);
    return this.broken ? undefined : this.clip;
  }
}

// ---------------------------------------------------------------- upload queue
interface Job { label: string; opId: string; tries: number; run: (opId: string) => Promise<unknown> }
const queue: Job[] = [];
let failedUploads = 0, draining = false;

function enqueue(label: string, run: (opId: string) => Promise<unknown>): void {
  queue.push({ label, opId: operationId(), tries: 0, run });
  renderUploads();
  void drain();
}
const retryable = (error: unknown) => !(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue[0]!;
    try {
      await job.run(job.opId);   // retries reuse the same operation id
      queue.shift();
    } catch (error) {
      job.tries++;
      if (job.tries > MAX_RETRIES || !retryable(error)) {
        queue.shift(); failedUploads++;
        showError(`${job.label} failed: ${message(error)}`);
      } else {
        await sleep(1000 * 2 ** (job.tries - 1));
      }
    }
    renderUploads();
  }
  draining = false;
  renderUploads();
}

async function waitForQueue(timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while ((queue.length || draining) && performance.now() < deadline) await sleep(200);
}

function enqueueWindow(clip: PcmClip): void {
  const wav = encodeWav(clip.samples, clip.sampleRate);
  const meta = { startMs: clip.startMs, endMs: clip.endMs, source: 'candidate_microphone' as const };
  enqueue(`Audio window ${fmtMs(clip.startMs)}`, (opId) => api.window(target.auth, target.sessionId, wav, meta, opId));
}

function enqueueInterruption(kind: 'interrupted' | 'resumed', reason: string, atMs: number): void {
  enqueue(`Capture ${kind} notice`, () => api.interruption(target.auth, target.sessionId, kind, reason, atMs));
}

// ---------------------------------------------------------------- capture segments
function openSegment(resumeReason: string): void {
  if (!view || view.status !== 'live' || segment || recording || !capture?.healthy) return;
  capture.reanchor();
  try {
    segment = new PcmWindowAssembler(capture.sampleRate, view.windowMs, enqueueWindow, (gapStart, gapEnd) => {
      if (interruptionOpen) return;
      enqueueInterruption('interrupted', 'Audio gap in capture', gapStart);
      enqueueInterruption('resumed', 'Audio gap in capture', gapEnd);
    });
  } catch (error) {
    showError(`Cannot start audio windows: ${message(error)}`);
    return;
  }
  if (interruptionOpen) { interruptionOpen = false; enqueueInterruption('resumed', resumeReason, clock.now()); }
  render();
}

/** Flushes the current segment (window ends here) and, with a reason, posts an interruption. */
function closeSegment(reason?: string): void {
  if (segment) { segment.flush(true); segment = undefined; }
  if (reason && !interruptionOpen) { interruptionOpen = true; enqueueInterruption('interrupted', reason, clock.now()); }
}

function onChunk(samples: Float32Array, startMs: number): void {
  if (recording) { recording.push(samples, startMs); return; }
  if (!segment) return;
  try { segment.push(samples, startMs); }
  catch (error) {
    // Clock moved backward: never let a window span it. Close and restart with a fresh anchor.
    closeSegment(`Capture clock reset (${message(error)})`);
    openSegment('Capture restarted with a fresh time anchor');
  }
}

async function ensureCapture(): Promise<CandidateCapture | undefined> {
  if (capture && !capture.ended) return capture;
  if (opening) return opening;
  opening = (async () => {
    permissionAskedAt = performance.now(); permissionProblem = undefined; render();
    try {
      capture?.stop();
      capture = await CandidateCapture.open(clock, { video: !!view?.consent?.camera }, {
        onChunk,
        onInterrupted: (reason) => {
          if (recording) recording.broken ??= `${reason}. Please record again.`;
          if (view?.status === 'live') closeSegment(reason);
          render();
        },
        onResumed: (reason) => { openSegment(reason); render(); },
      });
      const preview = $<HTMLVideoElement>('preview');
      if (capture.videoTrack) { preview.srcObject = capture.stream; preview.hidden = false; void preview.play().catch(() => undefined); }
      return capture;
    } catch (error) {
      capture = undefined;
      permissionProblem = error instanceof CaptureError ? error : new CaptureError('unknown', 'microphone', message(error));
      return undefined;
    } finally {
      opening = undefined; permissionAskedAt = undefined;
      render();
    }
  })();
  return opening;
}

async function reconnect(): Promise<void> {
  if (capture && !capture.ended) await capture.resume();
  else { capture?.stop(); capture = undefined; await ensureCapture(); }
  if (!capture) return;   // the permission panel explains what to fix
  openSegment('Microphone reconnected');
  render();
}

// ---------------------------------------------------------------- view application
function applyView(next: CandidateView): void {
  const first = !view, previous = view?.status;
  view = next;
  if (first && next.status === 'live') {
    interruptionOpen = true;
    enqueueInterruption('interrupted', 'Candidate page reloaded', clock.now());
  } else if (first && next.status === 'paused') {
    interruptionOpen = true;   // the pause was already recorded before this page load
  }
  if (next.status !== 'live' && segment) closeSegment(next.status === 'paused' ? 'Interview paused' : undefined);
  else if (next.status === 'paused' && previous === 'live') closeSegment('Interview paused');

  if (next.status === 'live') {
    if (!capture && !autoOpenTried) { autoOpenTried = true; void ensureCapture().then(() => openSegment('Candidate page reconnected')); }
    else openSegment(previous === 'paused' ? 'Interview resumed' : 'Capture resumed');
  } else if ((next.status === 'ready' || next.status === 'paused' || next.status === 'enrollment') && !capture && !autoOpenTried) {
    autoOpenTried = true; void ensureCapture();
  }
  if (next.status === 'ended' && previous !== 'ended' && capture && !recording) { capture.stop(); capture = undefined; }
  render();
}

let polling = false;
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try { applyView(await api.candidate(target.auth, target.sessionId)); }
  catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) {
      if (pollTimer) clearInterval(pollTimer);
      linkInvalid();
    } else showError(`Connection problem — retrying automatically: ${message(error)}`);
  }
  finally { polling = false; }
}

function linkInvalid(): void {
  for (const id of ['loading', 'consent', 'enrollment', 'interview', 'challenge', 'ended', 'reeval', 'permission']) show(id, false);
  const panel = $('nolink');
  panel.replaceChildren(el('h2', {}, 'This interview link is no longer valid'),
    el('p', {}, 'The interview may have been deleted, or the link is incomplete. Ask your interviewer for a new link.'));
  show('nolink', true);
}

async function act(action: () => Promise<CandidateView>): Promise<void> {
  try { applyView(await action()); } catch (error) { showError(message(error)); }
}

// ---------------------------------------------------------------- rendering
const MONITORING: Record<CandidateView['monitoring'], [string, string]> = {
  not_started: ['gap', 'Checks not started'],
  checking: ['info', 'Voice checks running'],
  interrupted: ['warn', 'Capture interrupted'],
  ended: ['gap', 'Checks ended'],
};

function render(): void {
  const v = view;
  if (!v) return;
  show('loading', false);
  const stepIndex = v.status === 'consent' ? 0 : v.status === 'enrollment' ? 1 : 2;
  document.querySelectorAll('.candidate-progress > div').forEach((step, i) => {
    step.classList.toggle('active', i === stepIndex); step.classList.toggle('complete', i < stepIndex);
    if (i === stepIndex) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  $('who').textContent = v.displayName;
  const badge = $('monitoring');
  const [cls, text] = MONITORING[v.monitoring];
  badge.className = `badge ${cls}`; badge.textContent = text; badge.hidden = v.status === 'consent';

  show('consent', v.status === 'consent');
  show('enrollment', v.status === 'enrollment');
  show('interview', v.status === 'ready' || v.status === 'live' || v.status === 'paused');
  show('ended', v.status === 'ended');
  if (v.status === 'enrollment') renderEnrollment();
  if (v.status === 'ready' || v.status === 'live' || v.status === 'paused') renderInterview(v);
  if (v.status !== 'consent' && v.status !== 'enrollment') renderChallenge(v); else show('challenge', false);
  renderGesture(v);
  renderPermission(v);
  renderReevaluation(v);
  renderUploads();
}

/** A clear request while the browser prompt is open (max 40 s), then specific steps and a retry. */
function renderPermission(v: CandidateView): void {
  const relevant = v.status === 'enrollment' || v.status === 'ready' || v.status === 'live' || v.status === 'paused' || !!challenge;
  const waiting = !!opening && permissionAskedAt !== undefined;
  show('permission', relevant && (waiting || !!permissionProblem));
  if (!relevant) return;
  const steps = $('permission-steps'), wait = $('permission-wait'), retry = $<HTMLButtonElement>('permission-retry');
  if (waiting) {
    const left = Math.max(0, Math.ceil((PERMISSION_TIMEOUT_MS - (performance.now() - permissionAskedAt!)) / 1000));
    $('permission-title').textContent = v.consent?.camera ? 'Allow microphone and camera access' : 'Allow microphone access';
    $('permission-message').textContent = 'Your browser is asking to use your ' + (v.consent?.camera ? 'microphone and camera' : 'microphone') + '. Choose “Allow” in the prompt near the address bar.';
    steps.replaceChildren(el('li', {}, 'If you do not see a prompt, it may be behind this window or blocked — check the icon at the left of the address bar.'));
    wait.hidden = false; wait.textContent = `Waiting for your answer… ${left} s left`;
    retry.hidden = true;
  } else if (permissionProblem) {
    const d = describeCaptureProblem(permissionProblem);
    $('permission-title').textContent = d.title;
    $('permission-message').textContent = d.message;
    steps.replaceChildren(...d.steps.map((t) => el('li', {}, t)));
    wait.hidden = true; retry.hidden = false; retry.disabled = false;
  }
}

const CANDIDATE_REVIEW_TEXT: Record<NonNullable<CandidateView['reviewRequest']>['status'], string> = {
  awaiting_response: 'Waiting for your recording — read the phrase shown above aloud.',
  expired: 'The phrase expired before it was recorded. Press “Get a new phrase” to try again.',
  response_submitted: 'Your recording was received. A reviewer will look at it.',
  evaluated: 'Your recording was received. A reviewer will look at it.',
  reviewed: 'A reviewer has closed this re-evaluation.',
  escalated: 'A reviewer has closed this re-evaluation.',
};

function renderReevaluation(v: CandidateView): void {
  // Only once the candidate has actually answered something (or a re-evaluation already exists).
  const started = v.status === 'live' || v.status === 'paused' || v.status === 'ended';
  const answered = v.answeredQuestionIds.length > 0 || !!v.openAnswer;
  const visible = v.kind === 'interview' && v.enrolled && started && (answered || !!v.reviewRequest);
  show('reeval', visible);
  if (!visible) return;
  const rr = v.reviewRequest;
  const open = !!rr && (rr.status === 'awaiting_response' || rr.status === 'expired' || rr.status === 'response_submitted' || rr.status === 'evaluated');
  const status = $('reeval-status');
  status.hidden = !rr;
  if (rr) status.textContent = `Re-evaluation ${rr.id}${rr.versions > 1 ? ` (response ${rr.versions})` : ''}: ${CANDIDATE_REVIEW_TEXT[rr.status]}`;
  const canAsk = v.canRequestReevaluation && !(open && rr!.status !== 'evaluated');
  show('reeval-reason-label', canAsk); show('reeval-reason', canAsk); show('reeval-request', canAsk);
  show('reeval-new-phrase', !!rr && rr.status === 'expired');
}

function wireReevaluation(): void {
  const request = $<HTMLButtonElement>('reeval-request'), newPhrase = $<HTMLButtonElement>('reeval-new-phrase'), reason = $<HTMLTextAreaElement>('reeval-reason');
  request.addEventListener('click', async () => {
    request.disabled = true;
    try { applyView(await api.requestReevaluation<CandidateView>(target.auth, target.sessionId, reason.value.trim())); reason.value = ''; }
    catch (error) { showError(`Could not request a re-evaluation: ${message(error)}`); }
    finally { request.disabled = false; }
  });
  newPhrase.addEventListener('click', async () => {
    const rid = view?.reviewRequest?.id;
    if (!rid) return;
    newPhrase.disabled = true;
    try { applyView(await api.newReviewVersion<CandidateView>(target.auth, target.sessionId, rid)); }
    catch (error) { showError(`Could not get a new phrase: ${message(error)}`); }
    finally { newPhrase.disabled = false; }
  });
}

function renderInterview(v: CandidateView): void {
  show('ctl-start', v.status === 'ready');
  show('ctl-pause', v.status === 'live');
  show('ctl-resume', v.status === 'paused');
  show('ctl-end', v.status === 'live' || v.status === 'paused');
  $('interview-state').textContent =
    v.status === 'ready' ? 'Your interviewer starts the interview. If they ask you to, you can also press "Start interview".'
      : v.status === 'paused' ? 'The interview is paused. Audio is not being sent.'
        : 'Interview in progress. Press "Start answer" before answering each question and "End answer" when you finish.';

  // Capture state (never detection outcomes).
  const cameraNote = $('camera-note');
  cameraNote.hidden = false;
  const camProblem = capture?.cameraProblem ? describeCaptureProblem(capture.cameraProblem) : undefined;
  cameraNote.textContent = !v.consent?.camera ? 'Camera off (not enabled in consent).'
    : camProblem ? `${camProblem.title}. Continuing with audio only. ${camProblem.steps[0] ?? ''}`
      : capture?.videoTrack ? 'Camera on: snapshots and short low-resolution clips are sent while live (context for the reviewer only).'
        : opening ? 'Camera starting…' : 'Camera not connected.';
  show('camera-retry', !!camProblem && !recording);
  let state: string, needsReconnect = false;
  if (opening) state = 'Starting microphone…';
  else if (!capture) { state = 'Microphone not connected.'; needsReconnect = true; }
  else if (capture.ended) { state = 'Microphone disconnected.'; needsReconnect = true; }
  else if (!capture.running) { state = 'Audio is suspended by the browser.'; needsReconnect = true; }
  else if (capture.muted) state = 'Microphone is muted or in use by another app.';
  else if (recording) state = 'Recording your phrase…';
  else if (segment) state = 'Microphone active — audio is being sent for checks.';
  else state = v.status === 'live' ? 'Microphone active — waiting to send audio.' : 'Microphone active (not sending until the interview is live).';
  $('capture-state').textContent = state;
  show('reconnect', needsReconnect);

  // Questions.
  const open = v.openAnswer;
  const current = open ? v.questions.find((q) => q.id === open.questionId) : v.questions.find((q) => !v.answeredQuestionIds.includes(q.id));
  const index = current ? v.questions.indexOf(current) + 1 : 0;
  show('question-panel', v.questions.length > 0);
  $('question-count').textContent = current ? `Question ${index} of ${v.questions.length}` : 'Questions';
  $('question-text').textContent = current ? current.text : 'All questions have been answered. Your interviewer may end the interview.';
  const startBtn = $<HTMLButtonElement>('answer-start'), endBtn = $<HTMLButtonElement>('answer-end');
  startBtn.disabled = v.status !== 'live' || !!open || !current || !!recording;
  endBtn.disabled = !open || v.status !== 'live';
  startBtn.hidden = !!open; endBtn.hidden = !open;

  $('interviewer-state').textContent = !v.interviewer.joined ? 'Waiting for your interviewer to join…'
    : v.interviewer.connected ? 'Your interviewer has joined.' : 'Your interviewer joined but is not connected right now.';
}

function renderUploads(): void {
  const text = `${queue.length} upload${queue.length === 1 ? '' : 's'} pending · ${failedUploads} failed`;
  $('uploads').textContent = text;
  $('ended-uploads').textContent = queue.length ? `${text}. Please keep this page open.` : `All uploads finished · ${failedUploads} failed`;
}

// ---------------------------------------------------------------- consent
function wireConsent(): void {
  const voice = $<HTMLInputElement>('c-voice'), retention = $<HTMLInputElement>('c-retention'), camera = $<HTMLInputElement>('c-camera');
  const submit = $<HTMLButtonElement>('consent-submit');
  const update = () => { submit.disabled = !(voice.checked && retention.checked); };
  voice.addEventListener('change', update); retention.addEventListener('change', update);
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      applyView(await api.consent(target.auth, target.sessionId, { voiceAnalysis: voice.checked, camera: camera.checked, retention: retention.checked }));
      void ensureCapture();   // inside the click gesture so the audio context may start
    } catch (error) { showError(message(error)); update(); }
  });
}

// ---------------------------------------------------------------- enrollment
type EnrollPhase = 'idle' | 'recording' | 'uploading' | 'done' | 'retry' | 'rerecord';
let enrollPhase: EnrollPhase = 'idle';
let enrollPending: { wav: Uint8Array; startMs: number; endMs: number; opId: string } | undefined;
let enrollTimer: ReturnType<typeof setInterval> | undefined;

function renderEnrollment(): void {
  show('enroll-start', enrollPhase === 'idle');
  show('enroll-stop', enrollPhase === 'recording');
  show('enroll-retry', enrollPhase === 'retry');
  show('enroll-rerecord', enrollPhase === 'retry' || enrollPhase === 'rerecord');
  const status = $('enroll-status');
  if (enrollPhase === 'recording' && recording) {
    const t = recording.elapsedSec;
    status.textContent = t < ENROLL_TARGET_SEC ? `Recording… keep reading (${Math.ceil(ENROLL_TARGET_SEC - t)} s left)`
      : `Recording ${Math.floor(t)} s — you can stop now`;
    $<HTMLButtonElement>('enroll-stop').disabled = t < ENROLL_MIN_SEC;
  } else if (enrollPhase === 'uploading') status.textContent = 'Uploading your voice reference…';
  else if (enrollPhase === 'idle') status.textContent = capture?.healthy ? 'Ready to record.' : 'Press "Start recording" to turn on your microphone.';
  else if (enrollPhase === 'done') status.textContent = 'Voice reference accepted.';
  else status.textContent = '';
}

function setEnrollReason(text: string | undefined, bad = false): void {
  const reason = $('enroll-reason');
  reason.hidden = !text; reason.textContent = text ?? '';
  reason.className = bad ? 'notice warn' : 'notice';
}

async function startEnrollment(): Promise<void> {
  setEnrollReason(undefined);
  const cap = await ensureCapture();
  if (!cap) return;
  if (!(await cap.resume()) || !cap.healthy) { showError('The microphone is not delivering audio. Check it is not muted, then try again.'); return; }
  recording = new Recording(cap.sampleRate);
  enrollPhase = 'recording';
  enrollTimer = setInterval(() => {
    if (recording && (recording.elapsedSec >= ENROLL_MAX_SEC || recording.clip || recording.broken)) void stopEnrollment();
    else renderEnrollment();
  }, 250);
  renderEnrollment();
}

async function stopEnrollment(): Promise<void> {
  if (enrollTimer) clearInterval(enrollTimer);
  enrollTimer = undefined;
  const rec = recording;
  recording = undefined;
  if (!rec) return;
  const clip = rec.finish();
  if (!clip) { enrollPhase = 'rerecord'; setEnrollReason(rec.broken ?? 'No audio was captured.', true); renderEnrollment(); return; }
  const seconds = clip.samples.length / clip.sampleRate;
  if (seconds < ENROLL_MIN_SEC) {
    enrollPhase = 'rerecord';
    setEnrollReason(`The recording is ${seconds.toFixed(1)} s long; at least ${ENROLL_MIN_SEC} s is needed. Please record again.`, true);
    renderEnrollment();
    return;
  }
  enrollPending = { wav: encodeWav(clip.samples, clip.sampleRate), startMs: clip.startMs, endMs: clip.endMs, opId: operationId() };
  await uploadEnrollment();
}

async function uploadEnrollment(): Promise<void> {
  const pending = enrollPending;
  if (!pending) return;
  enrollPhase = 'uploading'; renderEnrollment();
  try {
    const result = await api.enroll(target.auth, target.sessionId, pending.wav, pending.startMs, pending.endMs, pending.opId);
    enrollPending = undefined;
    enrollPhase = result.accepted ? 'done' : 'rerecord';
    setEnrollReason(result.reason, !result.accepted);   // server reason, verbatim
    if (result.accepted) await poll();
  } catch (error) {
    enrollPhase = 'retry';
    setEnrollReason(`Upload failed: ${message(error)}. "Retry upload" resends the same recording.`, true);
  }
  renderEnrollment();
}

function wireEnrollment(): void {
  $('enroll-text').textContent = ENROLL_PARAGRAPH;
  $('enroll-start').addEventListener('click', () => void startEnrollment());
  $('enroll-stop').addEventListener('click', () => void stopEnrollment());
  $('enroll-retry').addEventListener('click', () => void uploadEnrollment());
  $('enroll-rerecord').addEventListener('click', () => { enrollPending = undefined; enrollPhase = 'idle'; setEnrollReason(undefined); void startEnrollment(); });
}

// ---------------------------------------------------------------- challenge
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void;
}
const SpeechRecognitionCtor: (new () => SpeechRecognitionLike) | undefined =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

type ChallengePhase = 'idle' | 'recording' | 'uploading' | 'retry' | 'submitted';
let challenge: { id: string; phrase: string; expiresAtMs: number; phase: ChallengePhase; note: string;
  pending?: { wav: Uint8Array; startMs: number; endMs: number; transcript: string; opId: string } } | undefined;
let recognition: { instance: SpeechRecognitionLike; transcript: string[]; ended: Promise<void> } | undefined;
let challengeTimer: ReturnType<typeof setInterval> | undefined;

function renderChallenge(v: CandidateView): void {
  const pc = v.pendingChallenge;
  if (pc && (!challenge || challenge.id !== pc.id) && challenge?.phase !== 'recording' && challenge?.phase !== 'uploading') {
    challenge = { ...pc, phase: 'idle', note: '' };
  }
  const visible = !!challenge && (pc?.id === challenge.id || challenge.phase !== 'idle');
  show('challenge', visible);
  if (!challenge || !visible) return;
  $('challenge-phrase').textContent = `“${challenge.phrase}”`;
  const left = challenge.expiresAtMs - clock.now();
  const expired = left <= 0;
  $('challenge-expiry').textContent = challenge.phase === 'submitted' ? ''
    : expired ? (v.reviewRequest?.status === 'expired' ? 'This phrase has expired. Press “Get a new phrase” below.' : 'This phrase has expired. Your interviewer can issue a new one.')
      : `Expires in ${Math.ceil(left / 1000)} s`;
  const status = $('challenge-status');
  status.textContent = challenge.note;
  status.className = challenge.phase === 'retry' ? 'notice warn' : challenge.note ? 'notice' : '';
  const recordBtn = $<HTMLButtonElement>('challenge-record'), stopBtn = $<HTMLButtonElement>('challenge-stop');
  recordBtn.hidden = challenge.phase === 'recording' || challenge.phase === 'submitted' || challenge.phase === 'uploading';
  recordBtn.disabled = expired;
  recordBtn.textContent = challenge.phase === 'retry' ? 'Record again' : 'Record answer';
  stopBtn.hidden = challenge.phase !== 'recording';
  stopBtn.disabled = !recording || recording.elapsedSec < CHALLENGE_MIN_SEC;
  show('challenge-retry', challenge.phase === 'retry' && !!challenge.pending);
}

function startRecognition(): void {
  recognition = undefined;
  if (!SpeechRecognitionCtor) return;
  try {
    const instance = new SpeechRecognitionCtor();
    instance.lang = 'en-US'; instance.interimResults = false; instance.continuous = true; instance.maxAlternatives = 1;
    const transcript: string[] = [];
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((r) => { resolveEnded = r; });
    instance.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal && result[0]) transcript.push(String(result[0].transcript).trim());
      }
    };
    instance.onerror = () => resolveEnded();
    instance.onend = () => resolveEnded();
    instance.start();
    recognition = { instance, transcript, ended };
  } catch { recognition = undefined; }
}

async function stopRecognition(): Promise<string> {
  const r = recognition;
  recognition = undefined;
  if (!r) return '';
  try { r.instance.stop(); } catch { /* already stopped */ }
  await Promise.race([r.ended, sleep(2000)]);
  return r.transcript.join(' ').trim();
}

async function startChallenge(): Promise<void> {
  const c = challenge;
  if (!c || recording) return;
  const cap = await ensureCapture();
  if (!cap) return;
  if (!(await cap.resume()) || !cap.healthy) { showError('The microphone is not delivering audio. Check it is not muted, then try again.'); return; }
  closeSegment();   // the phrase is its own segment; live windows pause and restart afterwards
  recording = new Recording(cap.sampleRate);
  startRecognition();
  c.phase = 'recording'; c.pending = undefined;
  c.note = SpeechRecognitionCtor ? 'Recording… read the phrase aloud now.' : 'Recording… read the phrase aloud now. Your browser cannot transcribe; a reviewer will listen instead.';
  challengeTimer = setInterval(() => {
    if (recording && (recording.elapsedSec >= CHALLENGE_TARGET_SEC || recording.broken)) void stopChallenge();
    else render();
  }, 250);
  render();
}

async function stopChallenge(): Promise<void> {
  if (challengeTimer) clearInterval(challengeTimer);
  challengeTimer = undefined;
  const rec = recording, c = challenge;
  recording = undefined;
  if (!rec || !c) return;
  const clip = rec.finish();
  const transcript = await stopRecognition();
  openSegment('Phrase recording finished');
  if (!clip || clip.samples.length / clip.sampleRate < CHALLENGE_MIN_SEC) {
    c.phase = 'retry'; c.pending = undefined;
    c.note = clip ? `The recording was shorter than ${CHALLENGE_MIN_SEC} s. Please record again.` : rec.broken ?? 'No audio was captured. Please record again.';
    render();
    return;
  }
  c.pending = { wav: encodeWav(clip.samples, clip.sampleRate), startMs: clip.startMs, endMs: clip.endMs, transcript, opId: operationId() };
  await submitChallenge();
}

async function submitChallenge(): Promise<void> {
  const c = challenge, p = c?.pending;
  if (!c || !p) return;
  c.phase = 'uploading'; c.note = 'Uploading…'; render();
  try {
    await api.submitChallenge(target.auth, target.sessionId, c.id, p.wav, p.startMs, p.endMs, p.transcript, p.opId);
    c.phase = 'submitted'; c.pending = undefined;
    c.note = SpeechRecognitionCtor ? 'Submitted for review.' : 'Submitted for review. Your browser cannot transcribe; a reviewer will listen instead.';
    if (view?.status === 'ended' && capture) { capture.stop(); capture = undefined; }   // the interview is over: release the microphone
    void poll();
  } catch (error) {
    c.phase = 'retry';
    c.note = `Upload failed: ${message(error)}. "Retry upload" resends the same recording.`;
  }
  render();
}

function wireChallenge(): void {
  $('challenge-record').addEventListener('click', () => void startChallenge());
  $('challenge-stop').addEventListener('click', () => void stopChallenge());
  $('challenge-retry').addEventListener('click', () => void submitChallenge());
}

// ---------------------------------------------------------------- gesture check
let gestureRun: { id: string; label: string; icon: string; deadlinePerf: number; phase: 'watching' | 'reporting' | 'done';
  note: string; doneAt?: number; progress?: GestureProgress; cancel: { cancelled: boolean } } | undefined;
let gesturePreloaded = false;

function renderGesture(v: CandidateView): void {
  const pg = v.pendingGesture;
  if (pg && gestureRun?.id !== pg.id) void runGesture(pg);
  // Preload the detector once the interview is live with the camera on, so the 30 s are not spent downloading.
  if (!gesturePreloaded && v.status === 'live' && v.consent?.camera && capture?.videoTrack) { gesturePreloaded = true; loadRecognizer().catch(() => { gesturePreloaded = false; }); }
  const r = gestureRun;
  const visible = !!r && (r.phase !== 'done' || performance.now() - (r.doneAt ?? 0) < 8000);
  show('gesture', visible);
  if (!r || !visible) return;
  $('gesture-prompt').textContent = `${r.icon} ${r.label}`;
  const left = Math.max(0, Math.ceil((r.deadlinePerf - performance.now()) / 1000));
  const p = r.progress;
  $('gesture-countdown').textContent = r.phase !== 'watching' ? ''
    : `${left} s left · ${!p || !p.frames ? 'Starting the camera check…' : !p.handFrames ? 'Looking for your hand — keep it inside the camera view.' : p.matchedFrames > 0 ? 'Got it — hold still…' : p.seeing ? `Seeing: ${p.seeing}` : 'Hand found — show the gesture clearly.'}`;
  const status = $('gesture-status');
  status.hidden = !r.note; status.textContent = r.note;
}

async function runGesture(pg: NonNullable<CandidateView['pendingGesture']>): Promise<void> {
  if (gestureRun) gestureRun.cancel.cancelled = true;
  const prompt = GESTURE_PROMPT[pg.gesture];
  const run = { id: pg.id, label: prompt?.text ?? pg.label, icon: prompt?.icon ?? '✋', deadlinePerf: performance.now() + (pg.deadlineMs - clock.now()),
    phase: 'watching' as 'watching' | 'reporting' | 'done', note: '', doneAt: undefined as number | undefined, progress: undefined as GestureProgress | undefined, cancel: { cancelled: false } };
  gestureRun = run; render();
  const outcome = await watchGesture($<HTMLVideoElement>('preview'), pg.gesture, run.deadlinePerf, (p) => { run.progress = p; }, run.cancel);
  if (run.cancel.cancelled) return;
  run.phase = 'reporting'; run.note = 'Sending the result…'; render();
  const body = { status: outcome.status, detectedAtMs: outcome.detectedAtPerf !== undefined ? clock.now(outcome.detectedAtPerf) : undefined,
    confidence: outcome.confidence, observed: outcome.observed, frames: outcome.frames, handFrames: outcome.handFrames, reason: outcome.reason, snapshot: outcome.snapshot };
  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try { await api.reportGesture(target.auth, target.sessionId, pg.id, body); sent = true; }
    catch (error) { if (error instanceof ApiError && error.status < 500 && error.status !== 429) break; await sleep(1000 * 2 ** attempt); }
  }
  run.phase = 'done'; run.doneAt = performance.now();
  run.note = !sent ? 'The result could not be sent. Your interviewer will follow up.'
    : outcome.status === 'performed' ? 'Thank you — done.'
      : outcome.status === 'unavailable' ? `We could not check the gesture: ${outcome.reason ?? 'camera unavailable'}. Your interviewer will follow up.`
        : 'Time is up.';
  render();
}

// ---------------------------------------------------------------- interview controls
function wireInterview(): void {
  const id = () => target.sessionId, auth = () => target.auth;
  $('ctl-start').addEventListener('click', () => {
    void ensureCapture().then(() => act(() => api.control(auth(), id(), 'start')));
  });
  $('ctl-pause').addEventListener('click', () => {
    closeSegment('Interview paused');
    void act(() => api.control(auth(), id(), 'pause'));
  });
  $('ctl-resume').addEventListener('click', () => {
    void (capture?.resume() ?? ensureCapture()).then(() => act(() => api.control(auth(), id(), 'resume')));
  });
  $('ctl-end').addEventListener('click', async () => {
    if (!window.confirm('End the interview? You cannot restart it.')) return;
    closeSegment();
    await waitForQueue(10000);   // let the last window reach the server before the session ends
    await act(() => api.control(auth(), id(), 'end'));
  });
  $('answer-start').addEventListener('click', () => {
    const v = view;
    const q = v?.questions.find((x) => !v.answeredQuestionIds.includes(x.id));
    if (!q) return;
    segment?.flush(true);   // windows align to the answer boundary
    void act(() => api.startAnswer(auth(), id(), q.id));
  });
  $('answer-end').addEventListener('click', () => {
    segment?.flush(true);
    void act(() => api.endAnswer(auth(), id()));
  });
  $('reconnect').addEventListener('click', () => void reconnect());
  $('permission-retry').addEventListener('click', () => { permissionProblem = undefined; void reconnect(); });
  $('camera-retry').addEventListener('click', () => {
    if (view?.status === 'live') closeSegment('Restarting camera');
    capture?.stop(); capture = undefined;
    void ensureCapture().then(() => openSegment('Camera restarted'));
  });
}

// ---------------------------------------------------------------- thumbnails & meters
function startThumbnails(): void {
  const canvas = document.createElement('canvas');
  let thumbFailures = 0;
  setInterval(() => {
    const v = view, video = $<HTMLVideoElement>('preview');
    if (!v || v.status !== 'live' || !v.consent?.camera || !capture?.videoTrack || document.hidden) return;
    if (!video.videoWidth || !video.videoHeight) return;
    const atMs = clock.now();
    canvas.width = 160; canvas.height = Math.round(160 * video.videoHeight / video.videoWidth);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      api.thumbnail(target.auth, target.sessionId, blob, atMs).catch((error) => {
        if (++thumbFailures === 3) showError(`Camera snapshots are failing: ${message(error)}`);
      });
    }, 'image/jpeg', 0.6);
  }, THUMB_MS);
}

/** Short independent video clips on the session clock while live (visual context for the reviewer
 * around flagged intervals; never detection evidence). Follows the capture/camera lifecycle. */
let videoRecorder: VideoContextRecorder | undefined;
function startVideoContext(): void {
  let warned = false;
  const sync = () => {
    const track = capture?.videoTrack;
    const wanted = view?.status === 'live' && !!view.consent?.camera && !!track && track.readyState === 'live';
    if (videoRecorder && (!wanted || videoRecorder.track !== track)) {
      void videoRecorder.stop(); videoRecorder = undefined;
    }
    if (wanted && !videoRecorder) {
      videoRecorder = new VideoContextRecorder(target.auth, target.sessionId, clock, track!, {
        onError: (text) => { if (!warned) { warned = true; showError(text); } },
      });
      videoRecorder.start();
    }
  };
  setInterval(sync, 1000);
}

function startMeters(): void {
  const enrollMeter = $('enroll-meter'), liveMeter = $('live-meter');
  const frame = () => {
    const width = `${Math.round(meterFraction(capture?.healthy ? capture.level : 0) * 100)}%`;
    enrollMeter.style.width = width; liveMeter.style.width = width;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Countdowns (challenge expiry) between polls.
  setInterval(() => { if (view?.pendingChallenge || challenge?.phase === 'recording' || opening || gestureRun) render(); }, 500);
}

// ---------------------------------------------------------------- boot
async function main(): Promise<void> {
  const parsed = candidateFromHash();
  if (!parsed) { show('loading', false); show('nolink', true); return; }
  target = parsed;
  wireConsent(); wireEnrollment(); wireChallenge(); wireInterview(); wireReevaluation();
  try {
    clock = await SessionClock.sync(target.auth, target.sessionId);
  } catch (error) {
    show('loading', false);

    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) { linkInvalid(); return; }
    const box = $('nolink');
    const retry = el('button', { class: 'primary', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => location.reload());
    box.replaceChildren(el('h2', {}, 'Cannot reach the interview server'),
      el('p', {}, `Check your internet connection, then try again. (${message(error)})`), el('div', { class: 'row' }, retry));
    show('nolink', true);
    return;
  }
  startMeters();
  startThumbnails();
  startVideoContext();
  window.addEventListener('beforeunload', (event) => { if (queue.length || recording) event.preventDefault(); });
  await poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
}

void main();
