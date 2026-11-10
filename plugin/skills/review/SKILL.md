---
name: review
description: Force the review route for the current branch or a named scope.
disable-model-invocation: true
argument-hint: "[scope]"
---

Open with `Route: review, because /review forces it.` When the scope is a task of a work order in `.pipeline/work/`, review it with the dev-pipeline:review-loop skill. The reviewers check a diff against the work order that asked for it, so for any other scope, offer the report route's audit instead: $ARGUMENTS
