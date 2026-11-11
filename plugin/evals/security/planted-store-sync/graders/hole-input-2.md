---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/return-link\.php'
---

The return link redirects to any address in the request, so a phishing link leaves the site through its own domain.
