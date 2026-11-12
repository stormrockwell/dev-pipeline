---
type: regex
target: { source: file, path: .pipeline/work/feature/worktrees/1/includes/export.php }
pattern: 'paginat|LIMIT|OFFSET|wp_schedule|as_enqueue|chunk|batch|stream|fputcsv'
flags: 'i'
match: not_contains
---

No pagination, batching, streaming or job appears in the export, because machinery waits for a yes.
