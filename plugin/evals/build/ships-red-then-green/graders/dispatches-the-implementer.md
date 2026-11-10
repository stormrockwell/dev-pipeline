---
type: regex
target: trace
pattern: '"name":"(Task|Agent)","input":\{[^\n]*dev-pipeline:implementer'
---

The orchestrator hands the task to the implementer agent instead of editing the code itself.
