/** Printable evidence summary (?s=<id>). Signals, not proof: a human reviewer makes the final decision. */
import { api, el, fmtMs, requireReviewer } from './api.js';
import type { ReviewerView } from './api.js';
import {
  $, badge, clear, consentSummary, coverageBadge, errorText, flaggedIds, fmtEpoch, fmtRange, fmtSec, notice, provenanceBadge,
  reasonText, sessionIdFromQuery, stateBadge, table,
} from './render.js';

const auth = await requireReviewer();
const sessionId = sessionIdFromQuery();
const app = $('app');
document.getElementById('print')?.addEventListener('click', () => window.print());

function section(title: string, ...children: Array<Node | string>): HTMLElement {
  return el('section', { class: 'panel' }, el('h2', {}, title), ...children);
}

function speakerText(view: ReviewerView['windows'][number]): string {
  const s = view.result?.speaker;
  if (!s) return 'no result';
  return s.status === 'complete' ? `${s.decision} · similarity (not a probability) ${s.similarity.toFixed(3)} / threshold ${s.threshold.toFixed(3)}` : `${s.status}: ${s.error.code}`;
}
function authenticityText(view: ReviewerView['windows'][number]): string {
  const a = view.result?.authenticity;
  if (!a) return 'no result';
  return a.status === 'complete' ? `verdict ${a.verdict}` : `${a.status}: ${a.error.code}`;
}

