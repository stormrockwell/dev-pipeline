---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/remember\.php'
---

The remember cookie is an unsigned serialized array, so a visitor forges one for any user id and is signed in as that user.
