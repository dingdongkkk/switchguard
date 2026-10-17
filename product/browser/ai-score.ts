/** DOM-free scoring helper (unit-tested in Node). */
export type AiLevel = 'Very low' | 'Low' | 'Borderline' | 'High' | 'Very high';
/** DetectifAI's deepfake `score` (0–1, higher = more likely AI-generated) and its `threshold`, read
 * from the stored raw response. The level is derived so it never contradicts the verdict, which
 * stays the decision: real → Very low/Low, not_sure → Borderline, fake → High/Very high. */
export function aiLikeness(raw: unknown, verdict: 'real' | 'fake' | 'not_sure' | undefined): { score: number; pct: number; threshold?: number; level: AiLevel; tone: 'ok' | 'warn' | 'bad' } | undefined {
  if (!verdict) return undefined;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const body = obj(obj(raw).body ?? raw), partial = obj(body.partial);
  const deep = obj(body.deepfake ?? partial.deepfake ?? (body.partial !== undefined ? partial : undefined) ?? body);
  const value = Object.keys(obj(deep.result)).length ? obj(deep.result) : deep;
  const score = value.score, th = value.threshold;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return undefined;
  const threshold = typeof th === 'number' && th > 0 && th < 1 ? th : undefined, t = threshold ?? 0.5;
  const level: AiLevel = verdict === 'not_sure' ? 'Borderline'
    : verdict === 'fake' ? (score >= t + (1 - t) / 2 ? 'Very high' : 'High')
    : score < t / 2 ? 'Very low' : 'Low';
  const tone: 'ok' | 'warn' | 'bad' = verdict === 'fake' ? 'bad' : verdict === 'not_sure' ? 'warn' : 'ok';
  return { score, pct: Math.round(score * 100), threshold, level, tone };
}
