/** Reviewer view for one session (?s=<id>). Polls every 2 s; pauses while a form field is focused.
 * The system never rejects a candidate: it surfaces signals and a reviewer decides. */
import { api, ApiError, el, fmtMs, GESTURE_LABEL, JOIN_LABEL, mediaUrl, requireReviewer, REVIEW_STATUS_LABEL } from './api.js';
import type { ChallengeView, GestureCheckView, GestureName, ReviewerView, ReviewRequestView, VoiceSignalView, WindowView } from './api.js';
import type { ReviewerResolution, Segment } from '../../src/shared/contracts.js';
import {
  $, authenticityIndicator, badge, clear, consentSummary, copyButton, coverageBadge, downloadExport, errorText, flaggedIds,
  fmtEpoch, fmtRange, fmtSec, notice, provenanceBadge, providerLine, reasonText, sessionIdFromQuery, speakerIndicator,
  stateBadge, table, windowTone,
} from './render.js';

const auth = await requireReviewer();
const token = 'reviewerToken' in auth ? auth.reviewerToken : '';
const sessionId = sessionIdFromQuery();
const app = $('app');
clear(app);

const sections = {
  header: el('section', { class: 'panel review-header', id: 'header' }),
  status: el('section', { class: 'panel review-status', id: 'status' }),
  enrollment: el('section', { class: 'panel review-enrollment', id: 'enrollment' }),
  coverage: el('section', { class: 'panel review-coverage', id: 'coverage' }),
  timeline: el('section', { class: 'panel review-timeline', id: 'timeline' }),
  evidence: el('section', { class: 'panel review-evidence', id: 'evidence' }),
  challenges: el('section', { class: 'panel review-challenges', id: 'challenges' }),
  gestures: el('section', { class: 'panel review-gestures', id: 'gestures' }),
  signals: el('section', { class: 'panel review-signals', id: 'signals' }),
  moment: el('section', { class: 'panel review-moment', id: 'moment' }),
  danger: el('section', { class: 'panel review-danger', id: 'danger' }),
};
const pollError = el('div', {});
/** Live-refresh status and "new response" notices. */
const liveNote = el('div', { class: 'muted', 'aria-live': 'polite' });
const banner = el('div', { 'aria-live': 'polite' });
let lastUpdated = 0, stopPolling = false;
const seenReviewStatus = new Map<string, string>();
let current: ReviewerView | undefined;
let selectedWindowId: string | undefined;
const signatures = new Map<string, string>();
const media = new Map<string, Promise<string>>();

/** Re-renders a section only when its data changed, so audio players and half-typed forms survive polls. */
function renderIf(key: keyof typeof sections, data: unknown, fn: (node: HTMLElement) => void): void {
  const sig = JSON.stringify(data);
  if (signatures.get(key) === sig) return;
  // Never wipe a field the reviewer is typing in; this section catches up on the next refresh.
  if (formFocusedIn(sections[key])) return;
  signatures.set(key, sig);
  clear(sections[key]);
  fn(sections[key]);
}

function reviewerName(): string { try { return localStorage.getItem('sg.reviewerName') ?? ''; } catch { return ''; } }
function rememberReviewer(name: string): void { try { localStorage.setItem('sg.reviewerName', name); } catch { /* optional */ } }

/** Reviewer-only media, fetched with the reviewer header into an object URL (never a public URL). */
function mediaNode(name: string | undefined, kind: 'audio' | 'img' | 'video', label: string): HTMLElement {
  const box = el('div', {}, el('div', { class: 'muted' }, label));
  if (!name || !sessionId) { box.append(el('div', { class: 'muted' }, 'Media not available (deleted or purged under the retention policy).')); return box; }
  let p = media.get(name);
  if (!p) { p = mediaUrl(auth, sessionId, name); media.set(name, p); p.catch(() => media.delete(name)); }
  p.then((url) => {
    if (kind === 'audio') box.append(el('audio', { controls: '', preload: 'none', src: url }));
    else if (kind === 'video') box.append(el('video', { controls: '', preload: 'metadata', playsinline: '', muted: '', src: url }));
    else box.append(el('img', { src: url, alt: label }));
  }).catch((e) => box.append(el('div', { class: 'muted' }, errorText(e))));
  return box;
}

function sortedWindows(view: ReviewerView): WindowView[] {
  return [...view.windows].sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence);
}

