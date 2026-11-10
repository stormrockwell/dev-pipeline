---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/worktrees/1/.pipeline/task/evidence.jsonl }
pattern: '"phase":"red"[^\n]*"ok":true[\s\S]*"phase":"green"[^\n]*"ok":true'
---

The evidence log holds a counted red run, then a counted green run.
