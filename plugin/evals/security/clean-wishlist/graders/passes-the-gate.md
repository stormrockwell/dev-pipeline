---
type: regex
target: { source: file, path: .pipeline/work/feature/ledger.jsonl }
pattern: '"gate":"quick security review","result":"pass","note":"round 1, no open findings","head":"[0-9a-f]{40}"'
---

With no open security finding, the security gate passes at the commit it judged.
