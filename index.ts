/**
 * Pi Recurse Extension
 * 
 * Enables programmatic recursive subagent spawning with guardrails.
 * The key capability: LLM makes ONE tool call, extension code handles
 * parallel spawning and result aggregation without autoregressive steps.
 * 
 * Usage:
 *   recurse({ mode: "single", prompt: "Analyze src/auth.ts" })
 *   recurse({ mode: "parallel", tasks: [...], concurrency: 4 })
 *   recurse({ mode: "chain", chain: [...] })
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { 
  RecurseParams, 
  RecurseResult, 
  SubagentResult,
  SubagentProgress,
  RecurseSingleParams,
  RecurseParallelParams,
  RecurseChainParams 
} from "./types.js";
import {
  getCurrentDepth,
  getMaxDepth,
  getTraceId,
  checkDepthGuard,
  checkCallGuard,
  checkTimeoutGuard,
  checkBudgetGuard,
  spawnSubagent,
  runParallel,
  getRecursiveSystemPrompt,
  loadAccumulatedCost,
  saveAccumulatedCost,
  DEFAULTS,
} from "./lib.js";
import { 
  renderParallelStatus, 
  renderSubagentStatus, 
  formatDuration, 
  formatTokens,
  renderRecurseTree,
  buildRecurseTree,
} from "./formatters.js";
import { formatAgentLabel } from "./names.js";

export default function piRecurseExtension(pi: ExtensionAPI) {
  // ============================================================================
  // State
  // ============================================================================
  
  const currentDepth = getCurrentDepth();
  const maxDepth = getMaxDepth();
  const isDeep = currentDepth > 0;
  
  // At deep depths, disable the recurse tool entirely
  const disableToolAt = parseInt(process.env.RLM_DISABLE_TOOL_AT || String(DEFAULTS.DISABLE_TOOL_AT_DEPTH), 10);
  const toolEnabled = currentDepth < disableToolAt;
  
  // ============================================================================
  // System Prompt Injection
  // ============================================================================
  
  pi.on("before_agent_start", async (event) => {
    const modifiedPrompt = getRecursiveSystemPrompt(event.systemPrompt, currentDepth);
    return { systemPrompt: modifiedPrompt };
  });
  
  // ============================================================================
  // Status Indicator
  // ============================================================================
  
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI && toolEnabled) {
      const budget = checkBudgetGuard();
      const statusText = budget.remaining !== Infinity 
        ? `∞ depth ${currentDepth}/${maxDepth} · $${budget.remaining.toFixed(2)}`
        : `∞ depth ${currentDepth}/${maxDepth}`;
      ctx.ui.setStatus("recurse", statusText);
    }
  });
  
  // ============================================================================
  // Recurse Tool Registration
  // ============================================================================
  
  pi.registerTool({
    name: "recurse",
    label: "Recurse",
    description: toolEnabled
      ? `Spawn subagents programmatically. Mode "single" for one task, "parallel" for concurrent batch processing, "chain" for sequential dependency chains. Returns aggregated results.`
      : `[DISABLED at depth ${currentDepth}] Work directly instead of recursing.`,
    promptSnippet: "Delegate work to subagents in single/parallel/chain mode",
    promptGuidelines: [
      "Use recurse({ mode: 'single', prompt: '...' }) for one-off delegation.",
      "Use recurse({ mode: 'parallel', tasks: [...] }) for independent batch work.",
      "Use recurse({ mode: 'chain', chain: [...] }) when each step depends on the previous.",
      "Subagents return compact results; aggregate and synthesize in parent.",
      "Check result.stats before proceeding with expensive operations.",
    ],
    
    parameters: Type.Object({
      mode: StringEnum(["single", "parallel", "chain"] as const, {
        description: "Execution mode: single task, parallel batch, or sequential chain"
      }),
      
      // Single mode params
      prompt: Type.Optional(Type.String({ description: "Prompt for single mode" })),
      context: Type.Optional(Type.String({ description: "Context data to pipe to subagent" })),
      fork: Type.Optional(Type.Boolean({ description: "Fork session history (default: false)" })),
      
      // Parallel mode params
      tasks: Type.Optional(Type.Array(
        Type.Object({
          id: Type.String({ description: "Task identifier" }),
          prompt: Type.String({ description: "Subagent prompt" }),
          context: Type.Optional(Type.String({ description: "Task-specific context" })),
        }),
        { description: "Tasks for parallel execution" }
      )),
      concurrency: Type.Optional(Type.Number({ 
        description: "Max concurrent subagents", 
        default: DEFAULTS.CONCURRENCY 
      })),
      timeoutPerTask: Type.Optional(Type.Number({ 
        description: "Timeout per task in seconds" 
      })),
      
      // Chain mode params
      chain: Type.Optional(Type.Array(
        Type.Object({
          id: Type.String({ description: "Step identifier" }),
          prompt: Type.String({ description: "Step prompt (use {previous} for prior output)" }),
        }),
        { description: "Sequential chain steps" }
      )),
    }),
    
    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as RecurseParams;
      const startTime = Date.now();
      
      const depthCheck = checkDepthGuard();
      if (!depthCheck.allowed) {
        return {
          content: [{ type: "text", text: `Blocked: ${depthCheck.reason}` }],
          details: { blocked: true, reason: depthCheck.reason },
          isError: true,
        };
      }
      
      const callCheck = checkCallGuard();
      if (!callCheck.allowed) {
        return {
          content: [{ type: "text", text: `Blocked: ${callCheck.reason}` }],
          details: { blocked: true, reason: callCheck.reason },
          isError: true,
        };
      }
      
      const timeoutCheck = checkTimeoutGuard();
      if (!timeoutCheck.allowed) {
        return {
          content: [{ type: "text", text: `Blocked: ${timeoutCheck.reason}` }],
          details: { blocked: true, reason: timeoutCheck.reason },
          isError: true,
        };
      }
      
      const budgetCheck = checkBudgetGuard();
      if (!budgetCheck.allowed) {
        return {
          content: [{ type: "text", text: `Blocked: Budget exceeded ($${loadAccumulatedCost().toFixed(4)} spent)` }],
          details: { blocked: true, reason: "budget" },
          isError: true,
        };
      }
      
      // Execute based on mode
      let results: SubagentResult[];
      
      switch (params.mode) {
        case "single": {
          if (!params.prompt) {
            return {
              content: [{ type: "text", text: "Missing required 'prompt' for single mode" }],
              details: { error: "missing prompt" },
              isError: true,
            };
          }
          
          let currentData: { output: string; progress?: SubagentProgress } = { output: "", progress: { status: "running", recentOutput: [], recentTools: [], toolCount: 0, tokens: 0, durationMs: 0 } };
          const displayName = formatAgentLabel("subagent", true);
          
          const result = await spawnSubagent({
            prompt: params.prompt,
            context: params.context,
            fork: params.fork,
            onUpdate: onUpdate ? (data) => {
              currentData = data as { output: string; progress?: SubagentProgress };
              const lines = renderSubagentStatus("subagent", currentData, 100, true);
              onUpdate({
                content: [{ type: "text", text: lines.join("\n") }],
                details: { progress: data.progress },
              });
            } : undefined,
          });
          results = [result];
          break;
        }
        
        case "parallel": {
          if (!params.tasks || params.tasks.length === 0) {
            return {
              content: [{ type: "text", text: "Missing required 'tasks' array for parallel mode" }],
              details: { error: "missing tasks" },
              isError: true,
            };
          }
          
          const concurrency = params.concurrency || DEFAULTS.CONCURRENCY;
          onUpdate?.({ 
            content: [{ type: "text", text: `Spawning ${params.tasks.length} subagents (max ${concurrency} concurrent)...` }],
            details: {},
          });
          
          // Track progress for each task
          const taskProgress = new Map<string, { output: string; progress?: SubagentProgress }>();
          
          // Programmatic parallel spawning — NO LLM involvement between spawns
          results = await runParallel(
            params.tasks,
            async (task) => {
              taskProgress.set(task.id, { output: "", progress: { status: "running", recentOutput: [], recentTools: [], toolCount: 0, tokens: 0, durationMs: 0 } });
              
              const result = await spawnSubagent({
                prompt: task.prompt,
                context: task.context,
                timeout: params.timeoutPerTask,
                onUpdate: onUpdate ? (data) => {
                  taskProgress.set(task.id, data as { output: string; progress?: SubagentProgress });
                  // Render full multi-line status like pi-subagents
                  const statusText = renderParallelStatus(taskProgress);
                  onUpdate({
                    content: [{ type: "text", text: statusText }],
                    details: { taskProgress: Object.fromEntries(taskProgress) },
                  });
                } : undefined,
              });
              
              // IMPORTANT: Update with final result so status shows completed/failed
              if (onUpdate) {
                taskProgress.set(task.id, { 
                  output: result.output, 
                  progress: { 
                    status: result.success ? "completed" : "failed",
                    recentOutput: result.progress?.recentOutput || [],
                    recentTools: result.progress?.recentTools || [],
                    toolCount: result.progress?.toolCount || 0,
                    tokens: (result.usage?.input || 0) + (result.usage?.output || 0),
                    durationMs: result.durationMs,
                  }
                });
                const statusText = renderParallelStatus(taskProgress);
                onUpdate({
                  content: [{ type: "text", text: statusText }],
                  details: { taskProgress: Object.fromEntries(taskProgress) },
                });
              }
              
              return result;
            },
            concurrency
          );
          break;
        }
        
        case "chain": {
          if (!params.chain || params.chain.length === 0) {
            return {
              content: [{ type: "text", text: "Missing required 'chain' array for chain mode" }],
              details: { error: "missing chain" },
              isError: true,
            };
          }
          
          results = [];
          let previousOutput = "";
          
          for (const step of params.chain) {
            // Check cancellation
            if (signal?.aborted) {
              results.push({
                id: step.id,
                success: false,
                output: "",
                error: "Cancelled",
                durationMs: 0,
              });
              break;
            }
            
            // Substitute {previous} placeholder
            const prompt = step.prompt.replace(/\{previous\}/g, previousOutput);
            
            let stepData: { output: string; progress?: SubagentProgress } = { output: "", progress: { status: "running", recentOutput: [], recentTools: [], toolCount: 0, tokens: 0, durationMs: 0 } };
            const stepLabel = formatAgentLabel(step.id, true);
            
            const result = await spawnSubagent({
              prompt,
              onUpdate: onUpdate ? (data) => {
                stepData = data as { output: string; progress?: SubagentProgress };
                const lines = renderSubagentStatus(step.id, stepData, 100, true);
                // Show step in context of chain
                const header = `Step ${results.length + 1}/${params.chain!.length}: ${stepLabel}`;
                onUpdate({
                  content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
                  details: { 
                    stepId: step.id,
                    stepIndex: results.length + 1,
                    totalSteps: params.chain!.length,
                    stepProgress: data.progress,
                  },
                });
              } : undefined,
            });
            results.push(result);
            
            if (!result.success) {
              break; // Stop chain on failure
            }
            
            previousOutput = result.output;
          }
          break;
        }
        
        default:
          return {
            content: [{ type: "text", text: `Unknown mode: ${(params as any).mode}` }],
            details: { error: "unknown mode" },
            isError: true,
          };
      }
      
      // Calculate aggregated stats
      const succeeded = results.filter(r => r.success).length;
      const totalCost = results.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);
      
      // Update accumulated cost
      if (totalCost > 0) {
        const currentCost = loadAccumulatedCost();
        saveAccumulatedCost(currentCost + totalCost);
      }
      
      const totalDuration = Date.now() - startTime;
      const invocationId = Math.random().toString(36).substring(2, 10);
      
      const result: RecurseResult = {
        results,
        stats: {
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
          totalDurationMs: totalDuration,
          totalCost,
        },
        depth: currentDepth,
        mode: params.mode,
        invocationId,
      };
      
      // Format output
      const lines: string[] = [
        `## Recurse Results (depth ${currentDepth})`,
        "",
        `**Stats:** ${result.stats.succeeded}/${result.stats.total} succeeded · ${(result.stats.totalDurationMs / 1000).toFixed(1)}s${totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}`,
        "",
      ];
      
      for (const r of results) {
        const icon = r.success ? "✓" : "✗";
        const duration = (r.durationMs / 1000).toFixed(1);
        const stopReason = r.stopReason && r.stopReason !== "completed" ? ` [${r.stopReason}]` : "";
        lines.push(`### ${icon} ${r.id} (${duration}s)${stopReason}`);
        if (r.error) {
          lines.push(`**Error:** ${r.error}`);
        }
        lines.push(r.output || "*(no output)*");
        lines.push("");
      }
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
    
    // Custom rendering
    renderCall(args, theme) {
      const mode = (args.mode as string) || "single";
      const modeLabel = theme.fg("accent", mode);
      
      let detail = "";
      if (mode === "single" && args.prompt) {
        const prompt = String(args.prompt).slice(0, 40);
        detail = prompt.length < String(args.prompt).length ? `${prompt}...` : prompt;
      } else if (mode === "parallel" && args.tasks) {
        detail = `${(args.tasks as any[]).length} tasks`;
      } else if (mode === "chain" && args.chain) {
        detail = `${(args.chain as any[]).length} steps`;
      }
      
      const text = theme.fg("toolTitle", "recurse ") + 
                   modeLabel + 
                   (detail ? theme.fg("dim", ` "${detail}"`) : "");
      
      return new Text(text, 0, 0);
    },
    
    renderResult(result, { expanded }, theme) {
      const data = result.details as RecurseResult | undefined;
      if (!data) {
        return new Text(theme.fg("dim", "No result data"), 0, 0);
      }
      
      const { stats, depth, mode } = data;
      const icon = stats.failed === 0 ? theme.fg("success", "✓") : theme.fg("warning", "⚠");
      const hasChildren = data.results.some(r => r.children);
      
      let text = `${icon} ${stats.succeeded}/${stats.total} at depth ${depth}${mode ? ` · ${mode}` : ""}`;
      
      if (stats.totalCost && stats.totalCost > 0) {
        text += theme.fg("dim", ` · $${stats.totalCost.toFixed(4)}`);
      }
      
      if (hasChildren) {
        text += theme.fg("accent", " [has children]");
      }
      
      if (expanded) {
        if (hasChildren && mode) {
          // Render tree view
          const tree = buildRecurseTree(data, mode);
          const treeLines = renderRecurseTree(tree, 100);
          text += "\n" + treeLines.join("\n");
        } else {
          // Simple flat view
          text += "\n";
          for (const r of data.results) {
            const status = r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
            text += `  ${status} ${r.id}`;
            if (r.children) {
              text += theme.fg("accent", ` → ${r.children.stats.total} children`);
            }
            text += "\n";
          }
        }
      }
      
      return new Text(text, 0, 0);
    },
  });
  
  // ============================================================================
  // Commands
  // ============================================================================
  
  pi.registerCommand("recurse-status", {
    description: "Show current recursion status and guardrails",
    handler: async (_args, ctx) => {
      const depth = getCurrentDepth();
      const max = getMaxDepth();
      const budget = checkBudgetGuard();
      
      const lines = [
        "## Recurse Status",
        "",
        `**Current depth:** ${depth} / ${max}`,
        `**Tool enabled:** ${toolEnabled}`,
        `**Budget:** ${budget.remaining === Infinity ? "unlimited" : `$${budget.remaining.toFixed(2)} remaining`}`,
        `**Trace ID:** ${getTraceId()}`,
      ];
      
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
  
  // ============================================================================
  // Helper for StringEnum
  // ============================================================================
  
  function StringEnum<T extends readonly string[]>(
    values: T,
    options?: { description?: string; default?: T[number] },
  ) {
    return Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...(options?.description && { description: options.description }),
      ...(options?.default && { default: options.default }),
    });
  }
}
