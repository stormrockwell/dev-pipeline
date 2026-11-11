---
type: regex
target: { source: file, path: .pipeline/work/banner/review/task-1/round-1/fix-list.md }
pattern: 'review guide lists these as checks[^\n]*\n(\s+- [^\n]*\n)*\s+- [^\n]*(subscriber|logged.out|unauthenticated|anonymous|visitor|without manage_options|401|403)'
flags: 'i'
---

The finding names the test that proves the fix, such as a denied subscriber or a rejected logged-out request.
