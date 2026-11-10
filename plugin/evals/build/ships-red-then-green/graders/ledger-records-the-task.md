---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/ledger.jsonl }
pattern: '"kind":"task","at":"[^"]+","task":"1","status":"DONE(_WITH_CONCERNS)?"[^\n]*"evidence":"red then green"'
---

The task's passing check lands in the work order's ledger, so a resumed build knows task 1 is settled.
