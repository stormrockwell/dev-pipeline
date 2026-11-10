---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/gate-record.json }
pattern: '"task": "1",\s*"gate": "TDD",\s*"result": "pass"'
---

The gate record passes task 1's TDD gate from its red then green check.
