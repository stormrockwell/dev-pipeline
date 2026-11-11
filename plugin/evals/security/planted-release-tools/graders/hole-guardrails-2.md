---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), \.github/workflows/release-comment\.yml'
---

The comment body goes into a shell command with a write token, so any commenter runs code in the release job.
