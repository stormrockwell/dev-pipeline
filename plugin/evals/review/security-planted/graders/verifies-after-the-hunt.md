---
type: tool_order
before: { tool: 'Agent', input_match: 'dev-pipeline:security-hunter' }
after: { tool: 'Agent', input_match: 'dev-pipeline:security-verifier' }
---

A fresh verifier judges the hunter's candidate after the hunt, because the agent that finds a vulnerability never validates it.
