---
type: regex
target: trace
pattern: '"name":"Skill","input":\{"skill":"(?:[\w-]+:)?work-order"|"name":"Read","input":\{"file_path":"[^"]*skills/work-order/SKILL\.md"'
---

The router may start the work order through the Skill tool or by reading the skill file, and both load the same steps.
