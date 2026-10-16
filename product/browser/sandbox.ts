/** Judge sandbox (Job 7): prerecorded, consented, labelled audio processed now through the same pipeline.
 * Expected labels are stored only as sandbox metadata for display; they never reach detection logic. */
import { ApiError, api, el, fmtMs, operationId, requireReviewer } from './api.js';
import type { ReviewerView, WindowView } from './api.js';
import { PcmWindowAssembler, encodeWav } from '../../src/media/wav.js';
import type { PcmClip } from '../../src/media/wav.js';
import { $, badge, clear, errorText, flaggedIds, fmtSec, notice, provenanceBadge, reasonText, table, windowTone } from './render.js';

const auth = await requireReviewer();
const app = $('app');
clear(app);

const SCENARIOS: Record<string, { title: string; label: string; kind: 'genuine' | 'switch' | 'short' }> = {
  '1': { title: '1 · Genuine enrolled speaker', label: 'genuine', kind: 'genuine' },
  '2': { title: '2 · Different speaker takes over', label: 'speaker_switch', kind: 'switch' },
  '3': { title: '3 · Permitted synthetic speech', label: 'synthetic', kind: 'switch' },
  '4': { title: '4 · Genuine speech with noise', label: 'genuine_noisy', kind: 'genuine' },
  '5': { title: '5 · Short speech or silence', label: 'short_or_silence', kind: 'short' },
};
const RUNS_KEY = 'sg.sandboxRuns';
const WINDOW_MS = 7000;

function loadRunIds(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }
  catch { return []; }
}
function saveRunIds(ids: string[]): void { try { localStorage.setItem(RUNS_KEY, JSON.stringify(ids)); } catch { /* per-browser convenience only */ } }

// ---------- page skeleton ----------
const intro = el('section', { class: 'panel sandbox-intro' },
  el('span', { class: 'eyebrow' }, 'EXPLORE THE LIMITS'),
  el('h2', {}, 'Put the signals to the test.'),
  el('p', {}, 'Run consented recordings through the same voice checks used in interviews. Compare what you expected with what actually happened.'),
  el('p', { class: 'muted' }, 'Prerecorded input is processed when you run it. Labels never influence detection. Live runs use DetectifAI credits.'));

const scenario = el('select', {}, ...Object.entries(SCENARIOS).map(([k, s]) => el('option', { value: k }, s.title)));
const label = el('input', { type: 'text', value: SCENARIOS['1']!.label, required: '' });
const notes = el('textarea', { placeholder: 'Judge notes (optional): where the audio came from, consent, conditions' });
const refFile = el('input', { type: 'file', accept: 'audio/*', required: '' });
const testFile = el('input', { type: 'file', accept: 'audio/*', required: '' });
const onset = el('input', { type: 'number', min: '0', step: '0.1', placeholder: 'e.g. 21.0' });
const runButton = el('button', { type: 'submit', class: 'primary' }, 'Run analysis →');
const log = el('ol', { class: 'muted' });
scenario.addEventListener('change', () => { label.value = SCENARIOS[scenario.value]?.label ?? ''; });
const form = el('form', {},
  el('label', {}, 'Scenario ', scenario),
  el('label', {}, 'Expected label (display only) ', label),
  el('label', {}, 'Notes', notes),
  el('label', {}, 'Reference audio — 15–60 s of the genuine speaker ', refFile),
  el('label', {}, 'Test audio ', testFile),
  el('label', {}, 'Switch onset, seconds into the test file (optional) ', onset),
  runButton);
const formPanel = el('section', { class: 'panel sandbox-form' }, el('h2', {}, 'New run'), form, log);
const resultsPanel = el('section', { class: 'panel sandbox-results' });
const guide = el('aside', { class: 'sandbox-guide' }, el('span', { class: 'eyebrow' }, 'FIVE WAYS TO EXPLORE'), el('h3', {}, 'Real outcomes.\nHonest limits.'),
  ...[['01', 'The same speaker', 'Establish a genuine baseline.'], ['02', 'A different voice', 'See what happens when a speaker changes.'], ['03', 'Synthetic speech', 'Explore permitted AI-generated audio.'], ['04', 'A noisier room', 'Understand uncertainty in real conditions.'], ['05', 'Not enough speech', 'Check how gaps and silence are handled.']].map(([n,title,copy]) => el('div', { class: 'scenario-item' }, el('span', {}, n), el('div', {}, el('strong', {}, title), el('p', {}, copy)))));
