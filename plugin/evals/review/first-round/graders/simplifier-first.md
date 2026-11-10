---
type: tool_order
before: { tool: 'Agent', input_match: 'dev-pipeline:simplifier' }
after: { tool: 'Agent', input_match: 'dev-pipeline:spec-reviewer' }
---

The simplifier edits before the other reviewers read the diff.
