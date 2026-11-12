---
type: regex
target: last_message
pattern: 'npm test[\s\S]{0,500}(flak|environment)|(flak|environment)[\s\S]{0,500}npm test'
flags: 'i'
---

Two runs passed a failing npm test on an identical rerun with no edit, which is a flaky test or environment.