function select(windowId: string): void {
  selectedWindowId = windowId;
  if (current) renderEvidence(current);
  sections.evidence.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- header ----------
const JOIN_TONE = { waiting_for_candidate: 'gap', ready_to_join: 'ok', in_progress: 'info', completed: 'gap', not_applicable: 'gap' } as const;

async function join(): Promise<void> {
  if (!sessionId) return;
  clear(joinStatus);
  try { render(await api.join(auth, sessionId, reviewerName() || 'Interviewer')); }
  catch (e) {
    const text = e instanceof ApiError && e.code === 'interview_completed' ? 'This interview has already been completed. Its evidence is below.'
      : e instanceof ApiError && e.status === 404 ? 'This interview no longer exists or the link is wrong. Go back to the dashboard.'
        : `Could not join: ${errorText(e)}. Check your connection and try again.`;
    joinStatus.append(notice(text, 'bad'));
  }
}
const joinStatus = el('div', {});

function interviewControls(view: ReviewerView): HTMLElement {
  const row = el('div', { class: 'row' });
  const control = (label: string, action: 'start' | 'pause' | 'resume' | 'end', cls = '') => {
    const b = el('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', async () => {
      if (!sessionId) return;
      if (action === 'end' && !confirm('End the interview for both of you? It cannot be restarted.')) return;
      b.disabled = true; clear(joinStatus);
      try { await api.reviewerControl(auth, sessionId, action); render(await api.reviewer(auth, sessionId)); }
      catch (e) { joinStatus.append(notice(errorText(e), 'bad')); b.disabled = false; }
    });
    return b;
  };
  if (view.status === 'ready') row.append(control('Start interview', 'start', 'primary'));
  if (view.status === 'live') row.append(control('Pause', 'pause'));
  if (view.status === 'paused') row.append(control('Resume', 'resume', 'primary'));
  if (view.status === 'live' || view.status === 'paused') row.append(control('End interview', 'end', 'danger'));
  return row;
}

function renderHeader(view: ReviewerView): void {
  renderIf('header', [view.displayName, view.status, view.kind, view.candidateUrl, view.consent, view.sandbox, view.joinStatus, view.interviewer?.reviewerId, view.interviewer?.joinedAtMs, view.candidateConnected], (node) => {
    const link = location.origin + view.candidateUrl;
    node.append(
      el('span', { class: 'eyebrow' }, 'INTERVIEW / SESSION REVIEW'),
      el('div', { class: 'row' }, el('span', { class: 'big' }, view.displayName), badge(JOIN_LABEL[view.joinStatus], JOIN_TONE[view.joinStatus]), badge(view.kind, 'gap')),
      el('div', { class: 'muted' }, `Started ${fmtEpoch(view.createdAtEpochMs)} · ${view.questions.length} interview questions`),
      el('div', { class: 'row' }, el('span', {}, 'Invite the candidate privately'), copyButton(() => link, 'Copy candidate link')),
      el('div', {}, el('strong', {}, 'Consent: '), consentSummary(view)),
    );
    if (view.sandbox) node.append(el('div', { class: 'muted' }, `Sandbox scenario ${view.sandbox.scenario} · expected label "${view.sandbox.label}" (display only, never used by detection)`));
    if (view.kind === 'interview') {
      const candidateLine = view.candidateConnected ? 'Candidate connected' : view.joinStatus === 'waiting_for_candidate' ? 'Candidate has not opened the link yet, or is still setting up' : 'Candidate not connected right now';
      if (view.joinStatus === 'completed') node.append(notice('This interview is completed. Review the evidence below.'));
      else if (!view.interviewer) {
        const joinBtn = el('button', { type: 'button', class: 'primary' }, 'Join interview');
        joinBtn.addEventListener('click', () => { joinBtn.disabled = true; void join().finally(() => { joinBtn.disabled = false; }); });
        node.append(el('div', { class: 'row' }, joinBtn, el('span', { class: 'muted' }, `${candidateLine}.`)));
      } else {
        node.append(el('div', { class: 'muted' }, `Joined by ${view.interviewer.reviewerId} at ${fmtMs(view.interviewer.joinedAtMs)} · ${candidateLine}. You and the candidate are in the same session (${view.sessionId}).`));
        if (view.joinStatus === 'waiting_for_candidate') node.append(el('div', { class: 'muted' }, 'The interview can start once the candidate has consented and recorded their voice reference.'));
        node.append(interviewControls(view));
      }
      node.append(joinStatus);
    }
  });
}

// ---------- current status ----------
function renderStatus(view: ReviewerView): void {
  const d = view.decision;
  const latest = d.latestWindowId ? view.windows.find((w) => w.id === d.latestWindowId) : undefined;
  const result = latest?.result;
  const ageMs = view.checkAgeMs;
  renderIf('status', [d, ageMs === undefined ? null : Math.floor(ageMs / 1000), latest?.id, result?.provenance], (node) => {
    node.append(
      el('h2', {}, view.decision.state === 'monitoring_interrupted' ? 'Monitoring interrupted · last recorded signals' : 'Latest voice signals'),
      el('div', { class: 'row' }, stateBadge(d.state)),
      el('ul', {}, ...d.reasons.map((r) => el('li', {}, reasonText(r)))),
      el('div', { class: 'grid' },
        el('div', { class: 'panel' }, speakerIndicator(result?.speaker ?? d.speaker)),
        el('div', { class: 'panel' }, authenticityIndicator(result?.authenticity ?? d.authenticity, result?.raw))),
      el('div', { class: 'row' },
        el('span', {}, 'Latest completed check: '),
        ageMs === undefined ? badge('none yet', 'gap') : badge(`${Math.round(ageMs / 1000)} s ago`, ageMs > 25_000 ? 'warn' : 'ok'),
        el('span', {}, ` · pending checks: ${d.pending}`),
        el('span', {}, ' · provenance: '), provenanceBadge(result?.provenance)),
      latest ? el('div', { class: 'muted' }, `Latest window #${latest.sequence}: ${fmtRange(latest.startMs, latest.endMs)}`) : '',
      notice('The system never rejects a candidate; a reviewer decides.'),
    );
  });
}

// ---------- enrollment ----------
function renderEnrollment(view: ReviewerView): void {
  renderIf('enrollment', [view.enrollment, view.enrollmentAttempts], (node) => {
    node.append(el('h2', {}, 'Enrollment'));
    const ref = view.enrollment;
    if (ref) {
      node.append(el('div', {}, `Reference ${ref.id} · enrolled at ${fmtMs(ref.enrolledAtMs)} · reference authenticity: `,
        badge(ref.authenticity, ref.authenticity === 'real' ? 'ok' : ref.authenticity === 'fake' ? 'bad' : 'warn')));
      if (ref.deletedAtMs !== undefined) node.append(notice(`Speaker profile deleted at ${fmtMs(ref.deletedAtMs)}; monitoring cannot continue against it.`, 'warn'));
      node.append(providerLine(ref.provider));
    } else node.append(el('p', { class: 'muted' }, 'No accepted reference yet.'));
    if (view.enrollmentAttempts.length) {
      node.append(table(['At', 'Duration', 'Local voiced', 'Authenticity', 'Outcome', 'Reason'], view.enrollmentAttempts.map((a) => [
        fmtMs(a.atMs), fmtSec(a.durationMs), `${a.localVoicedSec.toFixed(1)} s`,
        a.authenticity ? badge(a.authenticity.verdict ?? `${a.authenticity.status}${a.authenticity.error ? `: ${a.authenticity.error.code}` : ''}`,
          a.authenticity.verdict === 'real' ? 'ok' : a.authenticity.verdict === 'fake' ? 'bad' : 'warn') : badge('not checked', 'gap'),
        a.enrolled ? badge('accepted', 'ok') : badge('rejected', 'bad'), a.reason,
      ])));
    }
  });
}

// ---------- coverage ----------
function renderCoverage(view: ReviewerView): void {
  renderIf('coverage', [view.coverage, view.interruptions], (node) => {
    const c = view.coverage;
    node.append(el('h2', {}, 'Coverage'),
      el('div', { class: 'row' }, badge(`checked ${fmtSec(c.checkedMs)}`, 'ok'), badge(`skipped ${fmtSec(c.skippedMs)}`, 'gap'),
        badge(`failed ${fmtSec(c.failedMs)}`, 'gap'), badge(`pending ${fmtSec(c.pendingMs)}`, 'info')));
    node.append(el('div', {}, el('strong', {}, 'Gaps: '), c.gaps.length ? c.gaps.map((g) => fmtRange(g.startMs, g.endMs)).join(', ') : 'none listed'));
    node.append(el('div', {}, el('strong', {}, 'Interruptions:')));
    if (!view.interruptions.length) node.append(el('p', { class: 'muted' }, 'None reported.'));
    else node.append(table(['Time', 'Kind', 'Reason'], view.interruptions.map((i) => [fmtMs(i.atMs), badge(i.kind, i.kind === 'interrupted' ? 'gap' : 'info'), i.reason])));
  });
}

// ---------- answer timeline ----------
function renderTimeline(view: ReviewerView): void {
  const flagged = flaggedIds(view);
  const windows = sortedWindows(view);
  const span = Math.max(...windows.map((w) => w.endMs), ...view.answers.map(a => a.endMs), view.openAnswer ? view.nowMs : 0, 1);
  renderIf('timeline', [Math.floor(span / 2000), windows.map((w) => [w.id, w.coverage, windowTone(w, flagged)]), view.answers, view.openAnswer, view.evidence.map((e) => e.id), view.speakers], (node) => {
    node.append(el('div', { class: 'panel-heading' }, el('h2', {}, 'The conversation, in context'), badge(`${windows.length} windows`, 'gap')),
      el('div', { class: 'muted' }, `Session 0:00 – ${fmtMs(span)}. Green = checked, no flag · red = flagged · orange = partial/inconclusive/not sure · blue = pending · hatched = skipped/failed (gap). Click a segment for details.`));
    const bar = el('div', { class: 'timeline', role: 'group', 'aria-label': 'Analyzed audio windows' });
    for (const w of windows) {
      const tone = windowTone(w, flagged);
      const seg = el('div', { class: `seg ${tone}`, role: 'button', tabindex: '0', title: `#${w.sequence} ${fmtRange(w.startMs, w.endMs)} · ${w.coverage}${flagged.has(w.id) ? ' · flagged' : ''}` });
      seg.style.left = `${(w.startMs / span) * 100}%`;
      seg.style.width = `${Math.max(0.3, ((w.endMs - w.startMs) / span) * 100)}%`;
      seg.addEventListener('click', () => select(w.id));
      seg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(w.id); } });
      bar.append(seg);
    }
    const answersBar = el('div', { class: 'timeline' });
    answersBar.style.height = '14px';
    for (const a of [...view.answers, ...(view.openAnswer ? [{ ...view.openAnswer, endMs: view.nowMs }] : [])]) {
      const seg = el('div', { class: 'seg pending', title: `${view.questions.find((q) => q.id === a.questionId)?.text ?? a.questionId}: ${fmtRange(a.startMs, a.endMs)}` });
      seg.style.left = `${(a.startMs / span) * 100}%`;
      seg.style.width = `${Math.max(0.3, ((a.endMs - a.startMs) / span) * 100)}%`;
      answersBar.append(seg);
    }
    node.append(bar, el('div', { class: 'muted' }, 'Answer intervals:'), answersBar);

    // Who is speaking (local estimate): one colour per person.
    const sp = view.speakers;
    if (sp.turns.length) {
      const voices = el('div', { class: 'timeline', role: 'group', 'aria-label': 'Who is speaking' });
      voices.style.height = '22px';
      for (const t of sp.turns) {
        const seg = el('div', { class: `seg ${personSeg(t.person)}`, role: 'button', tabindex: '0', title: `${personName(t.person)} · ${fmtRange(t.startMs, t.endMs)}` });
        seg.style.left = `${(t.startMs / span) * 100}%`;
        seg.style.width = `${Math.max(0.3, ((t.endMs - t.startMs) / span) * 100)}%`;
        seg.addEventListener('click', () => watch(t.startMs - 2000, t.endMs + 2000, `${personName(t.person)} speaking`));
        voices.append(seg);
      }
      node.append(el('div', { class: 'muted' }, 'Who is speaking (local estimate — click to watch):'), voices,
        el('div', { class: 'row' }, ...sp.people.map((p) => badge(`${p.label}${p.seconds ? ` · ${p.seconds.toFixed(0)} s` : ''}`, personTone(p.person))), sp.several ? badge(`Several at once · ${sp.several.toFixed(0)} s`, 'gap') : ''),
        el('div', { class: 'muted' }, sp.note));
      if (sp.people.length > 1) node.append(notice(`${sp.people.length} different voices were heard in this session.`, 'warn'));
    }

    const rows: Array<Array<Node | string>> = [];
    for (const q of view.questions) {
      const answers = view.answers.filter((a) => a.questionId === q.id);
      const open = view.openAnswer?.questionId === q.id ? view.openAnswer : undefined;
      if (!answers.length && !open) { rows.push([q.text, el('span', { class: 'muted' }, 'not answered'), '–', '–', '–']); continue; }
      for (const a of answers) rows.push(answerRow(view, q.text, a.id, fmtRange(a.startMs, a.endMs)));
      if (open) rows.push(answerRow(view, q.text, open.id, `${fmtMs(open.startMs)} – (in progress)`));
    }
    node.append(table(['Question', 'Time', 'Windows', 'Flags', 'Speakers'], rows));
  });
}