app.append(intro, el('div', { class: 'sandbox-layout' }, formPanel, guide), resultsPanel);

function step(text: string, tone: '' | 'bad' = ''): void {
  const li = el('li', {}, text);
  if (tone === 'bad') li.append(' ', badge('error', 'bad'));
  log.append(li);
}

// ---------- audio decoding ----------
/** Reads the sample rate from a RIFF/WAV header so decoding keeps the file's native rate. */
function wavSampleRate(bytes: ArrayBuffer): number | undefined {
  const v = new DataView(bytes);
  if (bytes.byteLength < 28) return undefined;
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const size = v.getUint32(offset + 4, true);
    if (tag(offset) === 'fmt ' && offset + 16 <= bytes.byteLength) return v.getUint32(offset + 12, true);
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

async function decodeMono(file: File): Promise<{ samples: Float32Array; sampleRate: number; durationMs: number }> {
  const bytes = await file.arrayBuffer();
  const native = wavSampleRate(bytes);
  // decodeAudioData resamples to the context rate, so match the context to the file where the header tells us.
  let ctx: OfflineAudioContext;
  try { ctx = new OfflineAudioContext(1, 1, native ?? 48000); } catch { ctx = new OfflineAudioContext(1, 1, 48000); }
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  const sampleRate = buffer.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error(`${file.name}: decoded sample rate ${sampleRate} Hz is outside 8000–192000 Hz`);
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i]! += data[i]! / buffer.numberOfChannels;
  }
  return { samples, sampleRate, durationMs: (buffer.length / sampleRate) * 1000 };
}

// ---------- run ----------
async function waitForChecks(id: string): Promise<ReviewerView> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const view = await api.reviewer(auth, id);
    const pending = view.windows.filter((w) => w.coverage === 'pending').length;
    if (pending === 0 && view.decision.pending === 0) return view;
    if (Date.now() > deadline) { step(`Stopped waiting after 5 min with ${pending} window(s) still pending; they stay visible as pending.`, 'bad'); return view; }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ref = refFile.files?.[0], test = testFile.files?.[0];
  const s = SCENARIOS[scenario.value];
  if (!ref || !test || !s || !label.value.trim()) return;
  const onsetSec = onset.value.trim() === '' ? undefined : Number(onset.value);
  if (onsetSec !== undefined && (!Number.isFinite(onsetSec) || onsetSec < 0)) { step('Switch onset must be a non-negative number of seconds.', 'bad'); return; }
  runButton.disabled = true; clear(log);
  try {
    step('Decoding audio in the browser…');
    const [refAudio, testAudio] = await Promise.all([decodeMono(ref), decodeMono(test)]);
    step(`Reference ${fmtSec(refAudio.durationMs)} @ ${refAudio.sampleRate} Hz · test ${fmtSec(testAudio.durationMs)} @ ${testAudio.sampleRate} Hz`);
    if (refAudio.durationMs < 15_000 || refAudio.durationMs > 60_000) throw new Error('Reference audio must be 15–60 s long (enrollment requirement). Nothing was sent.');

    const created = await api.createSession(auth, {
      displayName: `Sandbox ${s.title}`, kind: 'sandbox',
      sandbox: { scenario: scenario.value, label: label.value.trim(), ...(notes.value.trim() ? { notes: notes.value.trim() } : {}), ...(onsetSec !== undefined ? { switchOnsetSec: onsetSec } : {}) },
    });
    const id = created.sessionId;
    saveRunIds([...loadRunIds().filter((x) => x !== id), id]);
    step(`Session ${id} created.`);
    await api.consent(auth, id, { voiceAnalysis: true, camera: false, retention: true });

    step('Enrolling reference (authenticity is checked first)…');
    const enrolled = await api.enroll(auth, id, encodeWav(refAudio.samples, refAudio.sampleRate), 0, refAudio.durationMs, operationId());
    if (!enrolled.accepted) {
      step(`Enrollment rejected: ${enrolled.reason}. This is a real result and is recorded for the run.`);
      return;
    }
    step('Enrollment accepted. Starting monitoring.');
    await api.control(auth, id, 'start');

    const clips: PcmClip[] = [];
    const assembler = new PcmWindowAssembler(testAudio.sampleRate, WINDOW_MS, (clip) => clips.push(clip), () => { /* one contiguous buffer: no gaps */ });
    assembler.push(testAudio.samples, 0);
    assembler.flush(true);
    for (const [i, clip] of clips.entries()) {
      // Sandbox windows use file-relative offsets as their times.
      const res = await api.window(auth, id, encodeWav(clip.samples, clip.sampleRate), { startMs: clip.startMs, endMs: clip.endMs, source: 'labelled_upload' }, operationId());
      step(`Window ${i + 1}/${clips.length} ${fmtMs(clip.startMs)}–${fmtMs(clip.endMs)}: ${res.coverage}${res.reason ? ` (${res.reason})` : ''}`);
    }
    step('Waiting for checks to finish…');
    await waitForChecks(id);
    await api.control(auth, id, 'end').catch(() => undefined);
    step('Done. Results below are fetched fresh from the server.');
  } catch (e) {
    step(errorText(e), 'bad');
  } finally {
    runButton.disabled = false;
    void renderResults();
  }
});

