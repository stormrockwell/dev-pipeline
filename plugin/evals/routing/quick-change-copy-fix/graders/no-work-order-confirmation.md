---
type: regex
target: last_message
pattern: 'confirm\W.{0,60}work order|work order.{0,60}\Wconfirm'
flags: 'i'
match: not_contains
---
