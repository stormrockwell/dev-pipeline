---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: '[Ii]nitially|[Ff]irst (I )?tried|I tried|[Ww]e tried|[Aa]fter trying|[Tt]hen I |[Tt]he implementer|[Rr]ed run|[Ss]ubagent'
match: not_contains
---

The body describes the change, not the process that made it.
