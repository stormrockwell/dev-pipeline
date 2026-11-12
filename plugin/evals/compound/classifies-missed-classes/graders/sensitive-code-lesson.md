---
type: regex
target: last_message
pattern: '(q-9ecbaa070225|zone:input)[\s\S]{0,900}([Mm]issed sensitive code|sensitive\.yml|[Ww]rong tier|classifier)'
---

Reviewers caught a missing nonce on three settings PRs whose plans named no zone and stayed below T3, so the lesson is missed sensitive code or a wrong tier.
