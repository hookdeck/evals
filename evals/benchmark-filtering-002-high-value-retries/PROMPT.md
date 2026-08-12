---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - filtering
motivation: Filtering plus retries is the most requested combination in support, and a filter that quietly excludes valid orders looks identical to one that works.
---

Only orders above £500 should go to the manual review queue. Everything smaller
is handled automatically and shouldn't reach it.

Also, review's endpoint goes down occasionally and we've lost orders that way.
If a delivery fails, keep trying for a while rather than giving up.
