---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/deploy-config\.php'
---

The SFTP password is committed in source, so anyone with the repository can write to the release server.
