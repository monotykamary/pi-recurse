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
