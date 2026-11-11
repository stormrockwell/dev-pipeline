---
type: regex
target: { source: file, path: .pipeline/work/banner/review/task-1/round-1/merged.json }
pattern: '"axis": "security"'
match: not_contains
---

The clean control has no vulnerability, so no security finding survives the verifier.
