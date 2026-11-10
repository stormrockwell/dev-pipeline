---
name: answer
description: Answer a question about the code without changing anything.
disable-model-invocation: true
---

# Answer

Skip the `Route: answer` line, because an answer opens with the answer itself.

1. Read the code the question names, and follow the calls until the answer rests on what the code does rather than on names and comments.
2. Answer in a few sentences, with a `path:line` reference for each claim.
3. Leave the repo as you found it: no files, branches or commits. When the answer turns up a bug or a change worth making, end with one line offering the route that would handle it.
