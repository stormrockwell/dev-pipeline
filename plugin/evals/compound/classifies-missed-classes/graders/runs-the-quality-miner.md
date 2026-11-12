---
type: tool_used
tool: Bash
input_match: 'pipeline compound quality[^"\n]*--offline'
---

The skill counts the merged PR signals with the CLI before any model reads them, and passes --offline to the quality command.
