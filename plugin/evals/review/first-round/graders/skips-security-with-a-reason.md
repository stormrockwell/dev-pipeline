---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/ledger.jsonl }
pattern: '"gate":"quick security review","result":"skip","note":"the security reviewer ships in 3.1"'
---

The tier's security gate is recorded as skipped with its reason, never silently dropped.
