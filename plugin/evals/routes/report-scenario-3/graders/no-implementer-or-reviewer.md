---
type: regex
target: trace
pattern: '"name":"(Task|Agent)","input":\{[^\n]*(implementer|reviewer)'
flags: 'i'
match: 'not_contains'
---
