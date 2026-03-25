/**
 * Humanized name generation for subagents
 * Inspired by pi-messenger's generateMemorableName
 */

const ADJECTIVES = [
  "swift", "bright", "clever", "steady", "sharp", "keen", "bold", "calm",
  "rapid", "silent", "fierce", "gentle", "brave", "wise", "nimble", "quick",
  "sage", "witty", "brisk", "lively", "eager", "alert", "daring", "smooth",
  "crisp", "fresh", "grand", "noble", "proud", "tough", "warm", "cool",
  "neat", "tidy", "vivid", "zesty", "agile", "prime", "slick", "snappy"
];

const NOUNS = [
  "fox", "owl", "bear", "wolf", "hawk", "lynx", "puma", "stag",
  "eagle", "raven", "crow", "swan", "crane", "falcon", "badger", "otter",
  "seal", "orca", "shark", "tiger", "panda", "moose", "elk", "bison",
  "cobra", "viper", "gecko", "ibex", "koala", "lemur", "llama", "macaw",
  "newt", "quail", "robin", "snake", "tapir", "urial", "vole", "wren"
];

/**
 * Generate a memorable name like "swift-fox" or "bright-owl"
 */
export function generateMemorableName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Generate a name based on task ID (for consistency)
 */
export function generateNameForTask(taskId: string): string {
  // Use hash of taskId to pick consistent name
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = ((hash << 5) - hash) + taskId.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  const adjIndex = Math.abs(hash) % ADJECTIVES.length;
  const nounIndex = Math.abs(hash >> 8) % NOUNS.length;
  return `${ADJECTIVES[adjIndex]}-${NOUNS[nounIndex]}`;
}

/**
 * Create a display label for a subagent
 * Combines humanized name with task ID for clarity
 */
export function formatAgentLabel(taskId: string, useHumanized: boolean = true): string {
  if (!useHumanized) return taskId;
  
  // If taskId is already short and readable, use it directly
  if (taskId.length <= 20 && !taskId.includes("/") && !taskId.includes("\\")) {
    return taskId;
  }
  
  // Otherwise, generate a memorable name and append short task hint
  const name = generateNameForTask(taskId);
  const shortId = taskId.split(/[/\\]/).pop()?.slice(0, 15) || taskId.slice(0, 15);
  return `${name} (${shortId})`;
}
