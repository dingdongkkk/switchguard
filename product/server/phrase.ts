import { randomInt } from 'node:crypto';

/** Short, distinct, easy-to-pronounce English words. Phrases are random, so a prerecorded
 * answer cannot anticipate them; they are still only as strong as the transcription. */
const WORDS = [
  'amber', 'harbor', 'violet', 'canyon', 'maple', 'orbit', 'pepper', 'silver', 'tunnel', 'meadow',
  'falcon', 'copper', 'river', 'lantern', 'garden', 'thunder', 'velvet', 'marble', 'window', 'basket',
  'candle', 'forest', 'island', 'jacket', 'kitten', 'ladder', 'mirror', 'number', 'orange', 'pillow',
  'rocket', 'saddle', 'ticket', 'valley', 'winter', 'yellow', 'bridge', 'cotton', 'dragon', 'engine',
];

export function generatePhrase(words = 5): string {
  const picked = new Set<string>();
  while (picked.size < words) picked.add(WORDS[randomInt(WORDS.length)]!);
  return [...picked].join(' ');
}

export function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Order-preserving word overlap (longest common subsequence) between the issued phrase and a
 * transcript. Matching is explicit text comparison; no model judges "closeness". */
export function comparePhrase(phrase: string, transcript: string): { matched: boolean; matchedWords: number; totalWords: number; score: number } {
  const a = normalizeWords(phrase), b = normalizeWords(transcript);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  }
  const matchedWords = dp[a.length]![b.length]!;
  const score = a.length ? matchedWords / a.length : 0;
  // Allow one misrecognised word in a five-word phrase; extra words are tolerated.
  return { matched: a.length > 0 && matchedWords >= a.length - 1 && score >= 0.8, matchedWords, totalWords: a.length, score };
}
