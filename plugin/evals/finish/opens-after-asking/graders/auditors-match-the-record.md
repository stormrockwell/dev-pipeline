---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/pr-A.md }
pattern: '## Auditors\n\n- Ran: TDD, simplifier, standards, spec\n- Skipped: quick security review \(security reviewer not built yet\)\n\nCo-Authored using AI\n'
---

The Auditors list comes from the gate record: the passed gates ran, and the skipped one keeps its reason.
