# Recurse Skill

Use the `recurse` tool for programmatic subagent delegation.

## When to Use

- **Large files** that exceed context window → chunk and recurse
- **Batch analysis** of multiple files → parallel mode
- **Sequential pipelines** where step N depends on step N-1 → chain mode
- **Divide-and-conquer** refactoring → parallel tasks per file

## Mode Selection Guide

| Situation | Mode | Why |
|-----------|------|-----|
| One specific task | `single` | Simplest, direct |
| 10+ independent file reviews | `parallel` | Concurrent, fastest |
| Summary → Analysis → Plan | `chain` | Each step needs prior output |
| Cross-file refactoring | `parallel` with per-file tasks | Divide work, combine results |

## Example Patterns

### Parallel File Analysis
```typescript
const files = await findFiles("src/**/*.ts");
const results = await recurse({
  mode: "parallel",
  tasks: files.map(f => ({
    id: f,
    prompt: `Review ${f}: identify bugs, suggest improvements. Be concise.`
  })),
  concurrency: 4
});

// Aggregate
const issues = results.results.filter(r => r.output.includes("BUG"));
```

### Chain: Summarize → Analyze → Plan
```typescript
const plan = await recurse({
  mode: "chain",
  chain: [
    { id: "readme", prompt: "Summarize README.md in 3 bullet points" },
    { id: "risks", prompt: "Given this summary: {previous}, what are 3 implementation risks?" },
    { id: "mitigations", prompt: "Given these risks: {previous}, suggest mitigations for each" }
  ]
});
```

### Chunked Large File Processing
```typescript
const totalLines = await getLineCount("huge.log");
const chunkSize = 500;
const tasks = [];

for (let start = 1; start <= totalLines; start += chunkSize) {
  const end = Math.min(start + chunkSize - 1, totalLines);
  tasks.push({
    id: `lines-${start}-${end}`,
    prompt: `Extract ERROR entries from lines ${start}-${end}`,
    context: await readLines("huge.log", start, end)
  });
}

const errors = await recurse({ mode: "parallel", tasks });
```

## Guardrails

The extension automatically enforces limits:
- Max depth (default: 3)
- Max total calls (default: 100)
- Timeout (default: 600s)
- Budget (optional, via RLM_BUDGET)

At depth ≥ 3, the recurse tool is disabled. Work directly instead.

## Cost Awareness

Check result.stats after recurse calls:
```typescript
const result = await recurse({ mode: "parallel", tasks });
console.log(`Cost: $${result.stats.totalCost?.toFixed(4) || 'unknown'}`);
```
