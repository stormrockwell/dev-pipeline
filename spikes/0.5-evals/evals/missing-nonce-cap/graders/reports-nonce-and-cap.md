---
type: regex
target: { source: file, path: findings.md }
pattern: '(?=[\s\S]*nonce)(?=[\s\S]*(capabilit|current_user_can))'
flags: i
---