// ---------- results ----------
type Outcome = 'flag' | 'no_flag' | 'inconclusive' | 'none';
interface RunStats {
  id: string; view?: ReviewerView; missing?: string;
  enrollmentAccepted?: boolean; firstOnly: Outcome; repeated: Outcome;
}

function checkedWindows(view: ReviewerView): WindowView[] {
  return view.windows.filter((w) => w.purpose === 'monitor').sort((a, b) => a.startMs - b.startMs);
}

function stats(id: string, view: ReviewerView): RunStats {
  const flagged = flaggedIds(view);
  const monitor = checkedWindows(view);
  const tones = monitor.map((w) => windowTone(w, flagged));
  const first = monitor.find((w) => w.coverage === 'complete' || w.coverage === 'partial');
  const firstTone = first ? windowTone(first, flagged) : undefined;
  const toOutcome = (t: string | undefined): Outcome => t === 'bad' ? 'flag' : t === 'ok' ? 'no_flag' : t === undefined ? 'none' : 'inconclusive';
  const repeated: Outcome = view.evidence.length ? 'flag' : tones.includes('ok') && !tones.some((t) => t === 'warn') ? 'no_flag' : tones.length ? 'inconclusive' : 'none';
  return { id, view, enrollmentAccepted: !!view.enrollment, firstOnly: toOutcome(firstTone), repeated };
}

