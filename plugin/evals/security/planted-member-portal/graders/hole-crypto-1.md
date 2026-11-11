---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/pin\.php'
---

The PIN is stored as an unsalted md5, so a leaked row is cracked at once.
