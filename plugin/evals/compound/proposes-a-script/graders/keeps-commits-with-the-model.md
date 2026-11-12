---
type: regex
target: last_message
pattern: '^[^\n]*(script|command)[^\n]*\b(generat|writ|compos|templat)\w* (the |a |each )?commit messages?'
flags: 'im'
match: not_contains
---

Committing repeats more often than the setup, but its message is judgment, so no script writes it.