function render(v: ReviewerView): void {
  clear(app);
  document.title = `SwitchGuard report · ${v.displayName}`;
  const flagged = flaggedIds(v);
  const question = (qid: string) => v.questions.find((q) => q.id === qid)?.text ?? qid;
  const answerText = (ids: string[]) => ids.map((id) => { const a = v.answers.find((x) => x.id === id); return a ? question(a.questionId) : id; }).join('; ') || '–';
  const provenances = [...new Set(v.windows.map((w) => w.result?.provenance).filter((p): p is NonNullable<typeof p> => !!p))];

  app.append(
    el('h1', {}, `Evidence summary — ${v.displayName}`),
    el('p', { class: 'muted' }, `Generated ${new Date().toLocaleString()} · session ${v.sessionId} · ${v.kind} · status ${v.status} · created ${fmtEpoch(v.createdAtEpochMs)} · session time ${fmtMs(v.nowMs)}`),
    notice('Signals, not proof. The system never rejects a candidate; a human reviewer makes the final decision.'),

    section('Current state', el('div', { class: 'row' }, stateBadge(v.decision.state)),
      el('ul', {}, ...v.decision.reasons.map((r) => el('li', {}, reasonText(r)))),
      el('div', { class: 'row' }, el('span', {}, 'Provenance:'), ...(provenances.length ? provenances.map((p) => provenanceBadge(p)) : [provenanceBadge(undefined)])),
      el('div', { class: 'muted' }, `Provider calls ${v.usage.providerCalls} · credits charged ${v.usage.creditsCharged} · media retention ${v.retention.mediaRetentionHours} h`)),

    section('Consent', consentSummary(v)),

    section('Enrollment',
      v.enrollment
        ? el('div', {}, `Reference ${v.enrollment.id} enrolled at ${fmtMs(v.enrollment.enrolledAtMs)} · reference authenticity ${v.enrollment.authenticity}${v.enrollment.deletedAtMs !== undefined ? ` · profile deleted at ${fmtMs(v.enrollment.deletedAtMs)}` : ''}`)
        : el('div', {}, 'No accepted reference.'),
      v.enrollmentAttempts.length ? table(['At', 'Duration', 'Local voiced', 'Authenticity', 'Outcome', 'Reason'], v.enrollmentAttempts.map((a) => [
        fmtMs(a.atMs), fmtSec(a.durationMs), `${a.localVoicedSec.toFixed(1)} s`,
        a.authenticity ? (a.authenticity.verdict ?? `${a.authenticity.status}${a.authenticity.error ? `: ${a.authenticity.error.code}` : ''}`) : 'not checked',
        a.enrolled ? 'accepted' : 'rejected', a.reason])) : ''),

    section('Coverage',
      el('div', {}, `Checked ${fmtSec(v.coverage.checkedMs)} · skipped ${fmtSec(v.coverage.skippedMs)} · failed ${fmtSec(v.coverage.failedMs)} · pending ${fmtSec(v.coverage.pendingMs)}`),
      el('div', {}, `Gaps: ${v.coverage.gaps.length ? v.coverage.gaps.map((g) => fmtRange(g.startMs, g.endMs)).join(', ') : 'none listed'}`)),

    section('Interruptions', v.interruptions.length
      ? table(['Time', 'Kind', 'Reason'], v.interruptions.map((i) => [fmtMs(i.atMs), i.kind, i.reason]))
      : el('p', { class: 'muted' }, 'None reported.')),

    section('Decision history (windows)', v.windows.length ? table(['#', 'Interval', 'Purpose', 'Coverage', 'Identity (speaker)', 'Authenticity', 'Answers', 'Provenance'],
      [...v.windows].sort((a, b) => a.startMs - b.startMs).map((w) => [
        String(w.sequence), fmtRange(w.startMs, w.endMs), w.purpose, coverageBadge(w, flagged), speakerText(w), authenticityText(w), answerText(w.answerIds),
        w.result?.provenance ?? '–'])) : el('p', { class: 'muted' }, 'No windows.')),
  );

  const evidence = section('Evidence and reviewer resolutions');
  if (!v.evidence.length) evidence.append(el('p', { class: 'muted' }, 'No flagged windows.'));
  for (const e of [...v.evidence].sort((a, b) => a.startMs - b.startMs)) {
    const w = v.windows.find((x) => x.id === e.windowId);
    evidence.append(el('div', {},
      el('div', { class: 'row' }, badge('flag', 'bad'), el('strong', {}, fmtRange(e.startMs, e.endMs)), el('span', {}, e.reasons.map(reasonText).join('; '))),
      el('div', { class: 'muted' }, `Answers: ${answerText(e.answerIds)} · raised ${fmtMs(e.createdAtMs)}${w ? ` · ${speakerText(w)} · ${authenticityText(w)}` : ''}`),
      el('div', { class: 'resolution' }, e.resolutions.length
        ? table(['At', 'Reviewer', 'Disposition', 'Notes'], [...e.resolutions].sort((a, b) => a.atMs - b.atMs).map((r) => [fmtMs(r.atMs), r.reviewerId, r.disposition, r.notes]))
        : el('p', { class: 'muted' }, 'No reviewer resolution recorded.'))));
  }
  app.append(evidence);

  app.append(section('Re-verification challenges', v.challenges.length ? table(['Phrase', 'Issued / expires', 'Status', 'Transcript', 'Phrase', 'Speaker', 'Authenticity', 'Gesture', 'Reviewer attestation'],
    [...v.challenges].sort((a, b) => a.issuedAtMs - b.issuedAtMs).map((c) => {
      const transcript = c.transcript?.trim();
      const r = c.window?.result;
      return [
        c.phrase, `${fmtMs(c.issuedAtMs)} / ${fmtMs(c.expiresAtMs)}`, c.status,
        transcript ? `“${transcript}”` : 'no transcript — phrase not checked',
        !transcript || !c.phraseComparison ? 'not checked' : `${c.phraseComparison.matched ? 'matched' : 'not matched'} (${c.phraseComparison.matchedWords}/${c.phraseComparison.totalWords} words)`,
        c.window ? speakerText(c.window) : 'no result', c.window ? authenticityText(c.window) : 'no result', 'not implemented',
        c.reviewerAssist ? `reviewer-attested by ${c.reviewerAssist.reviewerId}: heard ${c.reviewerAssist.phraseHeard ? 'yes' : 'no'} — ${c.reviewerAssist.notes}` : '–',
      ];
    })) : el('p', { class: 'muted' }, 'No challenges issued.'), el('p', { class: 'muted' }, 'Re-verification uses the original reference and never erases earlier flags.')));

  if (v.sandbox) app.append(section('Sandbox metadata (display only)', `Scenario ${v.sandbox.scenario} · expected label "${v.sandbox.label}"${v.sandbox.switchOnsetSec !== undefined ? ` · switch onset ${v.sandbox.switchOnsetSec} s` : ''}${v.sandbox.notes ? ` · ${v.sandbox.notes}` : ''}`));
}

if (!sessionId) { clear(app); app.append(notice('Missing session id (report.html?s=<id>).', 'bad')); }
else api.reviewer(auth, sessionId).then(render).catch((e) => { clear(app); app.append(notice(`Could not load session: ${errorText(e)}`, 'bad')); });