function answerRow(view: ReviewerView, text: string, answerId: string, range: string): Array<Node | string> {
  const windows = view.windows.filter((w) => w.answerIds.includes(answerId));
  const flags = view.evidence.filter((e) => e.answerIds.includes(answerId));
  let flagCell: Node | string = '0';
  if (flags.length) {
    const reasons = [...new Set(flags.flatMap((f) => f.reasons))].map(reasonText).join('; ');
    const button = el('button', { type: 'button', class: 'danger' }, `${flags.length} flag${flags.length > 1 ? 's' : ''}: ${reasons}`);
    button.addEventListener('click', () => select(flags[0]!.windowId));
    flagCell = button;
  }
  return [text, range, String(windows.length), flagCell, speakersCell(view, answerId)];
}

function speakersCell(view: ReviewerView, answerId: string): Node | string {
  const a = view.speakers.answers.find((x) => x.answerId === answerId);
  if (!a || a.verdict === 'unclear') return el('span', { class: 'muted' }, a ? 'Too little speech to tell' : '–');
  const who = a.people.filter((p) => p.seconds >= 1.5).map((p) => badge(`${personName(p.person)} ${p.seconds.toFixed(0)} s`, personTone(p.person)));
  const box = el('div', {}, el('div', { class: 'row' }, ...who));
  if (a.verdict === 'split') {
    const sw = a.switches[0];
    box.append(badge(`Split answer${sw ? `: ${personName(sw.from)} → ${personName(sw.to)} at ${fmtMs(sw.atMs)}` : ''}`, 'bad'));
    if (sw) box.append(watchButton(sw.atMs - 5000, sw.atMs + 5000, `Voice switch in this answer: ${personName(sw.from)} → ${personName(sw.to)}`, 'Watch the switch'));
  } else if (a.verdict === 'other_person') {
    box.append(badge(`Answered by ${personName(a.people[0]!.person)}, not the enrolled voice`, 'bad'), watchButton(a.startMs, Math.min(a.endMs, a.startMs + 15000), 'Answer given by another voice', 'Watch'));
  }
  return box;
}

// ---------- exact-moment video ----------
const PERSON_TONE = ['gap', 'ok', 'bad', 'warn', 'info'] as const;
const personTone = (p: number) => (p === 0 ? 'gap' : PERSON_TONE[p] ?? 'info');
const SEG_TONE = ['gap', 'ok', 'bad', 'warn', 'pending'] as const;
const personSeg = (p: number) => (p === 0 ? 'gap' : SEG_TONE[p] ?? 'pending');
const personName = (p: number) => (p === 0 ? 'Several voices' : `Person ${p}`);
let moment: { startMs: number; endMs: number; title: string } | undefined;

