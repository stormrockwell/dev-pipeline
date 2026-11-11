---
type: regex
target: { source: file, path: .pipeline/work/banner/ledger.jsonl }
pattern: '"gate":"quick security review","result":"pass","note":"round 1, no open findings","head":"[0-9a-f]{40}"'
---

The route checks manage_options, so the security gate passes at the commit it judged.
