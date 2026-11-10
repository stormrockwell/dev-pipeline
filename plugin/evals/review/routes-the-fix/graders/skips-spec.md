---
type: regex
target: trace
pattern: '"name":"(Task|Agent)","input":\{[^\n]*dev-pipeline:spec-reviewer'
match: not_contains
---

The fix changes no behavior beyond the named lines, so spec does not run again.
