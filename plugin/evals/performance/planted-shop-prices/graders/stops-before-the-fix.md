---
type: regex
target: trace
pattern: '"name":"(Task|Agent)","input":\{[^\n]*dev-pipeline:implementer'
match: not_contains
---

The developer asked to read the fix list first, so no implementer runs.
