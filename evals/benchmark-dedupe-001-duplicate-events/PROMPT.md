---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - deduplication
motivation: Providers retry on timeouts and send the same event twice. When the consumer writes to a ledger, a duplicate is a real financial error rather than noise.
---

Our payment provider sometimes sends us the same event twice within a few
seconds, and our ledger ends up double-counting it. We can't easily change the
ledger service.

Stop the duplicates reaching it.
