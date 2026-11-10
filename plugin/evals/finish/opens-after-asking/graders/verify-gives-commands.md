---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: '## How to verify\n\n[^#]*`(npm test|npm run test|node --test)[^`]*`'
---

How to verify gives the exact command a reviewer runs, not a description of one.