/** Opens the player for one moment (flag, voice change, speaker switch) and scrolls to it. */
function watch(startMs: number, endMs: number, title: string): void {
  moment = { startMs: Math.max(0, startMs), endMs, title };
  signatures.delete('moment');
  if (current) renderMoment(current);
  sections.moment.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function watchButton(startMs: number, endMs: number, title: string, label = 'Watch'): HTMLButtonElement {
  const b = el('button', { type: 'button' }, label);
  b.addEventListener('click', () => watch(startMs, endMs, title));
  return b;
}

function renderMoment(view: ReviewerView): void {
  const m = moment;
  const clips = m ? (view.videoClips ?? []).filter((c) => c.endMs > m.startMs && c.startMs < m.endMs).sort((a, b) => a.startMs - b.startMs) : [];
  renderIf('moment', [m, clips.map((c) => c.mediaName)], (node) => {
    node.hidden = !m;
    if (!m) return;
    node.append(el('h2', {}, m.title), el('div', { class: 'muted' }, `Camera video for exactly ${fmtRange(m.startMs, m.endMs)} (session time). Visual context for a person — not automated detection.`));
    const turns = view.speakers.turns.filter((t) => t.endMs > m.startMs && t.startMs < m.endMs);
    if (turns.length) node.append(el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Voices:'), ...turns.map((t) => badge(`${personName(t.person)} ${fmtRange(Math.max(t.startMs, m.startMs), Math.min(t.endMs, m.endMs))}`, personTone(t.person)))));
    if (!clips.length) { node.append(notice('No camera video was kept for this moment (camera off or not allowed, browser could not record, or deleted under the retention policy).', 'warn')); return; }
    const gaps: Array<{ startMs: number; endMs: number }> = [];
    let cursor = m.startMs;
    for (const c of clips) { if (c.startMs > cursor + 200) gaps.push({ startMs: cursor, endMs: c.startMs }); cursor = Math.max(cursor, c.endMs); }
    if (cursor < m.endMs - 200) gaps.push({ startMs: cursor, endMs: m.endMs });
    const video = el('video', { controls: '', playsinline: '', muted: '', preload: 'auto' });
    const status = el('div', { class: 'muted' });
    const play = el('button', { type: 'button', class: 'primary' }, 'Play this moment');
    let index = 0, stopAtEnd = true;
    const sessionTime = () => clips[index]!.startMs + video.currentTime * 1000;
    const load = async (i: number, fromMs: number) => {
      index = i;
      const c = clips[i]!;
      let url = media.get(c.mediaName);
      if (!url) { url = mediaUrl(auth, sessionId!, c.mediaName); media.set(c.mediaName, url); url.catch(() => media.delete(c.mediaName)); }
      video.src = await url;
      await new Promise<void>((r) => { video.onloadedmetadata = () => r(); video.onerror = () => r(); });
      video.currentTime = Math.max(0, (fromMs - c.startMs) / 1000);
    };
    video.addEventListener('timeupdate', () => {
      const t = sessionTime();
      status.textContent = `Now at ${fmtMs(t)} · clip ${index + 1} of ${clips.length}`;
      if (stopAtEnd && t >= m.endMs) { video.pause(); status.textContent = `End of the moment (${fmtMs(m.endMs)}).`; }
    });
    video.addEventListener('ended', () => {
      if (index + 1 < clips.length && clips[index + 1]!.startMs < m.endMs) void load(index + 1, clips[index + 1]!.startMs).then(() => video.play()).catch(() => undefined);
    });
    video.addEventListener('seeking', () => { stopAtEnd = sessionTime() < m.endMs; });
    play.addEventListener('click', () => { stopAtEnd = true; void load(0, m.startMs).then(() => video.play()).catch((e) => { status.textContent = errorText(e); }); });
    void load(0, m.startMs).catch((e) => { status.textContent = errorText(e); });
    node.append(el('div', { class: 'row' }, play), video, status);
    if (gaps.length) node.append(el('div', { class: 'muted' }, `Not recorded: ${gaps.map((g) => fmtRange(g.startMs, g.endMs)).join(', ')}`));
  });
}

// ---------- evidence ----------
/** Clips overlapping the window ±5 s with explicit gaps (same rule as the server's ContextBuffer view). */
function videoContextFor(view: ReviewerView, w: { startMs: number; endMs: number }) {
  const requested = { startMs: Math.max(0, w.startMs - 5000), endMs: w.endMs + 5000 };
  const clips = (view.videoClips ?? []).filter((c) => c.endMs > requested.startMs && c.startMs < requested.endMs).sort((a, b) => a.startMs - b.startMs);
  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let cursor = requested.startMs;
  for (const c of clips) { if (c.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(c.startMs, requested.endMs) }); cursor = Math.max(cursor, c.endMs); }
  if (cursor < requested.endMs) gaps.push({ startMs: cursor, endMs: requested.endMs });
  return { requested, clips, gaps };
}

function renderEvidence(view: ReviewerView): void {
  const windows = sortedWindows(view);
  const index = windows.findIndex((w) => w.id === selectedWindowId);
  const w = index >= 0 ? windows[index] : undefined;
  const evidence = w ? view.evidence.filter((e) => e.windowId === w.id) : [];
  renderIf('evidence', [selectedWindowId, w, evidence, windows[index - 1]?.mediaName, windows[index + 1]?.mediaName,
    view.thumbnails.filter((t) => w && t.atMs >= w.startMs - 5000 && t.atMs <= w.endMs + 5000),
    w ? videoContextFor(view, w) : undefined], (node) => {
    node.append(el('h2', {}, 'Evidence workspace'));
    if (!view.evidence.length) node.append(el('p', { class: 'muted' }, 'No flagged windows in this session.'));
    else {
      const list = el('div', { class: 'row' }, el('span', {}, 'Flagged windows:'));
      for (const e of [...view.evidence].sort((a, b) => a.startMs - b.startMs)) {
        const b = el('button', { type: 'button', class: e.windowId === selectedWindowId ? 'primary' : 'danger' }, `${fmtRange(e.startMs, e.endMs)} (${e.resolutions.length} resolution${e.resolutions.length === 1 ? '' : 's'})`);
        b.addEventListener('click', () => select(e.windowId));
        list.append(b);
      }
      node.append(list);
    }
    if (!w) { node.append(el('p', { class: 'muted' }, 'Select a timeline segment or a flagged answer to inspect a window.')); return; }

    const flagged = flaggedIds(view);
    const answers = view.answers.filter((a) => w.answerIds.includes(a.id));
    node.append(
      el('div', { class: 'row' }, el('strong', {}, `Window #${w.sequence}: ${fmtRange(w.startMs, w.endMs)} (session time)`), coverageBadge(w, flagged), badge(w.purpose, 'gap'), badge(w.source, 'gap')),
      el('div', {}, el('strong', {}, 'Linked answers: '), answers.length
        ? answers.map((a) => `${view.questions.find((q) => q.id === a.questionId)?.text ?? a.questionId} (${fmtRange(a.startMs, a.endMs)})`).join('; ')
        : 'none (outside any answer)'),
    );
    if (w.reason) node.append(el('div', { class: 'muted' }, `Coverage reason: ${w.reason}`));
    if (w.submittedAtMs !== undefined && w.respondedAtMs !== undefined) node.append(el('div', { class: 'muted' }, `Processing latency ${Math.round(w.respondedAtMs - w.submittedAtMs)} ms`));
    for (const e of evidence) {
      node.append(notice(`Flag: ${e.reasons.map(reasonText).join('; ')} — raised at ${fmtMs(e.createdAtMs)}`, 'bad'));
      if (e.latestDisposition === 'escalate') node.append(notice('Escalated — waiting for a senior reviewer or hiring lead to decide. Record a later resolution when they do.', 'warn'));
    }

    const r = w.result;
    if (r) {
      node.append(el('div', { class: 'row' }, el('span', {}, 'Provenance:'), provenanceBadge(r.provenance)),
        el('div', { class: 'grid' },
          el('div', { class: 'panel' }, speakerIndicator(r.speaker, true)),
          el('div', { class: 'panel' }, authenticityIndicator(r.authenticity, r.raw, true), segmentsList(r.authenticity.status === 'complete' ? r.authenticity.segments : []))));
      const raw = el('details', {}, el('summary', {}, 'Raw provider response'), el('pre', { class: 'mono' }, JSON.stringify(r.raw, null, 2)));
      node.append(raw);
    } else node.append(el('p', { class: 'muted' }, 'No result for this window (pending, skipped, or failed). This is a gap, not a positive.'));

    node.append(el('h3', {}, 'Audio context'), el('div', { class: 'grid' },
      mediaNode(windows[index - 1]?.mediaName, 'audio', index > 0 ? `Previous window ${fmtRange(windows[index - 1]!.startMs, windows[index - 1]!.endMs)}` : 'Previous window: none'),
      mediaNode(w.mediaName, 'audio', `${evidence.length ? 'Flagged' : 'Selected'} window ${fmtRange(w.startMs, w.endMs)}`),
      mediaNode(windows[index + 1]?.mediaName, 'audio', index + 1 < windows.length ? `Next window ${fmtRange(windows[index + 1]!.startMs, windows[index + 1]!.endMs)}` : 'Next window: none')));

    const video = videoContextFor(view, w);
    node.append(el('div', { class: 'row' }, watchButton(w.startMs, w.endMs, `${evidence.length ? 'Flagged' : 'Selected'} window ${fmtRange(w.startMs, w.endMs)}`, 'Watch exactly this window')));
    node.append(el('h3', {}, 'Video context'), el('div', { class: 'muted' },
      `Short clips from ${fmtRange(video.requested.startMs, video.requested.endMs)} (5 s either side), on the same session clock. Visual context for a person — not automated lip-sync or detection evidence.`));
    if (!video.clips.length) node.append(el('p', { class: 'muted' }, 'No video retained for this interval (camera off or not consented, browser unsupported, or deleted by the rolling buffer / retention policy).'));
    else node.append(el('div', { class: 'grid' }, ...video.clips.map((c) => mediaNode(c.mediaName, 'video', `Clip ${fmtRange(c.startMs, c.endMs)}`))));
    if (video.clips.length && video.gaps.length) node.append(el('div', { class: 'muted' }, `Not recorded: ${video.gaps.map((g) => fmtRange(g.startMs, g.endMs)).join(', ')}`));

    const thumbs = view.thumbnails.filter((t) => t.atMs >= w.startMs - 5000 && t.atMs <= w.endMs + 5000);
    node.append(el('h3', {}, 'Camera thumbnails'), el('div', { class: 'muted' }, 'Navigation aid — not detection evidence.'));
    if (!thumbs.length) node.append(el('p', { class: 'muted' }, 'No thumbnails within 5 s of this window (camera off, not consented, or purged).'));
    else node.append(el('div', { class: 'thumbs' }, ...thumbs.map((t) => mediaNode(t.mediaName, 'img', fmtMs(t.atMs)))));

    for (const e of evidence) node.append(resolutionBlock(e.id, e.resolutions));
  });
}

function segmentsList(segments: Segment[]): HTMLElement {
  if (!segments.length) return el('div', { class: 'muted' }, 'No first-stage segments reported.');
  // The Detectif adapter already maps segment times into session time (window start + media offset).
  return el('div', {}, el('div', { class: 'muted' }, 'First-stage segments (supporting only — the final verdict above decides):'),
    el('ul', {}, ...segments.map((s) => el('li', { class: 'mono' }, `${fmtRange(s.startMs, s.endMs)} score ${s.score.toFixed(3)}`))));
}

function resolutionBlock(evidenceId: string, resolutions: ReviewerResolution[]): HTMLElement {
  const box = el('div', { class: 'panel' }, el('h3', {}, 'Reviewer resolutions'),
    el('div', { class: 'muted' }, 'Resolutions are recorded separately; the original flag always stays visible.'));
  if (!resolutions.length) box.append(el('p', { class: 'muted' }, 'None yet.'));
  else box.append(table(['At', 'Reviewer', 'Disposition', 'Notes'], [...resolutions].sort((a, b) => a.atMs - b.atMs)
    .map((r) => [fmtMs(r.atMs), r.reviewerId, r.disposition, r.notes])));
  const disposition = el('select', {},
    el('option', { value: 'request_reverification' }, 'Request re-verification'),
    el('option', { value: 'reviewed' }, 'Reviewed'),
    el('option', { value: 'escalate' }, 'Escalate'));
  const help = el('div', { class: 'muted' });
  const DISPOSITION_HELP: Record<string, string> = {
    request_reverification: 'Ask the candidate for a fresh voice response. This opens a re-evaluation request (with its own ID) and shows them a one-use phrase to read aloud; the result appears under Re-evaluation.',
    reviewed: 'You checked this flag and need nothing more. The flag stays on record with your note.',
    escalate: 'Hand this flag to a senior reviewer or hiring lead for a decision. Nothing happens to the candidate automatically; the session is marked "Escalated" on the dashboard until someone records a later resolution.',
  };
  const updateHelp = () => { help.textContent = DISPOSITION_HELP[disposition.value] ?? ''; };
  disposition.addEventListener('change', updateHelp); updateHelp();
  const notes = el('textarea', { required: '', placeholder: 'What did you hear or check? (required)' });
  const name = el('input', { type: 'text', required: '', value: reviewerName(), placeholder: 'Reviewer name' });
  const submit = el('button', { type: 'submit', class: 'primary' }, 'Record resolution');
  const status = el('div', {});
  const form = el('form', {}, el('label', {}, 'Disposition ', disposition), help, el('label', {}, 'Notes', notes), el('label', {}, 'Reviewer ', name), submit, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sessionId || !notes.value.trim() || !name.value.trim()) return;
    submit.disabled = true; clear(status);
    try {
      rememberReviewer(name.value.trim());
      const view = await api.resolve(auth, sessionId, evidenceId, { disposition: disposition.value as ReviewerResolution['disposition'], notes: notes.value.trim(), reviewerId: name.value.trim() });
      (document.activeElement as HTMLElement | null)?.blur();
      render(view);
    } catch (e) { status.append(notice(errorText(e), 'bad')); submit.disabled = false; }
  });
  box.append(form);
  return box;
}

