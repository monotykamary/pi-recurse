/**
 * Formatting helpers for subagent progress display
 * Following pi-subagents patterns
 */

/**
 * Format token count with k/M suffixes
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

/**
 * Format usage info line
 */
export function formatUsage(usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input || usage.output) {
    parts.push(`${formatTokens(usage.input || 0)}↑ ${formatTokens(usage.output || 0)}↓`);
  }
  if (usage.cacheRead) parts.push(`${formatTokens(usage.cacheRead)}↺`);
  if (usage.cacheWrite) parts.push(`${formatTokens(usage.cacheWrite)}↻`);
  if (usage.cost !== undefined && usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`);
  }
  return parts.join(" · ") || "";
}

import { formatAgentLabel } from "./names.js";
import type { RecurseResult, RecurseTreeNode, SubagentResult } from "./types.js";

/**
 * Truncate text to max length with ellipsis
 * Uses Intl.Segmenter for proper Unicode handling
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncLine(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  
  let result = "";
  let count = 0;
  for (const seg of segmenter.segment(text)) {
    if (count >= maxWidth - 1) {
      return result + "…";
    }
    result += seg.segment;
    count++;
  }
  return result;
}

/**
 * Get status icon - uses distinct Unicode symbols instead of confusing "..."
 */
export function getStatusIcon(status: "running" | "completed" | "failed" | undefined): string {
  switch (status) {
    case "running": return "▶";  // Play icon - clearly indicates active
    case "completed": return "✓";  // Checkmark
    case "failed": return "✗";  // X mark
    default: return "○";  // Circle for pending/unknown
  }
}

/**
 * Build a tree structure from a RecurseResult for visualization
 */
export function buildRecurseTree(result: RecurseResult, mode: "single" | "parallel" | "chain", parentId?: string): RecurseTreeNode {
  const invocationId = result.invocationId || Math.random().toString(36).substring(2, 8);
  
  const node: RecurseTreeNode = {
    id: invocationId,
    mode,
    depth: result.depth,
    status: result.stats.failed === 0 ? "completed" : (result.stats.failed < result.stats.total ? "running" : "failed"),
    stats: result.stats,
    children: [],
    parentId,
  };
  
  // Build child nodes from subagent results that have their own recurse calls
  for (const subagent of result.results) {
    if (subagent.children) {
      const childNode = buildRecurseTree(subagent.children, subagent.children.mode || "single", invocationId);
      node.children.push(childNode);
    }
  }
  
  return node;
}

/**
 * Render a recurse tree with ASCII/Unicode tree drawing characters
 */
export function renderRecurseTree(
  node: RecurseTreeNode,
  maxWidth: number = 100,
  prefix: string = "",
  isLast: boolean = true,
  isRoot: boolean = true
): string[] {
  const lines: string[] = [];
  
  // Build the status line
  const icon = getStatusIcon(node.status);
  const modeLabel = node.mode;
  const stats = `${node.stats.succeeded}/${node.stats.total}`;
  const cost = node.stats.totalCost ? ` · $${node.stats.totalCost.toFixed(4)}` : "";
  const duration = formatDuration(node.stats.totalDurationMs);
  
  // Tree drawing characters
  const branch = isRoot ? "" : (isLast ? "└─ " : "├─ ");
  const indent = isRoot ? "" : prefix;
  
  const line = `${indent}${branch}${icon} ${modeLabel} [${stats}]${cost} · ${duration} (depth ${node.depth})`;
  lines.push(truncLine(line, maxWidth));
  
  // Render children
  if (node.children.length > 0) {
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLastChild = i === node.children.length - 1;
      const childLines = renderRecurseTree(child, maxWidth, childPrefix, isLastChild, false);
      lines.push(...childLines);
    }
  }
  
  return lines;
}

/**
 * Format a flat list of recurse results into a forest (multiple trees)
 */
export function renderRecurseForest(
  results: RecurseResult[],
  modes: ("single" | "parallel" | "chain")[],
  maxWidth: number = 100
): string {
  const allLines: string[] = [];
  
  for (let i = 0; i < results.length; i++) {
    const tree = buildRecurseTree(results[i], modes[i]);
    const lines = renderRecurseTree(tree, maxWidth);
    allLines.push(...lines);
    
    // Add separator between trees
    if (i < results.length - 1) {
      allLines.push("");
    }
  }
  
  return allLines.join("\n");
}

/**
 * Count total nodes in a recurse tree (for stats)
 */
export function countTreeNodes(node: RecurseTreeNode): number {
  let count = 1; // This node
  for (const child of node.children) {
    count += countTreeNodes(child);
  }
  return count;
}

/**
 * Find the deepest depth in a recurse tree
 */
export function getTreeMaxDepth(node: RecurseTreeNode): number {
  if (node.children.length === 0) {
    return node.depth;
  }
  let maxChildDepth = node.depth;
  for (const child of node.children) {
    maxChildDepth = Math.max(maxChildDepth, getTreeMaxDepth(child));
  }
  return maxChildDepth;
}

/**
 * Render subagent progress like pi-subagents
 */
export interface ProgressData {
  status: "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  recentTools?: Array<{ tool: string; args: string; endMs?: number }>;
  recentOutput?: string[];
  toolCount: number;
  tokens: number;
  durationMs: number;
}

/**
 * Format progress line: "... | 5 tools, 12.3k tok, 2.4s"
 */
export function formatProgressLine(data: ProgressData): string {
  const parts: string[] = [];
  if (data.toolCount > 0) parts.push(`${data.toolCount} tools`);
  if (data.tokens > 0) parts.push(`${formatTokens(data.tokens)} tok`);
  if (data.durationMs > 0) parts.push(`${formatDuration(data.durationMs)}`);
  return parts.join(", ");
}

/**
 * Render full subagent status with multi-line output
 * Mimics pi-subagents render.ts output
 */
export function renderSubagentStatus(
  id: string,
  data: { output: string; progress?: ProgressData },
  maxWidth: number = 100,
  useHumanizedName: boolean = true
): string[] {
  const lines: string[] = [];
  const p = data.progress;
  
  // Use humanized name for display
  const displayName = formatAgentLabel(id, useHumanizedName);
  
  // Status line: "▶ swift-fox (package.json) | 5 tools, 12.3k tok, 2.4s"
  const icon = getStatusIcon(p?.status);
  const metrics = p ? formatProgressLine(p) : "";
  const header = metrics ? `${icon} ${displayName} | ${metrics}` : `${icon} ${displayName}`;
  lines.push(truncLine(header, maxWidth));
  
  if (p?.status === "running") {
    // Current tool line: "> read: path: "file.ts"..."
    if (p.currentTool) {
      const args = p.currentToolArgs || "";
      const toolLine = args ? `> ${p.currentTool}: ${truncLine(args, maxWidth - 20)}` : `> ${p.currentTool}`;
      lines.push(toolLine);
    }
    
    // Recent tools (last 3)
    if (p.recentTools?.length) {
      for (const t of p.recentTools.slice(-3)) {
        const argsPreview = truncLine(t.args, maxWidth - 30);
        lines.push(`  ${t.tool}: ${argsPreview}`);
      }
    }
    
    // Recent output (last 5 lines)
    if (p.recentOutput?.length) {
      for (const line of p.recentOutput.slice(-5)) {
        lines.push(`  ${truncLine(line, maxWidth - 4)}`);
      }
    }
  }
  
  // If no progress detail but have output, show output preview
  if ((!p || p.status !== "running") && data.output) {
    const outputLines = data.output.split("\n").filter(l => l.trim()).slice(-3);
    for (const line of outputLines) {
      lines.push(`  ${truncLine(line, maxWidth - 4)}`);
    }
  }
  
  return lines;
}

/**
 * Render parallel task status list
 */
export function renderParallelStatus(
  taskProgress: Map<string, { output: string; progress?: ProgressData }>,
  maxWidth: number = 100,
  useHumanizedNames: boolean = true
): string {
  const allLines: string[] = [];
  
  for (const [id, data] of taskProgress) {
    const taskLines = renderSubagentStatus(id, data, maxWidth, useHumanizedNames);
    allLines.push(...taskLines);
    allLines.push(""); // Blank line between tasks
  }
  
  return allLines.join("\n").trim();
}
