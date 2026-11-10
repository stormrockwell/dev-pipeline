---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: 'Co-Authored using AI\n\n<!-- pipeline:gate-record\n\{"version":1,"work":"free-shipping"[^\n]*\}\n-->\n$'
---

The gate record rides at the end of the body as a hidden comment.
