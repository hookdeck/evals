---
stage: build
suite: benchmark
gated_by: discovery
product:
  - event-gateway
topic:
  - transformations
motivation: Reshaping a provider payload is the most common thing people ask a transformation to do, and a transformation that drops one field still delivers a 200.
---

Our payment provider changed their payload and our billing service can't read
it any more. The service expects `amount`, `currency` and `email` at the top
level of the body, and nothing else has to change.

Sort it out so the billing service starts working again. I'd rather know it's
right before it goes anywhere near production.
