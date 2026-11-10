---
type: regex
target: trace
pattern: '"name":"(Task|Agent)","input":\{[^\n]*dev-pipeline:simplifier'
match: not_contains
---

The fix adds no function or branch and stays small, so the simplifier does not run again.
