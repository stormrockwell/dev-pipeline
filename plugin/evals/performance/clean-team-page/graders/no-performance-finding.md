---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/merged.json }
pattern: '"axis": "performance"'
match: not_contains
---

The loop reads 50 members from a primed query under a declared ceiling of 50, so nothing is waste and nothing is scale.
