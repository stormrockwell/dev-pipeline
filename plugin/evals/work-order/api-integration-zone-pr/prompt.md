---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash(pipeline *), Bash(git *)]
---

Add the first features to this plugin: a settings page where an admin saves the Acme API key, an API client that sends orders to Acme, a webhook endpoint Acme calls when an order ships, and the sync that sends an order whenever one is saved. Use `acme-orders` as the work order slug.
