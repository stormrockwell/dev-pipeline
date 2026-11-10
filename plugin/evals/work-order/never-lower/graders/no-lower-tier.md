---
type: regex
target: { source: file, path: .pipeline/work/orders-export/work-order.md }
pattern: 'tier:\s*T[012]\b'
match: not_contains
---
