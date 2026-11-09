# Development pipeline

The goal is to build a development system that will produce secure code by enforcing best practices. It will also enforce rules on how to create pull requests, write comments, etc. Tailored for web development with PHP/JS applications.

## Some key things to consider

1. Orchestrator (Opus)
1. Documentation agent (Haiku?)
1. Developer (Sonnet)
1. Reviewers (maybe open code review)
1. - Design reviewer (comparing design files like figma visuals programatically by wireframes/pixels instead of relying on mainly AI image recognision)
1. - Security/Pentester. Create a checklist, and do as much programatically as possible to try to break the code and find security issues. this one has some good things but probably need more, and might not fit into our process https://github.com/cloudflare/security-audit-skill. SECURITY REVIEWER IS THE MOST IMPORTANT HERE AND TRUMPS ALL REVIEWERS. need to rereview with each change
1. - Simplifier. This job is to understand the code, and adjust as needed based on the understanding and how it effects the larger picture of the site
1. - Performace. Check for waistful functions, or how things will scale. right now there is 10, but what if there are 100000 items? Only account for this with confirmation. dont over engineer if it will never pass 400.
1. Compounder - this is the most important step. How can we improve our agents

We fit somewhere between matt pocock. https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents or check his entire repo. and Superpowers. we want processes you dont need to fully remember, and ideally will aid bad developers to write good, testable, secure code, but also allow us to confirm or bypass approaches. For example, do we really need the security reviewer for only HTML/CSS changes? do we need TDD for throw away code that's 20 lines long? Allow the user to define the level of involvement, or develop judgment calls and confirm them before spinning off multiple workflows. 

We should be strongly pushing users if we believe its the best approach. new projects, 100% TDD, security review with JS/PHP 100%. Allow engineers to bypass, but steer less qualified folks in the direction we want

What requirements should we have for the user? Do they need node/docker/etc. Can we set up containers/etc to prevent bloating their computer and temporary installs, etc. 

What boundaries are we going to set? Always ask for using github CLI PR's and pushes (not commits)? never allow git commands to be run by claude, only CLI?


## Some key repos to look at

### Coding standards
1. Enforce coding standards for PHP/CSS https://github.com/demanddrive/coding-standards
1. For wordress specific testing, look at https://github.com/stormrockwell/mcp-server. DO NOT REFERENCE THIS, part of the research. The goal is to make these lean, but wanted to show some practices for WP testing.
1. decide and confirm what testing we need. unit, integration, e2e
1. readability, and easy of debuging trumps all. No code is the best code, and simple code everyone can understand is king.
1. github. review the current branch strategy and previous commits. follow that strategy. If none in place, follow what we'll define here
1. versioning - is this a theme or plugin that will be updated across multiple projects, care about versioning properly. Is it not?

### Commenting/documentation standards
1. Will need help here, find AI likes to overdocument code that is self explanitory, add in comments that are about the fix we made, and NOT about the actual code. Will the comment be helpful a year from now? if no, cut it.
1. PRs are too long. We often create internal PRs that require code review. we need to say the changes we made, and why we like our approach, we dont need to say why we changed our approach or anything irrelivant for the reviewer who didnt make the PR
1. conventional commits


### Security
1. what can run through AI reviewers, and what after NEEDS to be reviewed by a human as well. Determine what/if any needs to be reviewed by an engineer. if it needs an engineer review, try to take all of the logic for that component and make it's own segment/PR to be reviewed by a human

### Superpowers
I've used this one a lot, but there are some key differences I want to make

#### Pros
1. Separates models to preserve token usage
1. sub agent driven development
1. takes notes, but could be overkill with the separation of spec and implementation

#### Cons
1. struggles to work on tasks syncronously, especially for wordpress development. this might be due to the the same test suite being used, maybe docker containers could help this
1. absolutely enforces its standards on projects that dont use it. for example its so forced in TDD it will try to add TDD for projects without tests with no confirmation. Potentially practices should be made up front, maybe an initialize task that runs in a repo if its existing to discover whats in place already
1. doesnt have review/security layer
1. doesnt have compounding and benchmarking. it would be nice when compounding to benchmark outside of the content. maybe need multiple claude code chats, i know some people make harnesses to do things like this?

Open code review: https://github.com/alibaba/open-code-review.git
