---
type: regex
target: last_message
pattern: '(worktree add|worktree setup|prepar\w* (the |a |each )?worktree)[\s\S]{0,600}(script|pipeline CLI|pipeline \w+ command)|(script|pipeline CLI)[\s\S]{0,600}(worktree add|worktree setup|prepar\w* (the |a |each )?worktree)'
flags: 'i'
---

The worktree setup repeats with the same inputs in every implementer, so it is mechanical and becomes a script.
