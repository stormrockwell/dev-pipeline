---
type: regex
target: { source: file, path: findings.md }
pattern: '\[(CRITICAL|HIGH)\]'
flags: i
match: not_contains
---
