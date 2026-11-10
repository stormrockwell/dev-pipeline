---
type: regex
target: { source: file, path: .pipeline/work/free-shipping/review/task-1/round-2/round.json }
pattern: '"scope": "fix",[\s\S]*"reviewers": \[\s*"standards"\s*\]'
---

A one-line fix on the named lines is a fix round for the one reviewer whose finding it fixes.
