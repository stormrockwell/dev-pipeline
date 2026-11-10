---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/work-order.md }
pattern: '-\s+id:[\s\S]*\n\s*-\s+id:'
match: not_contains
---