// ---------- challenges ----------
const REVIEW_TONE = { awaiting_response: 'info', expired: 'gap', response_submitted: 'info', evaluated: 'warn', reviewed: 'ok', escalated: 'bad' } as const;

function renderChallenges(view: ReviewerView): void {
  renderIf('challenges', [view.reviewRequests, view.challenges, !!view.enrollment, view.enrollment?.deletedAtMs, view.kind], (node) => {
    const open = view.reviewRequests.find((r) => r.status === 'awaiting_response' || r.status === 'expired' || r.status === 'response_submitted');
    const issue = el('button', { type: 'button', class: 'primary' }, 'Request a fresh voice response');
    const status = el('div', {});
    if (!view.enrollment || view.enrollment.deletedAtMs !== undefined || view.kind !== 'interview' || open) issue.disabled = true;
    issue.addEventListener('click', async () => {
      if (!sessionId) return;
      issue.disabled = true; clear(status);
      try { render(await api.requestReevaluation<ReviewerView>(auth, sessionId, '', reviewerName() || undefined)); }
      catch (e) { status.append(notice(errorText(e), 'bad')); issue.disabled = false; }
    });
    node.append(el('h2', {}, 'Re-evaluation'),
      notice('Each request has its own ID. Every new voice response is saved as a new version with its transcript and evaluation, compared against the ORIGINAL reference. Earlier flags and versions are never erased.'),
      el('div', { class: 'row' }, issue), status);
    if (open) node.append(el('div', { class: 'muted' }, `Request ${open.id} is still open; a new one can start after it gets a response.`));
    const linked = new Set(view.reviewRequests.flatMap((r) => r.versions.map((v) => v.challengeId)));
    if (!view.reviewRequests.length) node.append(el('p', { class: 'muted' }, 'No re-evaluation requests yet. The candidate can also request one from their page.'));
    for (const rr of [...view.reviewRequests].sort((a, b) => b.createdAtMs - a.createdAtMs)) node.append(reviewRequestBlock(rr));
    const legacy = view.challenges.filter((c) => !linked.has(c.id));
    for (const c of legacy) node.append(challengeBlock(c));
  });
}

