---
type: regex
target: { source: file, path: .pipeline/work/banner/ledger.jsonl }
pattern: '"gate":"quick security review","result":"fail","note":"round 1, \d+ open","head":"[0-9a-f]{40}"'
---

An open Important security finding fails the security gate at the commit it judged.
