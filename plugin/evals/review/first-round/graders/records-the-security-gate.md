---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/ledger.jsonl }
pattern: '"gate":"quick security review","result":"(pass|fail)","note":"round 1, [^"]+","head":"[0-9a-f]{40}"'
---

Merge records the security gate's result with the commit it judged, so a later commit leaves it stale.
