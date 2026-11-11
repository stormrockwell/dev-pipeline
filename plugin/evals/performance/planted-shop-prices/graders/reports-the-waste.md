---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/findings-performance.json }
pattern: '"axis": "performance"[\s\S]*get_post_meta'
---

The loop reads each price with its own get_post_meta query, so the reviewer reports it.
