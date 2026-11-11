---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), \.github/workflows/preview\.yml'
---

The workflow runs the pull request's own code with the repository's secrets, so a fork's build script steals the deploy token.
