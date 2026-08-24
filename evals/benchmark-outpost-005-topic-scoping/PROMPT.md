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
motivation: Every Outpost customer subscribes to a different slice of the same event stream, and narrowing one customer's slice is the most common change a support engineer makes. The ticket names the topic to stop and one topic to keep, so scoping to the named keeper is the obvious fix — and it silently drops a third topic nobody mentioned, because it was working. Nothing errors; the customer notices days later.
---

Acme have been in touch. Their integration is choking on order cancellations —
they don't handle them and each one throws an error on their side. Their order
confirmations are working fine and they rely on those.

Stop the cancellations.
