/**
 * Shared types used across tokenlean components.
 * Component-internal types live in their own modules.
 */

/** Payload Claude Code sends to a UserPromptSubmit hook on stdin. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface IngestResult {
  filesScanned: number;
  filesParsed: number;
  filesSkippedUnchanged: number;
  sessionsUpserted: number;
  turnsAdded: number;
  toolCallsAdded: number;
  malformedLines: number;
  unknownRecordTypes: number;
}

export interface HeuristicsResult {
  sessionsScored: number;
  findingsAdded: number;
}

export interface SubmitResult {
  /** Number of sessions submitted in the batch (0 if nothing new to analyze). */
  submitted: number;
  batchId: string | null;
  skippedAlreadyAnalyzed: number;
  message?: string;
}

export interface CollectResult {
  batchesChecked: number;
  batchesCompleted: number;
  findingsAdded: number;
  stillPending: number;
}

/** One row of the `findings` table. */
export interface FindingRow {
  id: number;
  session_id: string;
  category: string;
  confidence: number;
  evidence: string;
  suggestion: string;
  created_at: number;
  source: 'heuristic' | 'llm';
}

/** Token usage extracted by the proxy from one API response. */
export interface ParsedUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SelfSpend {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}
