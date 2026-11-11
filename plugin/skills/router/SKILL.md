---
name: router
description: Pick the pipeline route before acting on a request to build, change, fix, debug, prototype, start a project, or review or report on code. Plain questions about code skip it.
---

# Router

Pick the lightest route that fits, name it, then start it.

1. Open your reply with one line, `Route: <route>, because <reason>.` The developer can redirect you with one word. An answer skips this line.
2. When the request fits two routes that differ a lot in cost, ask one question after the route line and stop until the developer replies. Ask only what the code and the request cannot tell you.
3. Start the route as the table says. A path means read that skill file and follow it.

| Route | Fits | Start |
|---|---|---|
| answer | a question about code, a hook, a file or the project | `${CLAUDE_PLUGIN_ROOT}/skills/answer/SKILL.md` |
| report | explain how a codebase works, or audit it, as a document | `${CLAUDE_PLUGIN_ROOT}/skills/report/SKILL.md` |
| quick change | a copy fix, a typo, a one-line style or config tweak with no change in behavior | `${CLAUDE_PLUGIN_ROOT}/skills/quick-change/SKILL.md` |
| change | a feature, a refactor, or any change to behavior, data or permissions | Explore, then draft a work order of tasks and owned files with the `dev-pipeline:work-order` skill. Wait for confirmation before editing code. |
| debug | something broken, failing or erroring | `${CLAUDE_PLUGIN_ROOT}/skills/debug/SKILL.md` |
| new project | a site, plugin or app from scratch | `${CLAUDE_PLUGIN_ROOT}/skills/bootstrap/SKILL.md` |
| spike | prototype, try out, see how something feels | `${CLAUDE_PLUGIN_ROOT}/skills/spike/SKILL.md` |

Questions worth asking:

- "Review" with no purpose: explain how the code works, or audit it for security and quality.
- "Demo" in a new project: throwaway, which makes it a spike, or maintained, which means bootstrap.

A misroute costs efficiency, never safety, because the floor, the security review and the merge rules run on every route that writes. Code that touches a zone, such as auth, payments, secrets, personal data, SQL, REST routes or uploads, is a change even when the diff is one line.
