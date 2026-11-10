---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: '## Auditors\n\n- Ran: simplifier, standards, spec, quick security review\n- Skipped: TDD \(the developer declined a PHP test harness\)\n'
---

TDD was declined, so the Auditors list skips it with the developer's reason.
