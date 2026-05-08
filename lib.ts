/**
 * Core utilities for pi-recurse extension
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  GuardrailConfig,
  RecurseEnvironment,
  RecurseState,
  SubagentResult,
  SubagentUsage,
  SubagentProgress,
} from './types.js';

export const DEFAULTS = {
  MAX_DEPTH: 3,
  MAX_CALLS: 100,
  TIMEOUT: 600, // 10 minutes
  CONCURRENCY: 4,
  DISABLE_TOOL_AT_DEPTH: 3,
} as const;

export function getCurrentDepth(): number {
  return parseInt(process.env.RLM_DEPTH || '0', 10);
}

export function getMaxDepth(): number {
  return parseInt(process.env.RLM_MAX_DEPTH || String(DEFAULTS.MAX_DEPTH), 10);
}

export function getCallCount(): number {
  return parseInt(process.env.RLM_CALL_COUNT || '0', 10);
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
      output: '',
      error: depthCheck.reason,
      durationMs: Date.now() - startTime,
    };
  }

  const timeoutCheck = checkTimeoutGuard(options.timeout);
  if (!timeoutCheck.allowed) {
    return {
      id,
      success: false,
      output: '',
      error: timeoutCheck.reason,
      durationMs: Date.now() - startTime,
    };
  }

  // Context size limit - prevent "prompt too long" errors
  // Max ~200k tokens ≈ 4M chars at 20 chars/token
  const MAX_CONTEXT_CHARS = 4_000_000;
  let context = options.context || '';
  if (context.length > MAX_CONTEXT_CHARS) {
    context =
      context.slice(0, MAX_CONTEXT_CHARS) +
      `\n\n[Context truncated: ${context.length} chars > ${MAX_CONTEXT_CHARS} limit]`;
  }

  return new Promise((resolve) => {
    const env = buildChildEnvironment();
    const args = ['--mode', 'json', '-p', options.prompt];

    // Session file handling (like ypi/rlm_query)
    const sessionDir = process.env.RLM_SESSION_DIR;
    const traceId = getTraceId();
    let childSessionFile: string | undefined;

    if (sessionDir) {
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      childSessionFile = path.join(sessionDir, `${traceId}_d${nextDepth}_${id}.jsonl`);

      if (options.fork) {
        const parentSessionFile = process.env.RLM_SESSION_FILE;
        if (parentSessionFile && fs.existsSync(parentSessionFile)) {
          fs.copyFileSync(parentSessionFile, childSessionFile);
        }
      }

      args.push('--session', childSessionFile);
      env.RLM_SESSION_FILE = childSessionFile;
    } else if (options.fork) {
      // Fork requested but no session dir - we need a temp session file
      const tmpDir = os.tmpdir();
      childSessionFile = path.join(tmpDir, `rlm_fork_${traceId}_${id}.jsonl`);
      const parentSessionFile = process.env.RLM_SESSION_FILE;
      if (parentSessionFile && fs.existsSync(parentSessionFile)) {
        fs.copyFileSync(parentSessionFile, childSessionFile);
        args.push('--session', childSessionFile);
        env.RLM_SESSION_FILE = childSessionFile;
      } else {
        // No parent session to fork - use no session
        args.push('--no-session');
      }
    } else {
      args.push('--no-session');
    }

    // Track temp files for cleanup
    const tmpDir = os.tmpdir();
    const tempFiles: string[] = [];

    // Add system prompt if available
    const systemPromptPath = process.env.RLM_SYSTEM_PROMPT;
    if (systemPromptPath && fs.existsSync(systemPromptPath)) {
      args.push('--system-prompt', systemPromptPath);
    }

    // Add instruction based on depth (nextDepth already defined in outer scope)
    const maxDepth = getMaxDepth();
    const isAtMaxDepth = nextDepth >= maxDepth;

    if (isAtMaxDepth) {
      // At max depth: one-shot mode, no further recursion possible
      const oneShotInstruction = `
## ONE-SHOT MODE - MANDATORY (MAX DEPTH)

You are at recursion depth ${nextDepth} of ${maxDepth}. **NO FURTHER RECURSION IS POSSIBLE.**

You MUST:
1. Complete your task in ONE response cycle (analyze and output immediately)
2. NEVER ask the user for clarification or additional input
3. If you need file contents, READ them yourself using the read tool
4. If information is missing, make reasonable assumptions and proceed
5. Do NOT output phrases like "Once you provide..." or "I'll analyze when..."
6. After outputting your analysis, IMMEDIATELY call: bash({ command: "exit 0" })
7. You have a hard limit of 15 tool calls - after that you will be terminated

VIOLATING THESE RULES WILL CAUSE YOUR OUTPUT TO BE REJECTED.
`;

      const oneShotPath = path.join(tmpDir, `rlm_oneshot_${id}.md`);
      fs.writeFileSync(oneShotPath, oneShotInstruction, { mode: 0o600 });
      args.push('--append-system-prompt', oneShotPath);
      tempFiles.push(oneShotPath);
    } else {
      // Below max depth: enable true recursion with guidance
      const recursionGuidance = `
## RECURSION ENABLED - DEPTH ${nextDepth}/${maxDepth}

You are a subagent with access to the \\\`recurse\\\` tool. You MAY use recursion when necessary.

### When to recurse (RECOMMENDED):
- Task requires analyzing 10+ files independently → \\\`recurse({ mode: \\'parallel\\', tasks: [...] })\\\`
- Task has sequential dependencies (summarize → analyze → plan) → \\\`recurse({ mode: \\'chain\\', chain: [...] })\\\`
- File is too large for your context window → \\\`recurse({ mode: \\'single\\', prompt: \\'Process chunk...\\' })\\\`
- Complex refactor across multiple files → Divide and conquer with parallel tasks

### Rules for recursion:
1. **Prefer direct answers for simple tasks** (< 5 files, < 200 lines each)
2. **Check remaining depth before recursing** - you are at depth ${nextDepth}, max is ${maxDepth}
3. **Return compact results** - parent aggregates, don't write essays
4. **NEVER ask users for clarification** - read files yourself, make assumptions, recurse if stuck
5. **One-shot mode**: Complete analysis and call \\\`bash({ command: \\'exit 0\\' })\\\` when done

### Example recursive call:
\\\`\\\`\\\`typescript
recurse({
  mode: "parallel",
  tasks: files.map(f => ({
    id: f,
    prompt: \\\`Review \\\${f}: identify bugs\\\`
  })),
  concurrency: 4
});
\\\`\\\`\\\`

You have ${maxDepth - nextDepth} recursion levels remaining. Use them wisely.
`;

      const guidancePath = path.join(tmpDir, `rlm_recursion_${id}.md`);
      fs.writeFileSync(guidancePath, recursionGuidance, { mode: 0o600 });
      args.push('--append-system-prompt', guidancePath);
      tempFiles.push(guidancePath);
    }

    // Model override (use --models like pi-subagents, not --model)
    if (options.model) {
      args.push('--models', options.model);
    } else if (env.RLM_CHILD_MODEL) {
      args.push('--models', env.RLM_CHILD_MODEL);
    }

    // Provider override
    if (options.provider) {
      args.push('--provider', options.provider);
    } else if (env.RLM_CHILD_PROVIDER) {
      args.push('--provider', env.RLM_CHILD_PROVIDER);
    }

    // Resolve pi command properly (like pi-subagents)
    const spawnCommand = getPiSpawnCommand(args);

    // Handle context: if present and small, append to prompt; if large, write to temp file
    let contextFile: string | undefined;
    const MAX_PROMPT_CHARS = 100_000; // Approximate safe limit for -p arg

    if (context) {
      if (context.length > MAX_PROMPT_CHARS) {
        // Write large context to temp file and reference it in prompt
        const tmpDir = os.tmpdir();
        contextFile = path.join(tmpDir, `rlm_ctx_${id}.txt`);
        fs.writeFileSync(contextFile, context, { mode: 0o600 });
        // Modify prompt to reference the file
        const modifiedPrompt = `${options.prompt}\n\n[Context available at: ${contextFile}]`;
        // Replace the last arg (original prompt) with modified
        spawnCommand.args[spawnCommand.args.length - 1] = modifiedPrompt;
      } else {
        // Small context - append directly to prompt
        const modifiedPrompt = `${options.prompt}\n\n${context}`;
        spawnCommand.args[spawnCommand.args.length - 1] = modifiedPrompt;
      }
    }

    const child = spawn(spawnCommand.command, spawnCommand.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin like pi-messenger
    }) as ReturnType<typeof spawn>;

    let stderr = '';
    let timedOut = false;
    let processClosed = false;

    // Result accumulator
    const result: SubagentResult = {
      id,
      success: false,
      output: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      durationMs: 0,
      progress: {
        status: 'running',
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
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const UPDATE_THROTTLE_MS = 50;

    // Track output stabilization to detect "hung but done" subagents (workaround for pi-mono #2584)
    let lastOutputTime = Date.now();
    let outputStabilizeTimer: ReturnType<typeof setTimeout> | null = null;
    const OUTPUT_STABILIZE_MS = 4000; // 4 seconds of no output = assume done

    const checkOutputStabilized = () => {
      if (processClosed) return;
      const timeSinceOutput = Date.now() - lastOutputTime;
      if (timeSinceOutput >= OUTPUT_STABILIZE_MS) {
        // Output has stabilized - assume subagent is done but hung
        // This is a workaround for pi-mono #2584 where extensions keep process alive
        result.error = `Subagent output stabilized but process did not exit (pi-mono #2584 workaround). Terminating after ${timeSinceOutput}ms of no output.`;
        child.kill('SIGTERM');
      } else {
        // Schedule next check
        outputStabilizeTimer = setTimeout(
          checkOutputStabilized,
          OUTPUT_STABILIZE_MS - timeSinceOutput
        );
      }
    };

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

    // Heartbeat: force update every second even if no data arrives
    // This prevents UI from appearing stuck during large outputs
    if (onUpdate) {
      heartbeatTimer = setInterval(() => {
        if (!processClosed && onUpdate) {
          result.progress!.durationMs = Date.now() - startTime;
          onUpdate({
            output: result.output,
            progress: result.progress!,
          });
        }
      }, 1000);
    }

    // Handle timeout
    const timeoutMs = (options.timeout || DEFAULTS.TIMEOUT) * 1000;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    // JSONL streaming parser
    let buf = '';

    const processLine = (line: string) => {
      if (!line.trim()) return;

      try {
        const evt = JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            content?: unknown;
            usage?: SubagentUsage;
            errorMessage?: string;
            model?: string;
          };
          toolName?: string;
          args?: Record<string, unknown>;
        };

        const now = Date.now();
        result.progress!.durationMs = now - startTime;

        if (evt.type === 'tool_execution_start') {
          result.progress!.toolCount++;
          result.progress!.currentTool = evt.toolName;
          result.progress!.currentToolArgs = extractToolArgsPreview(evt.args || {});
          // Force immediate update on tool start
          lastUpdateTime = 0;
          scheduleUpdate();
        }

        if (evt.type === 'tool_execution_end') {
          if (result.progress!.currentTool) {
            result.progress!.recentTools.unshift({
              tool: result.progress!.currentTool,
              args: result.progress!.currentToolArgs || '',
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

        if (evt.type === 'message_end' && evt.message) {
          if (evt.message.role === 'assistant') {
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
              const lines = text
                .split('\n')
                .filter((l) => l.trim())
                .slice(-10);
              result.progress!.recentOutput.push(...lines);
              if (result.progress!.recentOutput.length > 50) {
                result.progress!.recentOutput.splice(0, result.progress!.recentOutput.length - 50);
              }
              // Append to full output
              result.output += (result.output ? '\n' : '') + text;
            }
          }
          scheduleUpdate();
        }

        if (evt.type === 'tool_result_end' && evt.message) {
          // Also capture tool result text
          const toolText = extractTextFromContent(evt.message.content);
          if (toolText) {
            const toolLines = toolText
              .split('\n')
              .filter((l) => l.trim())
              .slice(-10);
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
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Stream stdout (JSONL events)
    child.stdout?.on('data', (data: Buffer) => {
      lastOutputTime = Date.now(); // Reset output stabilization timer
      if (outputStabilizeTimer) {
        clearTimeout(outputStabilizeTimer);
      }
      outputStabilizeTimer = setTimeout(checkOutputStabilized, OUTPUT_STABILIZE_MS);

      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      lines.forEach(processLine);
      scheduleUpdate();
    });

    // Handle completion - listen to both 'close' and 'exit' for robustness
    let resolved = false;
    const finalize = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      processClosed = true;
      clearTimeout(timeoutId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (outputStabilizeTimer) {
        clearTimeout(outputStabilizeTimer);
        outputStabilizeTimer = null;
      }

      // Clean up temp files
      for (const tmpFile of [contextFile, ...tempFiles]) {
        if (tmpFile) {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      // Process remaining buffer
      if (buf.trim()) processLine(buf);

      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;

      // Check if this was an output stabilization kill with actual output (pi-mono #2584 workaround)
      // In this case, the subagent completed its work but the process didn't exit cleanly
      const wasOutputStabilizationKill = result.error?.includes('output stabilized');
      const hasOutput = result.output.trim().length > 0;

      if (wasOutputStabilizationKill && hasOutput) {
        // Count as success - the subagent produced output before we killed the hung process
        result.success = true;
        result.stopReason = 'output-stabilization';
        result.error = undefined; // Clear the error since we have valid output
        result.progress!.status = 'completed';
      } else {
        result.success = code === 0 && !timedOut && !result.error;
        result.progress!.status = result.success ? 'completed' : 'failed';

        // Set stop reason for tracking
        if (timedOut) {
          result.stopReason = 'timeout';
        } else if (result.error) {
          result.stopReason = 'error';
        } else if (code !== null && code !== 0) {
          result.stopReason = 'stopped'; // matches pi-messenger terminology
        } else {
          result.stopReason = 'completed';
        }
      }

      // Check for prompt too long error in stderr
      if (stderr) {
        if (stderr.includes('prompt is too long')) {
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
    };

    child.on('close', (code) => finalize(code));
    child.on('exit', (code) => finalize(code));

    // Check if process already exited (happens with immediate failures)
    if (child.exitCode !== null) {
      finalize(child.exitCode);
    } else if (child.killed) {
      finalize(null);
    }

    // Safety: if process errors before spawning
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      processClosed = true;
      clearTimeout(timeoutId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Clean up temp files
      for (const tmpFile of [contextFile, ...tempFiles]) {
        if (tmpFile) {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
      resolve({
        id,
        success: false,
        output: result.output,
        error: `Failed to spawn subagent: ${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });

    // Context is now passed via temp file for large payloads, or prompt for small ones
    // No stdin handling needed - matches pi-messenger approach
  });
}

// Helper: Extract text from message content
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          if (c.text) return c.text;
          if (c.type === 'text') return c.text || '';
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

// Helper: Extract tool args preview
function extractToolArgsPreview(args: Record<string, unknown>): string {
  const keys = Object.keys(args).slice(0, 3);
  const preview = keys
    .map((k) => {
      const v = args[k];
      if (typeof v === 'string') return `${k}: "${v.slice(0, 30)}${v.length > 30 ? '...' : ''}"`;
      return `${k}: ${JSON.stringify(v).slice(0, 40)}`;
    })
    .join(', ');
  return keys.length < Object.keys(args).length ? `${preview}, ...` : preview;
}

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

export function getRecursiveSystemPrompt(basePrompt: string, depth: number): string {
  const isDeep = depth > 0;

  const recursionSection = `
## Recursive Agent Context

You are at recursion **depth ${depth}**${isDeep ? ' (sub-agent)' : ' (root agent)'}.

${
  isDeep
    ? `
**Guidelines for sub-agents:**
- Prefer **direct answers** over further delegation
- Only recurse if the task truly requires more context windows
- Check remaining budget/depth before spawning children
- Return compact, actionable results
`
    : `
**Guidelines for root agents:**
- Decompose large tasks via \`recurse\\\
- Spawn subagents in parallel for independent work
- Aggregate and synthesize results
- Monitor total cost and depth usage
`
}

Environment:
- RLM_DEPTH=${depth}
- RLM_MAX_DEPTH=${getMaxDepth()}
- RLM_TRACE_ID=${getTraceId()}
`;

  return basePrompt + recursionSection;
}

export function loadAccumulatedCost(): number {
  const costFile = process.env.RLM_COST_FILE;
  if (!costFile || !fs.existsSync(costFile)) {
    return 0;
  }
  try {
    const content = fs.readFileSync(costFile, 'utf-8');
    return parseFloat(content) || 0;
  } catch {
    return 0;
  }
}

export function saveAccumulatedCost(cost: number): void {
  const costFile = process.env.RLM_COST_FILE;
  if (costFile) {
    try {
      fs.writeFileSync(costFile, cost.toFixed(6), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }
}

export function checkBudgetGuard(budget?: number): { allowed: boolean; remaining: number } {
  const limit = budget || parseFloat(process.env.RLM_BUDGET || '0');
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

interface PiSpawnCommand {
  command: string;
  args: string[];
}

/**
 * Resolve the pi command properly.
 * On Windows: uses process.execPath with the pi CLI script
 * On other platforms: uses "pi" directly
 */
function getPiSpawnCommand(args: string[]): PiSpawnCommand {
  // On Windows, we need to spawn node with the pi CLI script
  if (process.platform === 'win32') {
    try {
      // Try to find pi CLI via require
      const piPkg = require.resolve('@earendil-works/pi-coding-agent/package.json');
      const piRoot = path.dirname(piPkg);
      const pkg = JSON.parse(fs.readFileSync(piPkg, 'utf-8'));
      const binField = pkg.bin;
      const binPath =
        typeof binField === 'string'
          ? binField
          : (binField?.pi ?? Object.values(binField ?? {})[0]);
      if (binPath) {
        const cliPath = path.resolve(piRoot, binPath);
        if (fs.existsSync(cliPath)) {
          return { command: process.execPath, args: [cliPath, ...args] };
        }
      }
    } catch {
      // Fall through to default
    }
  }

  // Default: use pi from PATH
  return { command: 'pi', args };
}
