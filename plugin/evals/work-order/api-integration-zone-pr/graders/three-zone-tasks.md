---
type: regex
target: { source: file, path: .pipeline/work/acme-orders/work-order.md }
pattern: '(tier:\s*T3[\s\S]*){3}'
---

The settings page, the API client and the webhook each touch a zone: secret storage, outbound requests and an unauthenticated endpoint.