function reviewRequestBlock(rr: ReviewRequestView): HTMLElement {
  const box = el('div', { class: 'panel' });
  box.append(el('div', { class: 'row' }, el('strong', {}, rr.id), badge(REVIEW_STATUS_LABEL[rr.status], REVIEW_TONE[rr.status])),
    el('div', { class: 'muted' }, `Requested by ${rr.requestedBy === 'candidate' ? 'the candidate' : rr.requesterName ?? 'a reviewer'} at ${fmtMs(rr.createdAtMs)}${rr.evidenceId ? ' · linked to a flagged window' : ''}`),
    el('div', {}, el('strong', {}, 'Reason: '), rr.reason),
    el('div', { class: 'muted' }, rr.evaluationVersion ? `Latest evaluation: version ${rr.evaluationVersion} of ${rr.versions.length}` : `No evaluation yet · ${rr.versions.length} version${rr.versions.length === 1 ? '' : 's'}`));
  if (rr.evidenceId) {
    const view = current?.evidence.find((e) => e.id === rr.evidenceId);
    if (view) { const b = el('button', { type: 'button' }, 'Open the flagged window'); b.addEventListener('click', () => select(view.windowId)); box.append(el('div', { class: 'row' }, b)); }
  }
  for (const v of [...rr.versions].sort((a, b) => b.version - a.version)) {
    const head = el('div', { class: 'row' }, el('strong', {}, `Version ${v.version}`),
      el('span', { class: 'muted' }, v.submittedAtMs !== undefined ? `response at ${fmtMs(v.submittedAtMs)}` : `phrase issued at ${fmtMs(v.issuedAtMs)}`));
    box.append(head);
    if (v.challenge) box.append(challengeBlock(v.challenge));
  }
  if (rr.outcome) {
    box.append(notice(`${rr.outcome.outcome === 'escalated' ? 'Escalated to a senior reviewer / hiring lead' : 'Reviewed'} by ${rr.outcome.reviewerId} at ${fmtMs(rr.outcome.atMs)} — ${rr.outcome.notes}`, rr.outcome.outcome === 'escalated' ? 'warn' : ''));
    return box;
  }
  const status = el('div', {});
  if ((rr.status === 'evaluated' || rr.status === 'expired') && rr.versions.length < 3) {
    const again = el('button', { type: 'button' }, 'Ask for another response');
    again.addEventListener('click', async () => {
      if (!sessionId) return;
      again.disabled = true; clear(status);
      try { render(await api.newReviewVersion<ReviewerView>(auth, sessionId, rr.id)); }
      catch (e) { status.append(notice(errorText(e), 'bad')); again.disabled = false; }
    });
    box.append(el('div', { class: 'row' }, again));
  }
  const outcome = el('select', {}, el('option', { value: 'reviewed' }, 'Reviewed — close'), el('option', { value: 'escalated' }, 'Escalate to a senior reviewer / hiring lead'));
  const notes = el('textarea', { required: '', placeholder: 'What did you conclude? (required)' });
  const name = el('input', { type: 'text', required: '', value: reviewerName(), placeholder: 'Reviewer name' });
  const submit = el('button', { type: 'submit', class: 'primary' }, 'Close re-evaluation');
  const form = el('form', {}, el('label', {}, 'Outcome ', outcome), el('label', {}, 'Notes', notes), el('label', {}, 'Reviewer ', name), submit, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sessionId || !notes.value.trim() || !name.value.trim()) return;
    submit.disabled = true; clear(status);
    try {
      rememberReviewer(name.value.trim());
      const view = await api.closeReviewRequest(auth, sessionId, rr.id, { outcome: outcome.value as 'reviewed' | 'escalated', notes: notes.value.trim(), reviewerId: name.value.trim() });
      (document.activeElement as HTMLElement | null)?.blur();
      render(view);
    } catch (e) { status.append(notice(errorText(e), 'bad')); submit.disabled = false; }
  });
  box.append(form);
  return box;
}

function challengeBlock(c: ChallengeView): HTMLElement {
  const box = el('div', { class: 'panel' });
  box.append(el('div', { class: 'row' }, el('strong', {}, `“${c.phrase}”`), badge(c.status, c.status === 'checked' ? 'info' : c.status === 'expired' ? 'gap' : 'warn')),
    el('div', { class: 'muted' }, `Issued ${fmtMs(c.issuedAtMs)} · expires ${fmtMs(c.expiresAtMs)}${c.usedAtMs !== undefined ? ` · used ${fmtMs(c.usedAtMs)}` : ''}`));
  const transcript = c.transcript?.trim();
  box.append(el('div', {}, el('strong', {}, 'Transcript: '), transcript ? `“${transcript}” (${c.transcriptSource ?? 'unknown source'})` : 'no transcript — phrase not checked'));
  const pc = c.phraseComparison;
  if (pc && transcript) box.append(el('div', { class: 'muted' }, `Phrase comparison: matched ${pc.matchedWords}/${pc.totalWords} words`));

  const r = c.window?.result;
  const phrase = !transcript || !pc ? badge('Phrase: not checked', 'gap') : pc.matched ? badge('Phrase matched', 'ok') : badge('Phrase not matched', 'bad');
  const speaker = !r ? badge('Speaker: no result', 'gap') : r.speaker.status !== 'complete' ? badge(`Speaker: ${r.speaker.status}`, 'warn')
    : r.speaker.decision === 'match' ? badge('Speaker matched', 'ok') : badge('Speaker not matched', 'bad');
  const auth2 = !r ? badge('Authenticity: no result', 'gap') : r.authenticity.status !== 'complete' ? badge(`Authenticity: ${r.authenticity.status}`, 'warn')
    : badge(`Authenticity verdict: ${r.authenticity.verdict}`, r.authenticity.verdict === 'real' ? 'ok' : r.authenticity.verdict === 'fake' ? 'bad' : 'warn');
  box.append(el('div', { class: 'row' }, phrase, speaker, auth2, badge('Gesture: not implemented', 'gap')));

  if (c.window) {
    box.append(el('div', { class: 'grid' },
      el('div', {}, speakerIndicator(r?.speaker, true)),
      el('div', {}, authenticityIndicator(r?.authenticity, r?.raw, true))),
    el('div', { class: 'row' }, el('span', {}, 'Provenance:'), provenanceBadge(r?.provenance)),
    mediaNode(c.window.mediaName, 'audio', `Challenge recording ${fmtRange(c.window.startMs, c.window.endMs)}`));
  }

  if (c.reviewerAssist) {
    box.append(notice(`Reviewer-attested (not automatic): ${c.reviewerAssist.reviewerId} heard the phrase: ${c.reviewerAssist.phraseHeard ? 'yes' : 'no'} at ${fmtMs(c.reviewerAssist.atMs)} — ${c.reviewerAssist.notes}`, 'warn'));
  } else if (c.status === 'submitted' || c.status === 'checked') {
    const heard = el('select', {}, el('option', { value: 'yes' }, 'yes'), el('option', { value: 'no' }, 'no'));
    const notes = el('textarea', { required: '', placeholder: 'Notes (required)' });
    const name = el('input', { type: 'text', required: '', value: reviewerName(), placeholder: 'Reviewer name' });
    const submit = el('button', { type: 'submit' }, 'Record reviewer attestation');
    const status = el('div', {});
    const form = el('form', {}, el('div', { class: 'muted' }, 'Reviewer-assisted path — this is reviewer-attested, not an automatic check.'),
      el('label', {}, 'I listened: phrase heard ', heard), el('label', {}, 'Notes', notes), el('label', {}, 'Reviewer ', name), submit, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!sessionId || !notes.value.trim() || !name.value.trim()) return;
      submit.disabled = true; clear(status);
      try {
        rememberReviewer(name.value.trim());
        const view = await api.assistChallenge(auth, sessionId, c.id, { phraseHeard: heard.value === 'yes', notes: notes.value.trim(), reviewerId: name.value.trim() });
        (document.activeElement as HTMLElement | null)?.blur();
        render(view);
      } catch (e) { status.append(notice(errorText(e), 'bad')); submit.disabled = false; }
    });
    box.append(form);
  }
  return box;
}

