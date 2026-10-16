/** Milliseconds since session creation. Capture uses a monotonic browser clock,
 * synchronized once with the server; API timestamps never replace capture times. */
export type SessionMs = number;
export interface Interval { startMs: SessionMs; endMs: SessionMs }
export interface Participant { id: string; displayName: string; role: 'candidate' | 'reviewer' }
export interface Question { id: string; text: string }
export interface Answer extends Interval { id: string; questionId: string }
export interface ProviderMeta {
  requestId?: string; operationId?: string; model?: { name: string; version: string };
  credits?: unknown; latencyMs?: number; configVersion?: string;
}
export interface EnrollmentReference {
  readonly id: string; readonly speakerId: string; readonly participantId: string;
  readonly enrolledAtMs: SessionMs; readonly provider: ProviderMeta;
  /** Job 3 must populate this before accepting a reference into a product workflow. */
  authenticity: 'not_checked' | 'real' | 'fake' | 'not_sure';
  deletedAtMs?: SessionMs;
}
export type Coverage = 'pending' | 'complete' | 'partial' | 'failed' | 'skipped';
export interface AudioWindow extends Interval {
  id: string; sessionId: string; sequence: number; answerIds: string[];
  source: 'candidate_microphone' | 'labelled_upload'; purpose: 'monitor' | 'reverify';
  referenceId: string; mimeType: 'audio/wav'; sampleRate: number; sampleCount: number;
  /** No trimming/resampling in this implementation; map clip seconds using startMs. */
  mediaOffsetMs: number; coverage: Coverage; reason?: string;
  submittedAtMs?: SessionMs; respondedAtMs?: SessionMs;
}
export interface CheckError { code: string; message: string; httpStatus?: number }
export type SpeakerResult =
  | { status: 'complete'; decision: 'match' | 'no_match'; similarity: number; threshold: number; provider: ProviderMeta }
  | { status: 'failed' | 'missing' | 'inconclusive'; error: CheckError; provider: ProviderMeta };
export interface Segment extends Interval { score: number; stage: 'first_stage_supporting_only' }
export type AuthenticityResult =
  | { status: 'complete'; verdict: 'real' | 'fake' | 'not_sure'; segments: Segment[]; provider: ProviderMeta }
  | { status: 'failed' | 'missing' | 'inconclusive'; error: CheckError; provider: ProviderMeta };
export interface WindowResult {
  windowId: string; referenceId: string; receivedAtMs: SessionMs;
  speaker: SpeakerResult; authenticity: AuthenticityResult;
  provenance: 'detectif_live' | 'test_fixture';
  /** Entire provider response retained for diagnostics, including partial results. */
  raw: unknown;
}
export interface EvidenceInterval extends Interval {
  id: string; windowId: string; answerIds: string[];
  reasons: Array<'speaker_mismatch' | 'synthetic_speech'>; createdAtMs: SessionMs;
}
export interface VerificationChallenge {
  id: string; sessionId: string; referenceId: string; issuedAtMs: SessionMs;
  expiresAtMs: SessionMs; usedAtMs?: SessionMs; phrase: string; gestures: string[];
  phraseMatched?: boolean; gestureCompleted?: boolean; resultWindowId?: string;
}
export interface ReviewerResolution {
  id: string; evidenceId: string; reviewerId: string; atMs: SessionMs;
  disposition: 'request_reverification' | 'reviewed' | 'escalate'; notes: string;
}
export interface CaptureInterruption { atMs: SessionMs; kind: 'interrupted' | 'resumed'; reason: string }
export interface InterviewSession {
  id: string; createdAtEpochMs: number; candidate: Participant;
  enrollment?: EnrollmentReference; questions: Question[]; answers: Answer[];
  windows: AudioWindow[]; results: WindowResult[]; evidence: EvidenceInterval[];
  interruptions: CaptureInterruption[]; challenges: VerificationChallenge[];
  resolutions: ReviewerResolution[];
}
export type ApplicationState = 'checking' | 'consistent_with_enrolled_speaker' | 'needs_reverification' | 'inconclusive' | 'monitoring_interrupted';
export interface Decision {
  state: ApplicationState; reasons: string[]; latestWindowId?: string;
  latestCompletedCheckMs?: SessionMs; speaker?: SpeakerResult; authenticity?: AuthenticityResult;
  pending: number; evidenceCount: number;
}
