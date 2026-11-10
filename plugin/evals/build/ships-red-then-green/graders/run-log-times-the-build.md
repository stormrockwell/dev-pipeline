---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/gate-record.json }
pattern: '"stages": \[[^\]]*"name": "build"'
---

The run log saw the build skill fire, so the gate record times the build stage.
