---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/ledger.jsonl }
pattern: '"kind":"gate","at":"[^"]+","task":"1","gate":"spec","result":"(pass|fail)"'
---

Merge records the spec gate's result in the ledger.
