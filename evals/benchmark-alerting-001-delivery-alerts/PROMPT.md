---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - alerting
motivation: Nobody checks a dashboard until something has already gone wrong. An alert that was configured but never fires is worse than no alert, because it is trusted.
---

We found out our fulfilment endpoint had been rejecting orders for most of a day
because nobody was watching. I don't want to find out that way again.

Set it up so we get told when deliveries to that endpoint keep failing.
