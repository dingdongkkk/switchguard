/** Shared rendering helpers for the reviewer-side pages (home, reviewer, sandbox, report).
 * Identity (speaker) and authenticity are always rendered as separate indicators. */
import { ApiError, authHeaders, el, fmtMs } from './api.js';
import { aiLikeness } from './ai-score.js';
export { aiLikeness } from './ai-score.js';
import type { Auth, ReviewerView, WindowView } from './api.js';
import type { ApplicationState, AuthenticityResult, ProviderMeta, SpeakerResult } from '../../src/shared/contracts.js';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'gap';

export function badge(text: string, tone: Tone): HTMLSpanElement {
  return el('span', { class: `badge ${tone}` }, text);
}

export function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

export function clear(node: Element): void { node.replaceChildren(); }

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code}${error.status ? `, HTTP ${error.status}` : ''})`;
  return error instanceof Error ? error.message : String(error);
}

export function notice(text: string, tone: '' | 'warn' | 'bad' = ''): HTMLDivElement {
  return el('div', { class: `notice ${tone}`.trim() }, text);
}

export function fmtEpoch(epochMs: number | undefined): string {
  return epochMs === undefined ? '–' : new Date(epochMs).toLocaleString();
}

export function fmtSec(ms: number | undefined): string {
  return ms === undefined || !Number.isFinite(ms) ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

export function fmtRange(startMs: number, endMs: number): string {
  return `${fmtMs(startMs)} – ${fmtMs(endMs)}`;
}

const STATE: Record<ApplicationState, { label: string; tone: Tone }> = {
  consistent_with_enrolled_speaker: { label: 'Consistent with enrolled speaker', tone: 'ok' },
  needs_reverification: { label: 'Needs re-verification', tone: 'bad' },
  inconclusive: { label: 'Inconclusive', tone: 'warn' },
  monitoring_interrupted: { label: 'Monitoring interrupted', tone: 'gap' },
  checking: { label: 'Checking', tone: 'info' },
};
export function stateBadge(state: ApplicationState): HTMLSpanElement {
  const s = STATE[state] ?? { label: state, tone: 'info' as Tone };
  return badge(s.label, s.tone);
}

export function reasonText(reason: string): string {
  switch (reason) {
    case 'speaker_mismatch': return 'Voice differs from the enrolled reference';
    case 'synthetic_speech': return 'Final authenticity verdict: synthetic speech';
    default: return reason;
  }
}

/** Looks for a key (e.g. decided_by) anywhere in a raw provider response, bounded depth. */
export function findKey(raw: unknown, key: string, depth = 0): unknown {
  if (!raw || typeof raw !== 'object' || depth > 6) return undefined;
  if (Array.isArray(raw)) { for (const item of raw) { const f = findKey(item, key, depth + 1); if (f !== undefined) return f; } return undefined; }
  const record = raw as Record<string, unknown>;
  if (key in record) return record[key];
  for (const value of Object.values(record)) { const f = findKey(value, key, depth + 1); if (f !== undefined) return f; }
  return undefined;
}

export function providerLine(p: ProviderMeta | undefined): HTMLElement {
  if (!p) return el('div', { class: 'muted' }, 'no provider metadata');
  const parts: string[] = [];
  if (p.requestId) parts.push(`requestId ${p.requestId}`);
  if (p.operationId) parts.push(`operationId ${p.operationId}`);
  if (p.model) parts.push(`model ${p.model.name} ${p.model.version}`);
  if (p.latencyMs !== undefined) parts.push(`latency ${Math.round(p.latencyMs)} ms`);
  return el('div', { class: 'muted mono' }, parts.length ? parts.join(' · ') : 'no provider metadata');
}

/** Identity indicator. Similarity is a score, never a probability or percentage. */
export function speakerIndicator(s: SpeakerResult | undefined, withProvider = false): HTMLElement {
  const box = el('div', { class: 'signal-indicator' }, el('strong', {}, 'Speaker continuity'));
  if (!s) { box.append(badge('no result yet', 'gap')); return box; }
  if (s.status === 'complete') {
    box.append(s.decision === 'match' ? badge('Speaker matched', 'ok') : badge('Speaker differs', 'bad'),
      el('div', { class: 'muted' }, `similarity (not a probability): ${s.similarity.toFixed(3)} · threshold ${s.threshold.toFixed(3)}`));
  } else {
    box.append(badge(s.status, s.status === 'inconclusive' ? 'warn' : 'gap'),
      el('div', { class: 'muted' }, `${s.error.code}: ${s.error.message}`));
  }
  if (withProvider) box.append(providerLine(s.provider));
  return box;
}

/** "AI-likeness: Low · 18%" with a bar and the model's threshold marked. */
export function aiMeter(raw: unknown, verdict: 'real' | 'fake' | 'not_sure' | undefined): HTMLElement | '' {
  const ai = aiLikeness(raw, verdict);
  if (!ai) return '';
  // Widths go through CSSOM: the page CSP (style-src 'self') blocks inline style attributes.
  const fill = el('span', { class: 'ai-fill' }); fill.style.width = `${ai.pct}%`;
  const bar = el('div', { class: `ai-bar ai-${ai.tone}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(ai.pct), 'aria-label': 'AI-likeness score' }, fill);
  if (ai.threshold !== undefined) {
    const mark = el('span', { class: 'ai-threshold', title: `Model threshold ${Math.round(ai.threshold * 100)}%` }); mark.style.left = `${Math.round(ai.threshold * 100)}%`;
    bar.append(mark);
  }
  return el('div', { class: 'ai-meter' },
    el('div', { class: 'row' }, el('span', {}, 'AI-likeness:'), badge(`${ai.level} · ${ai.pct}%`, ai.tone)),
    bar,
    el('div', { class: 'muted' }, `DetectifAI model score${ai.threshold !== undefined ? ` (threshold ${Math.round(ai.threshold * 100)}%)` : ''}. A score, not a probability; the verdict decides.`));
}

