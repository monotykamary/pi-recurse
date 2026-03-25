/**
 * Core utilities for pi-recurse extension
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { 
  GuardrailConfig, 
  RecurseEnvironment, 
  RecurseState,
  SubagentResult,
  SubagentUsage 
} from "./types.js";

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULTS = {
  MAX_DEPTH: 3,
  MAX_CALLS: 100,
  TIMEOUT: 600, // 10 minutes
  CONCURRENCY: 4,
  DISABLE_TOOL_AT_DEPTH: 3,
} as const;

// ============================================================================
// Guardrail Management
// ============================================================================

export function getCurrentDepth(): number {
  return parseInt(process.env.RLM_DEPTH || "0", 10);
}

export function getMaxDepth(): number {
  return parseInt(process.env.RLM_MAX_DEPTH || String(DEFAULTS.MAX_DEPTH), 10);
}

export function getCallCount(): number {
  return parseInt(process.env.RLM_CALL_COUNT || "0", 10);
}

export function getTraceId(): string {
  return process.env.RLM_TRACE_ID || generateTraceId();
}

export function generateTraceId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function getStartTime(): number {
  return parseInt(process.env.RLM_START_TIME || String(Date.now()), 10);
}

export function checkDepthGuard(): { allowed: boolean; reason?: string } {
  const depth = getCurrentDepth();
  const maxDepth = getMaxDepth();
  
  if (depth >= maxDepth) {
    return {
      allowed: false,
      reason: `Max depth exceeded: at depth ${depth} of ${maxDepth}`,
    };
  }
  return { allowed: true };
}

export function checkCallGuard(maxCalls?: number): { allowed: boolean; reason?: string } {
  const current = getCallCount();
  const limit = maxCalls || parseInt(process.env.RLM_MAX_CALLS || String(DEFAULTS.MAX_CALLS), 10);
  
  if (current >= limit) {
    return {
      allowed: false,
      reason: `Max calls exceeded: ${current} of ${limit}`,
    };
  }
  return { allowed: true };
}

export function checkTimeoutGuard(timeout?: number): { allowed: boolean; reason?: string } {
  const startTime = getStartTime();
  const limit = timeout || parseInt(process.env.RLM_TIMEOUT || String(DEFAULTS.TIMEOUT), 10);
  const elapsed = (Date.now() - startTime) / 1000;
  
  if (elapsed > limit) {
    return {
      allowed: false,
      reason: `Timeout exceeded: ${elapsed.toFixed(0)}s of ${limit}s`,
    };
  }
  return { allowed: true };
}

export function buildChildEnvironment(): NodeJS.ProcessEnv {
  const currentDepth = getCurrentDepth();
  const nextDepth = currentDepth + 1;
  
  return {
    ...process.env,
    RLM_DEPTH: String(nextDepth),
    RLM_CALL_COUNT: String(getCallCount() + 1),
    RLM_TRACE_ID: getTraceId(),
    RLM_START_TIME: String(getStartTime()),
  };
}

// ============================================================================
// Subagent Spawning
// ============================================================================

export interface SpawnOptions {
  prompt: string;
  context?: string;
  fork?: boolean;
  timeout?: number;
  model?: string;
  provider?: string;
}

export async function spawnSubagent(options: SpawnOptions): Promise<SubagentResult> {
  const startTime = Date.now();
  const id = Math.random().toString(36).substring(2, 8);
  const currentDepth = getCurrentDepth();
  const nextDepth = currentDepth + 1;
  
  // Check guardrails before spawning
  const depthCheck = checkDepthGuard();
  if (!depthCheck.allowed) {
    return {
      id,
      success: false,
      output: "",
      error: depthCheck.reason,
      durationMs: Date.now() - startTime,
    };
  }
  
  const timeoutCheck = checkTimeoutGuard(options.timeout);
  if (!timeoutCheck.allowed) {
    return {
      id,
      success: false,
      output: "",
      error: timeoutCheck.reason,
      durationMs: Date.now() - startTime,
    };
  }
  
  // Context size limit - prevent "prompt too long" errors
  // Max ~200k tokens ≈ 4M chars at 20 chars/token
  const MAX_CONTEXT_CHARS = 4_000_000;
  let context = options.context || "";
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS) + 
      `\n\n[Context truncated: ${context.length} chars > ${MAX_CONTEXT_CHARS} limit]`;
  }
  
  return new Promise((resolve) => {
    const env = buildChildEnvironment();
    const args = ["--mode", "json", "-p", options.prompt];
    
    // Session file handling (like ypi/rlm_query)
    const sessionDir = process.env.RLM_SESSION_DIR;
    const traceId = getTraceId();
    let childSessionFile: string | undefined;
    
    if (sessionDir) {
      // Ensure session directory exists
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      
      // Create child session file path
      childSessionFile = path.join(
        sessionDir, 
        `${traceId}_d${nextDepth}_${id}.jsonl`
      );
      
      // If fork is enabled, copy parent session to child
      if (options.fork) {
        const parentSessionFile = process.env.RLM_SESSION_FILE;
        if (parentSessionFile && fs.existsSync(parentSessionFile)) {
          fs.copyFileSync(parentSessionFile, childSessionFile);
        }
      }
      
      args.push("--session", childSessionFile);
      env.RLM_SESSION_FILE = childSessionFile;
    } else {
      // No session directory - use fresh session (no history)
      args.push("--no-session");
    }
    
    // Add system prompt if available
    const systemPromptPath = process.env.RLM_SYSTEM_PROMPT;
    if (systemPromptPath && fs.existsSync(systemPromptPath)) {
      args.push("--system-prompt", systemPromptPath);
    }
    
    // Model override
    if (options.model) {
      args.push("--model", options.model);
    } else if (env.RLM_CHILD_MODEL) {
      args.push("--model", env.RLM_CHILD_MODEL);
    }
    
    // Provider override  
    if (options.provider) {
      args.push("--provider", options.provider);
    } else if (env.RLM_CHILD_PROVIDER) {
      args.push("--provider", env.RLM_CHILD_PROVIDER);
    }
    
    const child = spawn("pi", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    
    // Handle timeout
    const timeoutMs = (options.timeout || DEFAULTS.TIMEOUT) * 1000;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    
    // Collect stdout
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    
    // Collect stderr
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    
    // Handle completion
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;
      
      // Parse JSON mode output if possible
      let output = stdout;
      let usage: SubagentUsage | undefined;
      
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const parsed = JSON.parse(lastLine);
          if (parsed.content) {
            output = Array.isArray(parsed.content) 
              ? parsed.content.map((c: any) => c.text || "").join("")
              : String(parsed.content);
          }
          if (parsed.usage) {
            usage = {
              input: parsed.usage.input || 0,
              output: parsed.usage.output || 0,
              cacheRead: parsed.usage.cacheRead,
              cacheWrite: parsed.usage.cacheWrite,
              cost: parsed.usage.cost,
              turns: parsed.usage.turns,
            };
          }
        }
      } catch {
        // Not JSON, use raw stdout
      }
      
      const success = code === 0 && !timedOut;
      
      // Check for prompt too long error in stderr
      let error = timedOut 
        ? `Timeout after ${options.timeout || DEFAULTS.TIMEOUT}s` 
        : stderr || undefined;
      
      if (stderr && stderr.includes("prompt is too long")) {
        error = `Context too large for subagent. Pass smaller context or use file references. Original: ${stderr}`;
      }
      
      resolve({
        id,
        success,
        output: output.trim(),
        error,
        usage,
        durationMs,
      });
    });
    
    // Handle spawn errors
    child.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        id,
        success: false,
        output: "",
        error: `Failed to spawn subagent: ${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });
    
    // Send context via stdin if provided
    if (context) {
      child.stdin?.write(context);
    }
    child.stdin?.end();
  });
}

// ============================================================================
// Parallel Execution
// ============================================================================

export async function runParallel<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();
  
  for (const [index, item] of items.entries()) {
    const promise = fn(item).then((result) => {
      results[index] = result;
      executing.delete(promise); // Self-remove when done
    });
    
    executing.add(promise);
    
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  
  await Promise.all(executing);
  return results;
}

// ============================================================================
// System Prompt Helpers
// ============================================================================

export function getRecursiveSystemPrompt(basePrompt: string, depth: number): string {
  const isDeep = depth > 0;
  
  const recursionSection = `
## Recursive Agent Context

You are at recursion **depth ${depth}**${isDeep ? " (sub-agent)" : " (root agent)"}.

${isDeep ? `
**Guidelines for sub-agents:**
- Prefer **direct answers** over further delegation
- Only recurse if the task truly requires more context windows
- Check remaining budget/depth before spawning children
- Return compact, actionable results
` : `
**Guidelines for root agents:**
- Decompose large tasks via \`recurse\\\
- Spawn subagents in parallel for independent work
- Aggregate and synthesize results
- Monitor total cost and depth usage
`}

Environment:
- RLM_DEPTH=${depth}
- RLM_MAX_DEPTH=${getMaxDepth()}
- RLM_TRACE_ID=${getTraceId()}
`;

  return basePrompt + recursionSection;
}

// ============================================================================
// Cost Tracking
// ============================================================================

export function loadAccumulatedCost(): number {
  const costFile = process.env.RLM_COST_FILE;
  if (!costFile || !fs.existsSync(costFile)) {
    return 0;
  }
  try {
    const content = fs.readFileSync(costFile, "utf-8");
    return parseFloat(content) || 0;
  } catch {
    return 0;
  }
}

export function saveAccumulatedCost(cost: number): void {
  const costFile = process.env.RLM_COST_FILE;
  if (costFile) {
    try {
      fs.writeFileSync(costFile, cost.toFixed(6), "utf-8");
    } catch {
      // Ignore write errors
    }
  }
}

export function checkBudgetGuard(budget?: number): { allowed: boolean; remaining: number } {
  const limit = budget || parseFloat(process.env.RLM_BUDGET || "0");
  if (limit <= 0) {
    return { allowed: true, remaining: Infinity };
  }
  
  const current = loadAccumulatedCost();
  const remaining = limit - current;
  
  return {
    allowed: remaining > 0,
    remaining,
  };
}
