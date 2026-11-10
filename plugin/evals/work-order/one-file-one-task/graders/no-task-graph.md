---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/work-order.md }
pattern: '^\s*(needs|interfaces|state):'
flags: m
match: not_contains
---