// ---------- local voice screening ----------
function renderSignals(view: ReviewerView): void {
  renderIf('signals', [view.voiceSignals, view.voiceProfileReady, view.targetedChecks, view.kind], (node) => {
    node.append(el('h2', {}, 'Voice consistency'),
      el('div', { class: 'muted' }, 'Every window is also screened locally, in 1.5 s slices and across window joins, for a different voice or more than one voice. These are estimates. Each suspicious stretch is sent to DetectifAI as its own targeted check, and only that result can become evidence.'));
    if (!view.voiceProfileReady) { node.append(el('p', { class: 'muted' }, view.enrollment ? 'No local voice profile for this reference (too little clear speech); local screening is off.' : 'Local screening starts once the voice reference is accepted.')); return; }
    node.append(el('div', { class: 'row' }, badge(`targeted checks ${view.targetedChecks.used} / ${view.targetedChecks.max}`, view.targetedChecks.used >= view.targetedChecks.max ? 'warn' : 'gap')));
    if (!view.voiceSignals.length) { node.append(el('p', { class: 'muted' }, 'Nothing unusual found so far.')); return; }
    node.append(table(['When', 'Local estimate', 'Targeted DetectifAI check', ''], [...view.voiceSignals].sort((a, b) => a.startMs - b.startMs).map((sig) => signalRow(view, sig))));
  });
}

function signalRow(view: ReviewerView, sig: VoiceSignalView): Array<Node | string> {
  const kind = sig.kind === 'multiple_voices_suspected' ? badge('More than one voice?', 'warn') : badge('Different voice?', 'warn');
  const t = sig.targeted;
  let result: Node | string;
  if (!t) result = el('span', { class: 'muted' }, sig.targetedSkipped ?? 'Not checked');
  else if (t.coverage === 'pending') result = badge('Checking…', 'info');
  else if (!t.speaker && !t.authenticity) result = badge(`Check ${t.coverage}`, 'gap');
  else {
    const sp = t.speaker?.status === 'complete' ? badge(t.speaker.decision === 'match' ? 'Speaker matched' : 'Speaker not matched', t.speaker.decision === 'match' ? 'ok' : 'bad') : badge(`Speaker: ${t.speaker?.status ?? 'no result'}`, 'gap');
    const au = t.authenticity?.status === 'complete' ? badge(`Authenticity: ${t.authenticity.verdict}`, t.authenticity.verdict === 'real' ? 'ok' : t.authenticity.verdict === 'fake' ? 'bad' : 'warn') : badge(`Authenticity: ${t.authenticity?.status ?? 'no result'}`, 'gap');
    result = el('div', { class: 'row' }, sp, au, t.flagged ? badge('Flagged', 'bad') : '');
  }
  const open = el('button', { type: 'button' }, 'Inspect');
  open.addEventListener('click', () => select(t?.windowId ?? sig.windowIds.at(-1)!));
  const actions = el('div', { class: 'row' }, watchButton(sig.startMs - 1000, sig.endMs + 1000, `${sig.kind === 'multiple_voices_suspected' ? 'More than one voice' : 'Voice change'} at ${fmtRange(sig.startMs, sig.endMs)}`),
    view.windows.some((w) => w.id === (t?.windowId ?? sig.windowIds.at(-1))) ? open : '');
  return [fmtRange(sig.startMs, sig.endMs), el('div', {}, kind, el('div', { class: 'muted' }, sig.detail)), result, actions];
}

// ---------- gesture checks ----------
const GESTURE_TONE = { pending: 'info', completed: 'ok', suspicious: 'bad', unverified: 'warn' } as const;
const GESTURE_VERDICT = { pending: 'Waiting', completed: 'Performed', suspicious: 'Suspicious', unverified: 'Could not check' } as const;

function renderGestures(view: ReviewerView): void {
  const pending = view.gestureChecks.find((g) => g.verdict === 'pending');
  renderIf('gestures', [view.gestureChecks, view.status, view.consent?.camera, view.kind, pending ? Math.ceil((pending.deadlineMs - view.nowMs) / 1000) : 0], (node) => {
    if (view.kind !== 'interview') { node.hidden = true; return; }
    node.hidden = false;
    node.append(el('h2', {}, 'Camera gesture check'),
      el('div', { class: 'muted' }, 'Ask the candidate to make a gesture; they get 30 seconds. Detection runs in their browser on the live camera. A performed gesture shows a live person responding, but it is not proof of identity and does not override any voice result. A missed gesture is marked suspicious for you to review.'));
    const status = el('div', {});
    const canAsk = (view.status === 'live' || view.status === 'paused') && !!view.consent?.camera && !pending;
    const row = el('div', { class: 'row' });
    for (const g of [...Object.keys(GESTURE_LABEL), 'random'] as Array<GestureName | 'random'>) {
      const b = el('button', { type: 'button', class: g === 'random' ? 'primary' : '' }, g === 'random' ? 'Random gesture' : GESTURE_LABEL[g]);
      b.disabled = !canAsk;
      b.addEventListener('click', async () => {
        if (!sessionId) return;
        row.querySelectorAll('button').forEach((x) => { (x as HTMLButtonElement).disabled = true; }); clear(status);
        try { render(await api.requestGesture(auth, sessionId, g, reviewerName() || 'Interviewer')); }
        catch (e) { status.append(notice(errorText(e), 'bad')); row.querySelectorAll('button').forEach((x) => { (x as HTMLButtonElement).disabled = false; }); }
      });
      row.append(b);
    }
    node.append(row, status);
    if (!view.consent?.camera) node.append(notice('The candidate did not allow the camera, so gestures cannot be checked. Use a voice phrase re-evaluation instead.', 'warn'));
    else if (view.status !== 'live' && view.status !== 'paused') node.append(el('p', { class: 'muted' }, 'Available while the interview is in progress.'));
    if (pending) node.append(notice(`Waiting for “${pending.label}” — ${Math.max(0, Math.ceil((pending.deadlineMs - view.nowMs) / 1000))} s left.`));
    for (const g of [...view.gestureChecks].sort((a, b) => b.issuedAtMs - a.issuedAtMs)) node.append(gestureBlock(view, g));
  });
}

