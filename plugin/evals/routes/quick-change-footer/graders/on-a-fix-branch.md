---
type: regex
target: { source: 'file', path: '.git/HEAD' }
pattern: '^ref: refs/heads/(?!main\s*$)\S'
flags: 'm'
---
