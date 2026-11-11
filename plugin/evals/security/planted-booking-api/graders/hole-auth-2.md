---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), src/auth-middleware\.js'
---

The middleware reads the token's claims without verifying its signature, so a visitor forges a token for any user.
