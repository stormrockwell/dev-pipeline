---
type: regex
target: { source: file, path: .pipeline/work/feature/ledger.jsonl }
pattern: '"gate":"performance","result":"fail","note":"round 1, \d+ open"'
---

An open performance finding fails the performance gate for the round.
