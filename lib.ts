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
  /** Callback for streaming progress updates */
  onUpdate?: (data: { output: string; progress: SubagentProgress }) => void;
}

export async function spawnSubagent(options: SpawnOptions): Promise<SubagentResult> {
  const startTime = Date.now();
  const id = Math.random().toString(36).substring(2, 8);
  const currentDepth = getCurrentDepth();
  const nextDepth = currentDepth + 1;
  const onUpdate = options.onUpdate;
  
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
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      
      childSessionFile = path.join(
        sessionDir, 
        `${traceId}_d${nextDepth}_${id}.jsonl`
      );
      
      if (options.fork) {
        const parentSessionFile = process.env.RLM_SESSION_FILE;
        if (parentSessionFile && fs.existsSync(parentSessionFile)) {
          fs.copyFileSync(parentSessionFile, childSessionFile);
        }
      }
      
      args.push("--session", childSessionFile);
      env.RLM_SESSION_FILE = childSessionFile;
    } else {
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
    
    let stderr = "";
    let timedOut = false;
    let processClosed = false;
    
    // Result accumulator
    const result: SubagentResult = {
      id,
      success: false,
      output: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      durationMs: 0,
      progress: {
        status: "running",
        recentOutput: [],
        recentTools: [],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      },
    };
    
    // Throttled update mechanism (like pi-subagents)
    let lastUpdateTime = 0;
    let updatePending = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const UPDATE_THROTTLE_MS = 50;
    
    const scheduleUpdate = () => {
      if (!onUpdate || processClosed) return;
      const now = Date.now();
      const elapsed = now - lastUpdateTime;
      
      if (elapsed >= UPDATE_THROTTLE_MS) {
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        lastUpdateTime = now;
        updatePending = false;
        result.progress!.durationMs = now - startTime;
        onUpdate({
          output: result.output,
          progress: result.progress!,
        });
      } else if (!updatePending) {
        updatePending = true;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (updatePending && !processClosed) {
            updatePending = false;
            lastUpdateTime = Date.now();
            result.progress!.durationMs = Date.now() - startTime;
            onUpdate({
              output: result.output,
              progress: result.progress!,
            });
          }
        }, UPDATE_THROTTLE_MS - elapsed);
      }
    };
    
    // Handle timeout
    const timeoutMs = (options.timeout || DEFAULTS.TIMEOUT) * 1000;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    
    // JSONL streaming parser
    let buf = "";
    
    const processLine = (line: string) => {
      if (!line.trim()) return;
      
      try {
        const evt = JSON.parse(line) as { 
          type?: string; 
          message?: { role?: string; content?: unknown; usage?: SubagentUsage; errorMessage?: string; model?: string };
          toolName?: string;
          args?: Record<string, unknown>;
        };
        
        const now = Date.now();
        result.progress!.durationMs = now - startTime;
        
        if (evt.type === "tool_execution_start") {
          result.progress!.toolCount++;
          result.progress!.currentTool = evt.toolName;
          result.progress!.currentToolArgs = extractToolArgsPreview(evt.args || {});
          // Force immediate update on tool start
          lastUpdateTime = 0;
          scheduleUpdate();
        }
        
        if (evt.type === "tool_execution_end") {
          if (result.progress!.currentTool) {
            result.progress!.recentTools.unshift({
              tool: result.progress!.currentTool,
              args: result.progress!.currentToolArgs || "",
              endMs: now,
            });
            if (result.progress!.recentTools.length > 5) {
              result.progress!.recentTools.pop();
            }
          }
          result.progress!.currentTool = undefined;
          result.progress!.currentToolArgs = undefined;
          scheduleUpdate();
        }
        
        if (evt.type === "message_end" && evt.message) {
          if (evt.message.role === "assistant") {
            result.usage!.turns = (result.usage!.turns || 0) + 1;
            const u = evt.message.usage;
            if (u) {
              result.usage!.input += u.input || 0;
              result.usage!.output += u.output || 0;
              result.usage!.cacheRead = (result.usage!.cacheRead || 0) + (u.cacheRead || 0);
              result.usage!.cacheWrite = (result.usage!.cacheWrite || 0) + (u.cacheWrite || 0);
              result.usage!.cost = (result.usage!.cost || 0) + (u.cost || 0);
              result.progress!.tokens = result.usage!.input + result.usage!.output;
            }
            if (!result.model && evt.message.model) {
              (result as any).model = evt.message.model;
            }
            if (evt.message.errorMessage) {
              result.error = evt.message.errorMessage;
            }
            
            // Extract text content
            const text = extractTextFromContent(evt.message.content);
            if (text) {
              const lines = text.split("\n").filter(l => l.trim()).slice(-10);
              result.progress!.recentOutput.push(...lines);
              if (result.progress!.recentOutput.length > 50) {
                result.progress!.recentOutput.splice(0, result.progress!.recentOutput.length - 50);
              }
              // Append to full output
              result.output += (result.output ? "\n" : "") + text;
            }
          }
          scheduleUpdate();
        }
        
        if (evt.type === "tool_result_end" && evt.message) {
          // Also capture tool result text
          const toolText = extractTextFromContent(evt.message.content);
          if (toolText) {
            const toolLines = toolText.split("\n").filter(l => l.trim()).slice(-10);
            result.progress!.recentOutput.push(...toolLines);
            if (result.progress!.recentOutput.length > 50) {
              result.progress!.recentOutput.splice(0, result.progress!.recentOutput.length - 50);
            }
          }
          scheduleUpdate();
        }
      } catch {
        // Non-JSON lines are expected; only structured events are parsed
      }
    };
    
    // Collect stderr
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    
    // Stream stdout (JSONL events)
    child.stdout?.on("data", (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      lines.forEach(processLine);
      scheduleUpdate();
    });
    
    // Handle completion
    child.on("close", (code) => {
      processClosed = true;
      clearTimeout(timeoutId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      
      // Process remaining buffer
      if (buf.trim()) processLine(buf);
      
      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;
      result.success = code === 0 && !timedOut && !result.error;
      result.progress!.status = result.success ? "completed" : "failed";
      
      // Check for prompt too long error in stderr
      if (stderr) {
        if (stderr.includes("prompt is too long")) {
          result.error = `Context too large for subagent. Pass smaller context or use file references. Original: ${stderr}`;
        } else if (code !== 0 && !result.error) {
          result.error = stderr.trim();
        }
      }
      
      if (timedOut) {
        result.error = `Timeout after ${options.timeout || DEFAULTS.TIMEOUT}s`;
      }
      
      // Clean up empty usage
      if (result.usage && !result.usage.input && !result.usage.output && !result.usage.cost) {
        delete result.usage;
      }
      // Clean up progress if not needed externally
      if (!onUpdate) {
        delete result.progress;
      }
      
      resolve(result);
    });
    
    // Handle spawn errors
    child.on("error", (err) => {
      processClosed = true;
      clearTimeout(timeoutId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
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

// Helper: Extract text from message content
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        if (c.text) return c.text;
        if (c.type === "text") return c.text || "";
      }
      return "";
    }).join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

// Helper: Extract tool args preview
function extractToolArgsPreview(args: Record<string, unknown>): string {
  const keys = Object.keys(args).slice(0, 3);
  const preview = keys.map(k => {
    const v = args[k];
    if (typeof v === "string") return `${k}: "${v.slice(0, 30)}${v.length > 30 ? "..." : ""}"`;
    return `${k}: ${JSON.stringify(v).slice(0, 40)}`;
  }).join(", ");
  return keys.length < Object.keys(args).length ? `${preview}, ...` : preview;
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
