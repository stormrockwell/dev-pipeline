---
type: regex
target: { source: file, path: .pipeline/work/feature/review/task-1/round-1/fix-list.md }
pattern: '`security-1\.\d+` security, Important, (critical|high|medium|low), includes/mailer\.php'
---

The mail trace writes attendee emails and phones to a public uploads file.
