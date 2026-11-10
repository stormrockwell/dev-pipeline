---
type: llm
---

Pass when the final message names the root cause, that checkoutTotal reads cart.coupon.percent while a cart without a coupon has coupon null, so checkout throws and the server answers 500, and cites evidence from a local reproduction, such as a failing test run and its error. Fail when either part is missing.
