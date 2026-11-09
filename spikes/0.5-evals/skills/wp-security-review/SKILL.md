---
name: wp-security-review
description: Review the most recent git commit's diff for WordPress security defects such as SQL injection, missing nonce or capability checks, and unescaped output. Use when asked to review, audit or security-check the latest commit or change in a WordPress plugin or theme.
---

# WordPress security review

1. Run `git show HEAD` to read the most recent commit's diff.
2. Check the changed lines for SQL built without `$wpdb->prepare()`, handlers that skip nonce verification or `current_user_can()`, and request data echoed without `esc_*` functions.
3. Write the result to `findings.md` in the working directory, one line per finding in this format:

   `- [SEVERITY] file:line - defect class - fix`

   SEVERITY is one of CRITICAL, HIGH, MEDIUM or LOW. If the diff has no defects, write only `No findings.`