export function authenticityIndicator(a: AuthenticityResult | undefined, raw?: unknown, withProvider = false): HTMLElement {
  const box = el('div', { class: 'signal-indicator' }, el('strong', {}, 'Voice authenticity'));
  if (!a) { box.append(badge('no result yet', 'gap')); return box; }
  if (a.status === 'complete') {
    const tone: Tone = a.verdict === 'real' ? 'ok' : a.verdict === 'fake' ? 'bad' : 'warn';
    box.append(badge(a.verdict === 'fake' ? 'Synthetic signal' : a.verdict === 'real' ? 'Genuine voice' : 'Uncertain', tone));
    box.append(aiMeter(raw, a.verdict));
    const decidedBy = findKey(raw, 'decided_by');
    if (decidedBy !== undefined) box.append(el('div', { class: 'muted' }, `decided_by: ${typeof decidedBy === 'string' ? decidedBy : JSON.stringify(decidedBy)}`));
  } else {
    box.append(badge(a.status, a.status === 'inconclusive' ? 'warn' : 'gap'),
      el('div', { class: 'muted' }, `${a.error.code}: ${a.error.message}`));
  }
  if (withProvider) box.append(providerLine(a.provider));
  return box;
}

export function provenanceBadge(p: string | undefined): HTMLSpanElement {
  return p ? badge(p, p === 'detectif_live' ? 'info' : 'warn') : badge('no provenance', 'gap');
}

export type SegTone = 'ok' | 'bad' | 'warn' | 'pending' | 'gap';
/** Tone of one window on the timeline. Flags win; errors/skips are gaps, never green. */
export function windowTone(w: WindowView, flaggedWindowIds: Set<string>): SegTone {
  if (flaggedWindowIds.has(w.id)) return 'bad';
  if (w.coverage === 'pending') return 'pending';
  if (w.coverage === 'skipped' || w.coverage === 'failed') return 'gap';
  if (w.coverage === 'partial') return 'warn';
  const r = w.result;
  if (!r) return 'warn';
  if (r.speaker.status !== 'complete' || r.authenticity.status !== 'complete') return 'warn';
  if (r.authenticity.verdict === 'not_sure') return 'warn';
  if (r.speaker.decision === 'no_match' || r.authenticity.verdict === 'fake') return 'bad';
  return 'ok';
}

export function coverageBadge(w: WindowView, flaggedWindowIds: Set<string>): HTMLSpanElement {
  const tone = windowTone(w, flaggedWindowIds);
  const map: Record<SegTone, Tone> = { ok: 'ok', bad: 'bad', warn: 'warn', pending: 'info', gap: 'gap' };
  return badge(flaggedWindowIds.has(w.id) ? `${w.coverage} · flagged` : w.coverage, map[tone]);
}

export function flaggedIds(view: ReviewerView): Set<string> {
  return new Set(view.evidence.map((e) => e.windowId));
}

export function consentSummary(view: ReviewerView): string {
  const c = view.consent;
  if (!c) return 'No consent recorded yet';
  return `voice analysis ${c.voiceAnalysis ? 'yes' : 'no'} · camera ${c.camera ? 'yes' : 'no'} · retention ${c.retention ? 'yes' : 'no'} · at ${fmtMs(c.atMs)}`;
}

export function copyButton(text: () => string, label = 'Copy'): HTMLButtonElement {
  const button = el('button', { type: 'button' }, label);
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); button.textContent = 'Copied'; }
    catch { window.prompt('Copy this link:', text()); }
    setTimeout(() => { button.textContent = label; }, 1500);
  });
  return button;
}

export function table(headers: string[], rows: Array<Array<Node | string>>): HTMLDivElement {
  const t = el('table', {});
  t.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))));
  const body = el('tbody', {});
  for (const r of rows) body.append(el('tr', {}, ...r.map((c) => el('td', {}, c))));
  t.append(body);
  return el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Scrollable data table' }, t);
}

export function sessionIdFromQuery(): string | undefined {
  return new URLSearchParams(location.search).get('s') ?? undefined;
}

/** Downloads the JSON export with the reviewer header (no token in URLs). */
export async function downloadExport(auth: Auth, sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export`, { headers: authHeaders(auth) });
  if (!response.ok) throw new ApiError(response.status, 'export_failed', `Export failed: HTTP ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const a = el('a', { href: url, download: `switchguard-${sessionId}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
