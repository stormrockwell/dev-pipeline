---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: '[Gg]ates? (all )?(passed|were|was)|gate-record\.json|[Gg]ate results|[Tt]he ledger'
match: not_contains
---

Gate results belong to the generated Auditors list, so the prose leaves them out.
