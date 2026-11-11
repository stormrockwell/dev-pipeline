---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/account\.php'
---

The email change has no nonce, so another site can change a signed in user's address and then reset their password.
