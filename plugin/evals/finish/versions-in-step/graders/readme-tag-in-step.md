---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/worktrees/pr-A/readme.txt }
pattern: '\nStable tag: 1\.2\.0\n'
---

The readme stable tag lagged the plugin header, so finish brings it into step with the header's version.
