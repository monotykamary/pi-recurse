/**
 * Type definitions for pi-recurse extension
 */

import type { Static } from "@sinclair/typebox";

// ============================================================================
// Guardrail Configuration
// ============================================================================

export interface GuardrailConfig {
  /** Maximum recursion depth (0 = root) */
  maxDepth: number;
  /** Maximum total recurse invocations across entire tree */
  maxCalls?: number;
  /** Maximum wall-clock seconds for entire recursive tree */
  timeout?: number;
  /** Maximum dollar spend for entire tree (e.g., 0.50) */
  budget?: number;
  /** Disable recurse tool when depth exceeds this threshold */
  disableToolAtDepth?: number;
}

// ============================================================================
// Recurse Tool Parameters
// ============================================================================

export interface RecurseSingleParams {
  /** The task/prompt to send to the subagent */
  prompt: string;
  /** Optional context data to pipe to subagent */
  context?: string;
  /** Use session fork to carry conversation history */
  fork?: boolean;
}

export interface RecurseParallelParams {
  /** Multiple tasks to run in parallel */
  tasks: Array<{
    /** Unique id for this task */
    id: string;
    /** Prompt for this subagent */
    prompt: string;
    /** Optional context for this specific task */
    context?: string;
  }>;
  /** Maximum concurrent subagents (default: 4) */
  concurrency?: number;
  /** Timeout per task in seconds */
  timeoutPerTask?: number;
}

export interface RecurseChainParams {
  /** Sequential tasks where each receives output from previous */
  chain: Array<{
    id: string;
    prompt: string;
    /** Template placeholder {previous} will be replaced with prior output */
  }>;
}

export type RecurseParams = 
  | ({ mode: "single" } & RecurseSingleParams)
  | ({ mode: "parallel" } & RecurseParallelParams)
  | ({ mode: "chain" } & RecurseChainParams);

// ============================================================================
// Subagent Progress Types (for streaming updates)
// ============================================================================

export interface SubagentProgress {
  /** Current status */
  status: "running" | "completed" | "failed";
  /** Current tool being executed (if any) */
  currentTool?: string;
  /** Arguments for current tool */
  currentToolArgs?: string;
  /** Recent output lines (last 50) */
  recentOutput: string[];
  /** Recent tools executed */
  recentTools: Array<{ tool: string; args: string; endMs?: number }>;
  /** Tool call count */
  toolCount: number;
  /** Token count (input + output) */
  tokens: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// ============================================================================
// Subagent Result Types
// ============================================================================

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  turns?: number;
}

export interface SubagentResult {
  /** Task id (for parallel/chain modes) */
  id: string;
  /** Exit status */
  success: boolean;
  /** Subagent response text */
  output: string;
  /** Any error message */
  error?: string;
  /** Why the subagent stopped (for debugging) - aligns with pi terminology */
  stopReason?: "completed" | "output-stabilization" | "timeout" | "error" | "stopped";
  /** Usage statistics (if available in JSON mode) */
  usage?: SubagentUsage;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Progress information (available during streaming) */
  progress?: SubagentProgress;
  /** Nested recurse results if this subagent called recurse */
  children?: RecurseResult;
}

/** Tree node for recursive agent visualization */
export interface RecurseTreeNode {
  id: string;
  mode: "single" | "parallel" | "chain";
  depth: number;
  status: "running" | "completed" | "failed";
  stats: {
    total: number;
    succeeded: number;
    failed: number;
    totalDurationMs: number;
    totalCost?: number;
  };
  children: RecurseTreeNode[];
  parentId?: string;
}

export interface RecurseResult {
  /** Results from all subagents */
  results: SubagentResult[];
  /** Aggregated statistics */
  stats: {
    total: number;
    succeeded: number;
    failed: number;
    totalDurationMs: number;
    totalCost?: number;
  };
  /** Current recursion depth */
  depth: number;
  /** Mode used for this recurse call */
  mode?: "single" | "parallel" | "chain";
  /** Parent recurse result (for tree traversal) */
  parent?: RecurseResult;
  /** Unique ID for this recurse invocation */
  invocationId?: string;
}

// ============================================================================
// Extension State
// ============================================================================

export interface RecurseState {
  /** Current depth (0 = root agent) */
  depth: number;
  /** Call count tracker for this session */
  callCount: number;
  /** Trace ID linking all recursive sessions */
  traceId: string;
  /** Epoch timestamp when root call started */
  startTime: number;
  /** Accumulated cost tracking */
  accumulatedCost: number;
}

// ============================================================================
// Environment Variable Types
// ============================================================================

export interface RecurseEnvironment {
  RLM_DEPTH: string;
  RLM_MAX_DEPTH: string;
  RLM_CALL_COUNT: string;
  RLM_MAX_CALLS?: string;
  RLM_TIMEOUT?: string;
  RLM_START_TIME?: string;
  RLM_BUDGET?: string;
  RLM_COST_FILE?: string;
  RLM_TRACE_ID?: string;
  RLM_CHILD_MODEL?: string;
  RLM_CHILD_PROVIDER?: string;
}
