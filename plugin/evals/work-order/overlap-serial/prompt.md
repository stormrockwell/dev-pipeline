---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash(pipeline *), Bash(git *)]
---

Two changes to includes/shipping.php, as two separate tasks: add a surcharge of 2 per kg over 10 kg, and add a holiday override that makes shipping free while the option shop_demo_holiday is on. Use `shipping-rules` as the work order slug.
