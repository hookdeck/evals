---
stage: resolve
suite: benchmark
gated_by: mixed
product:
  - outpost
topic:
  - filtering
requires:
  - outpost
extra_skills:
  - outpost
motivation: Every Outpost customer subscribes to a different slice of the same event stream, and narrowing one customer's slice is the most common change a support engineer makes. The obvious fix is too narrow — it stops the events they complained about and the ones they still depend on — and it fails silently, because nothing errors and the customer only notices what stops arriving days later.
---

Acme have been in touch. Their integration is choking on order cancellations —
they don't handle them and each one throws an error on their side. They want us
to stop sending those.

They were clear that everything else they get today should carry on exactly as
it is, and Globex shouldn't be affected at all.
