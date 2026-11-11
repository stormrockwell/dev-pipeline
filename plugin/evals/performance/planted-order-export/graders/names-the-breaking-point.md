---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/findings-performance.json }
pattern: '"axis": "performance"[\s\S]*100,?000'
---

The finding measures the code against the profile's ceiling of 100,000 orders.
