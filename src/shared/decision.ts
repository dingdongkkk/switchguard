import type { AudioWindow, Decision, InterviewSession, WindowResult } from './contracts.js';

export const DEFAULT_STALE_MS = 25_000;
export function createSession(id: string, createdAtEpochMs: number, displayName = 'Consenting participant'): InterviewSession {
  return { id, createdAtEpochMs, candidate: { id: `${id}:candidate`, displayName, role: 'candidate' }, questions: [], answers: [], windows: [], results: [], evidence: [], interruptions: [], challenges: [], resolutions: [] };
}
export function addWindow(session: InterviewSession, window: AudioWindow): InterviewSession {
  if (window.sessionId !== session.id || !session.enrollment || window.referenceId !== session.enrollment.id || session.enrollment.deletedAtMs !== undefined) throw new Error('Window must use the original active enrollment');
  if (session.windows.some(w => w.id === window.id || w.sequence === window.sequence)) throw new Error('Duplicate window ID or sequence');
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.startMs < 0 || window.endMs <= window.startMs) throw new Error('Invalid capture interval');
  return { ...session, windows: [...session.windows, { ...window, answerIds: [...window.answerIds] }] };
}
/** Results append once; arrival order never selects the current window. Flags are never erased. */
export function applyResult(session: InterviewSession, result: WindowResult): InterviewSession {
  const window = session.windows.find(w => w.id === result.windowId);
  if (!window || result.referenceId !== window.referenceId || result.referenceId !== session.enrollment?.id) throw new Error('Result/reference mismatch');
  if (session.results.some(r => r.windowId === result.windowId)) return session;
  const reasons: Array<'speaker_mismatch' | 'synthetic_speech'> = [];
  if (result.speaker.status === 'complete' && result.speaker.decision === 'no_match') reasons.push('speaker_mismatch');
  if (result.authenticity.status === 'complete' && result.authenticity.verdict === 'fake') reasons.push('synthetic_speech');
  const completeCount = Number(result.speaker.status === 'complete') + Number(result.authenticity.status === 'complete');
  return {
    ...session, results: [...session.results, result],
    windows: session.windows.map(w => w.id !== window.id ? w : { ...w, respondedAtMs: result.receivedAtMs, coverage: completeCount === 2 ? 'complete' : completeCount === 1 ? 'partial' : 'failed' }),
    evidence: reasons.length ? [...session.evidence, { id: `evidence:${window.id}`, windowId: window.id, startMs: window.startMs, endMs: window.endMs, answerIds: [...window.answerIds], reasons, createdAtMs: result.receivedAtMs }] : session.evidence,
  };
}
/** No temporal voting/smoothing: overlapping observations are never extra confirmations.
 * Current status and the historical evidence/reviewer resolution remain separate. */
export function decide(session: InterviewSession, nowMs: number, staleMs = DEFAULT_STALE_MS): Decision {
  const base: Decision = { state: 'checking', reasons: [], pending: session.windows.filter(w => w.coverage === 'pending').length, evidenceCount: session.evidence.length };
  const latest = [...session.windows].sort((a, b) => b.endMs - a.endMs || b.sequence - a.sequence)[0];
  const interruption = [...session.interruptions].sort((a, b) => b.atMs - a.atMs)[0];
  const completed = session.results.filter(r => r.speaker.status === 'complete' || r.authenticity.status === 'complete').map(r => session.windows.find(w => w.id === r.windowId)!.endMs);
  base.latestCompletedCheckMs = completed.length ? Math.max(...completed) : undefined;
  if (interruption?.kind === 'interrupted') return { ...base, state: 'monitoring_interrupted', reasons: [interruption.reason] };
  if (!latest) return base;
  base.latestWindowId = latest.id;
  const result = session.results.find(r => r.windowId === latest.id);
  base.speaker = result?.speaker; base.authenticity = result?.authenticity;
  if (session.enrollment?.deletedAtMs !== undefined) return { ...base, state: 'monitoring_interrupted', reasons: ['Original enrollment was deleted'] };
  if (nowMs - latest.endMs > staleMs) return { ...base, state: 'monitoring_interrupted', reasons: ['No recent captured audio has been checked'] };
  if (interruption?.kind === 'resumed' && latest.startMs < interruption.atMs) return { ...base, state: 'checking', reasons: ['Awaiting fresh audio after recovery'] };
  if (latest.coverage === 'skipped') return { ...base, state: 'inconclusive', reasons: [latest.reason ?? 'Audio interval was not checked'] };
  if (!result) return { ...base, reasons: ['Both checks are pending'] };
  const reasons: string[] = [];
  if (result.speaker.status === 'complete' && result.speaker.decision === 'no_match') reasons.push('Voice differs from original enrollment');
  if (result.authenticity.status === 'complete' && result.authenticity.verdict === 'fake') reasons.push('Synthetic-speech flag requires human review');
  if (reasons.length) return { ...base, state: 'needs_reverification', reasons };
  if (result.speaker.status !== 'complete' || result.authenticity.status !== 'complete') return { ...base, state: 'inconclusive', reasons: ['At least one check is missing, failed, or audio is insufficient'] };
  if (result.authenticity.verdict === 'not_sure') return { ...base, state: 'inconclusive', reasons: ['Authenticity could not be determined; obtain cleaner speech'] };
  return { ...base, state: 'consistent_with_enrolled_speaker', reasons: ['Speaker matched and final authenticity verdict is real; historical flags remain for review'] };
}
