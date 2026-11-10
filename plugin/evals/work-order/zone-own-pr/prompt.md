---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash(pipeline *), Bash(git *)]
---

Add a CSV export of orders to the orders admin page: a formatter that turns orders into CSV rows, an admin-post handler that checks the capability and a nonce and streams the file, and a styled download button. Use `orders-csv` as the work order slug.
