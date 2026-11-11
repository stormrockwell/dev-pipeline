---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), src/reset\.js'
---

The reset token comes from Math.random, so an attacker predicts it and takes over an account.
