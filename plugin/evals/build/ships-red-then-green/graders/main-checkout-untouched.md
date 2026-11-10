---
type: regex
target: { source: file, path: src/shipping.js }
pattern: 'total > FREE_SHIPPING_THRESHOLD'
---

The task's code lands on its worktree branch, so the main checkout keeps the old comparison.
