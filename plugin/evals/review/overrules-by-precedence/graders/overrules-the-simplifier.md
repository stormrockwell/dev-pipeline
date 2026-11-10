---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/ledger.jsonl }
pattern: '"kind":"ruling"[^\n]*Overruled simplifier-1\.1[^\n]*in favor of spec-1\.1'
---

Spec's correctness finding and the simplifier's readability finding pull the constant in opposite directions, so precedence overrules the simplifier and the ledger records the ruling.