function outcomeBadge(o: Outcome): HTMLSpanElement {
  return o === 'flag' ? badge('flag', 'bad') : o === 'no_flag' ? badge('no flag', 'ok') : o === 'inconclusive' ? badge('inconclusive', 'warn') : badge('no checked window', 'gap');
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function renderResults(): Promise<void> {
  clear(resultsPanel);
  const refresh = el('button', { type: 'button' }, 'Refresh');
  refresh.addEventListener('click', () => void renderResults());
  const forget = el('button', { type: 'button' }, 'Forget run list (this browser)');
  forget.addEventListener('click', () => { if (confirm('Forget the run list in this browser? Sessions stay on the server.')) { saveRunIds([]); void renderResults(); } });
  resultsPanel.append(el('div', { class: 'row' }, el('h2', {}, 'Results across runs'), refresh, forget));
  const ids = loadRunIds();
  if (!ids.length) { resultsPanel.append(el('p', { class: 'muted' }, 'No runs in this browser yet.')); return; }

  const runs: RunStats[] = await Promise.all(ids.map(async (id) => {
    try { return stats(id, await api.reviewer(auth, id)); }
    catch (e) { return { id, missing: e instanceof ApiError && e.status === 404 ? 'deleted or expired' : errorText(e), firstOnly: 'none' as Outcome, repeated: 'none' as Outcome }; }
  }));

  const rows = runs.map((r) => {
    const v = r.view;
    if (!v) return [r.id, '–', badge(r.missing ?? 'unavailable', 'gap'), '–', '–', '–', '–', '–', '–', '–', '–', '–'];
    const monitor = checkedWindows(v);
    const count = (c: string[]) => monitor.filter((w) => c.includes(w.coverage)).length;
    const attempt = v.enrollmentAttempts[v.enrollmentAttempts.length - 1];
    const enrollment = v.enrollment ? badge(`accepted (reference ${v.enrollment.authenticity})`, 'ok')
      : attempt ? el('span', {}, badge('rejected', 'bad'), ` ${attempt.reason}`) : badge('not attempted', 'gap');
    const flags = [...v.evidence].sort((a, b) => a.startMs - b.startMs);
    const firstFlag = flags[0];
    const onsetMs = v.sandbox?.switchOnsetSec !== undefined ? v.sandbox.switchOnsetSec * 1000 : undefined;
    let delay = '–';
    if (firstFlag) {
      delay = `first flag ${fmtMs(firstFlag.startMs)}–${fmtMs(firstFlag.endMs)}`;
      if (onsetMs !== undefined) delay += ` · detection delay in audio time ${((firstFlag.endMs - onsetMs) / 1000).toFixed(1)} s`;
    }
    const latencyWindow = firstFlag ? v.windows.find((w) => w.id === firstFlag.windowId) : undefined;
    const latencies = monitor.filter((w) => w.submittedAtMs !== undefined && w.respondedAtMs !== undefined).map((w) => w.respondedAtMs! - w.submittedAtMs!);
    const latency = latencyWindow?.submittedAtMs !== undefined && latencyWindow.respondedAtMs !== undefined
      ? `${Math.round(latencyWindow.respondedAtMs - latencyWindow.submittedAtMs)} ms (flagged window)`
      : median(latencies) !== undefined ? `${Math.round(median(latencies)!)} ms (median)` : '–';
    const provenances = [...new Set(v.windows.map((w) => w.result?.provenance).filter((p): p is NonNullable<typeof p> => !!p))];
    return [
      el('a', { href: `/reviewer.html?s=${encodeURIComponent(r.id)}` }, SCENARIOS[v.sandbox?.scenario ?? '']?.title ?? v.sandbox?.scenario ?? '?'),
      v.sandbox?.label ?? '–',
      enrollment,
      `${count(['complete', 'partial'])} / ${count(['skipped'])} / ${count(['failed'])}${count(['pending']) ? ` (+${count(['pending'])} pending)` : ''}`,
      flags.length ? `${flags.length}: ${[...new Set(flags.flatMap((f) => f.reasons))].map(reasonText).join('; ')}` : '0',
      delay, latency,
      `${v.usage.creditsCharged} (${v.usage.providerCalls} calls)`,
      el('span', {}, ...(provenances.length ? provenances.map((p) => provenanceBadge(p)) : [provenanceBadge(undefined)])),
      outcomeBadge(r.firstOnly), outcomeBadge(r.repeated),
      v.sandbox?.notes ?? '',
    ];
  });
  resultsPanel.append(table(['Scenario', 'Expected label', 'Enrollment', 'Windows checked / skipped / failed', 'Flagged windows', 'First flag vs onset', 'Processing latency', 'Credits charged', 'Provenance', 'Enrollment-only (first checked window)', 'Repeated (any window)', 'Notes'], rows));

  // Summary counts from the runs above. Counts only — no accuracy percentages.
  const ok = runs.filter((r) => r.view && r.enrollmentAccepted);
  const of = (scenarios: string[]) => ok.filter((r) => scenarios.includes(r.view!.sandbox?.scenario ?? ''));
  const switches = of(['2', '3']), genuine = of(['1', '4']);
  const n = (list: RunStats[], key: 'firstOnly' | 'repeated', o: Outcome) => list.filter((r) => r[key] === o).length;
  const inconclusive = ok.filter((r) => r.repeated === 'inconclusive' || r.repeated === 'none').length;
  const rejected = runs.filter((r) => r.view && !r.enrollmentAccepted).length;
  resultsPanel.append(el('h3', {}, 'Summary'),
    table(['Group', 'Enrollment-only', 'Repeated'], [
      [`Switch scenarios 2/3 (n = ${switches.length} trials)`, `${n(switches, 'firstOnly', 'flag')} detected · ${switches.length - n(switches, 'firstOnly', 'flag')} missed`, `${n(switches, 'repeated', 'flag')} detected · ${switches.length - n(switches, 'repeated', 'flag')} missed`],
      [`Genuine scenarios 1/4 (n = ${genuine.length} trials)`, `${n(genuine, 'firstOnly', 'flag')} with false alert`, `${n(genuine, 'repeated', 'flag')} with false alert`],
    ]),
    el('p', {}, `Inconclusive or unchecked runs (no flag, but not cleanly checked): ${inconclusive}. Runs where enrollment was rejected: ${rejected}. Total runs: n = ${runs.length} trials.`),
    el('p', { class: 'muted' }, '"Missed" includes runs with inconclusive or skipped windows. These are counts from a handful of trials in this browser, not accuracy figures.'));
  if (runs.some((r) => r.view?.windows.some((w) => w.result?.provenance === 'test_fixture'))) {
    resultsPanel.append(notice('Some runs used test fixtures (provenance test_fixture), not live Detectif results.', 'warn'));
  }
}

void renderResults();