function gestureBlock(view: ReviewerView, g: GestureCheckView): HTMLElement {
  const box = el('div', { class: 'panel' });
  box.append(el('div', { class: 'row' }, el('strong', {}, g.label), badge(GESTURE_VERDICT[g.verdict], GESTURE_TONE[g.verdict])),
    el('div', { class: 'muted' }, `Asked by ${g.requestedBy} at ${fmtMs(g.issuedAtMs)} · deadline ${fmtMs(g.deadlineMs)}${g.report ? ` · result at ${fmtMs(g.report.reportedAtMs)}` : ''}`),
    g.verdict === 'pending' ? el('div', { class: 'muted' }, g.remark) : notice(g.remark, g.verdict === 'suspicious' ? 'bad' : g.verdict === 'unverified' ? 'warn' : ''));
  if (g.report?.frames !== undefined) box.append(el('div', { class: 'muted' }, `${g.report.frames} camera frames checked · hand visible in ${g.report.handFrames ?? 0}`));
  if (g.report?.snapshot) box.append(mediaNode(g.report.snapshot, 'img', 'Snapshot when the gesture was detected (from the candidate’s browser)'));
  const clips = (view.videoClips ?? []).filter((c) => c.endMs > g.issuedAtMs && c.startMs < Math.min(g.deadlineMs, g.report?.reportedAtMs ?? g.deadlineMs)).slice(0, 3);
  if (g.verdict !== 'pending') {
    if (clips.length) box.append(el('div', { class: 'grid' }, ...clips.map((c) => mediaNode(c.mediaName, 'video', `Video ${fmtRange(c.startMs, c.endMs)}`))));
    else box.append(el('div', { class: 'muted' }, 'No video retained for this check.'));
  }
  return box;
}

// ---------- danger zone ----------
function renderDanger(view: ReviewerView): void {
  renderIf('danger', [view.enrollment?.id, view.enrollment?.deletedAtMs], (node) => {
    const status = el('div', {});
    const delProfile = el('button', { type: 'button', class: 'danger' }, 'Delete speaker profile');
    if (!view.enrollment || view.enrollment.deletedAtMs !== undefined) delProfile.disabled = true;
    delProfile.addEventListener('click', async () => {
      if (!sessionId || !confirm('Delete the remote speaker profile? Monitoring will be interrupted for this session.')) return;
      delProfile.disabled = true;
      try { render(await api.deleteProfile(auth, sessionId)); } catch (e) { status.append(notice(errorText(e), 'bad')); delProfile.disabled = false; }
    });
    const delSession = el('button', { type: 'button', class: 'danger' }, 'Delete session and media');
    delSession.addEventListener('click', async () => {
      if (!sessionId || !confirm('Delete this session, all recordings and thumbnails, and the remote speaker profile? This cannot be undone.')) return;
      delSession.disabled = true;
      try { await api.deleteSession(auth, sessionId); location.href = '/'; } catch (e) { status.append(notice(errorText(e), 'bad')); delSession.disabled = false; }
    });
    const exp = el('button', { type: 'button' }, 'Export JSON');
    exp.addEventListener('click', async () => {
      if (!sessionId) return;
      try { await downloadExport(token, sessionId); } catch (e) { status.append(notice(errorText(e), 'bad')); }
    });
    node.append(el('h2', {}, 'Data and export'),
      el('div', { class: 'muted' }, `Media is reviewer-only and retained for ${view.retention.mediaRetentionHours} h.`),
      el('div', { class: 'row' }, exp, el('a', { href: `/report.html?s=${encodeURIComponent(view.sessionId)}` }, 'Printable report'), delProfile, delSession), status);
  });
}

function announce(view: ReviewerView): void {
  const fresh: string[] = [];
  for (const rr of view.reviewRequests) {
    const before = seenReviewStatus.get(rr.id);
    if (before !== undefined && before !== rr.status && (rr.status === 'response_submitted' || rr.status === 'evaluated')) {
      fresh.push(rr.status === 'evaluated' ? `New evaluation ready for ${rr.id} (version ${rr.evaluationVersion}).` : `New voice response received for ${rr.id} — evaluating.`);
    }
    if (before === undefined && current && rr.requestedBy === 'candidate') fresh.push(`The candidate requested a re-evaluation (${rr.id}).`);
    seenReviewStatus.set(rr.id, rr.status);
  }
  if (fresh.length) {
    clear(banner);
    const dismiss = el('button', { type: 'button' }, 'Show');
    dismiss.addEventListener('click', () => { clear(banner); sections.challenges.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    banner.append(el('div', { class: 'notice warn' }, fresh.join(' '), ' ', dismiss));
  }
  const waiting = view.reviewRequests.filter((r) => r.status === 'evaluated').length;
  document.title = `${waiting ? `(${waiting}) ` : ''}SwitchGuard · ${view.displayName}`;
}

function render(view: ReviewerView): void {
  announce(view);
  current = view;
  if (!selectedWindowId && view.evidence.length) selectedWindowId = view.evidence[0]!.windowId;
  renderHeader(view); renderStatus(view); renderEnrollment(view); renderCoverage(view);
  renderTimeline(view); renderSignals(view); renderMoment(view); renderEvidence(view); renderGestures(view); renderChallenges(view); renderDanger(view);
}

function formFocusedIn(node: HTMLElement): boolean {
  const a = document.activeElement;
  return !!a && node.contains(a) && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement);
}

async function poll(): Promise<void> {
  if (!sessionId || stopPolling) return;
  try {
    render(await api.reviewer(auth, sessionId)); clear(pollError);
    lastUpdated = Date.now();
  } catch (e) {
    clear(pollError);
    if (e instanceof ApiError && e.status === 404) {
      stopPolling = true;
      const back = el('a', { href: '/' }, 'Back to the dashboard');
      pollError.append(notice('This interview no longer exists (it may have been deleted), or the link is wrong. ', 'bad'), back);
      return;
    }
    const retry = el('button', { type: 'button' }, 'Retry now');
    retry.addEventListener('click', () => void poll());
    pollError.append(el('div', { class: 'notice bad' }, `Connection lost — retrying automatically. (${errorText(e)}) `, retry));
  }
  setTimeout(() => void poll(), 2000);
}
setInterval(() => {
  if (!lastUpdated || stopPolling) return;
  const s = Math.round((Date.now() - lastUpdated) / 1000);
  liveNote.textContent = s <= 3 ? 'Live · updated just now' : `Live · updated ${s} s ago`;
}, 1000);

if (!sessionId) app.append(notice('Missing session id. Open this page from the home list (reviewer.html?s=<id>).', 'bad'));
else {
  app.append(pollError, banner, liveNote, sections.header,
    el('div', { class: 'review-layout' },
      el('div', { class: 'review-main' }, sections.status, sections.timeline, sections.moment, sections.signals, sections.evidence),
      el('aside', { class: 'review-aside', 'aria-label': 'Verification and coverage' }, sections.gestures, sections.challenges, sections.coverage, sections.enrollment)),
    sections.danger);
  const params = new URLSearchParams(location.search);
  if (params.get('join') === '1') {
    params.delete('join'); history.replaceState(null, '', `${location.pathname}?${params}`);
    void join().then(() => poll());
  } else void poll();
}
