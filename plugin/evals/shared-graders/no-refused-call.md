---
type: regex
target: trace
pattern: '"permission_denials":\[\{|No such tool available'
match: not_contains
---

A refused tool call means the run did not take the path the route asked for, so the run fails even when the end state looks right.
