---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - rate-limits
motivation: The shape of nearly every AI workload. A consumer that is slow rather than broken breaks delivery assumptions that were written for fast endpoints.
---

Our inference worker takes about ninety seconds per job and it can only handle
two at a time. When traffic spikes it falls over and we lose jobs.

Set the delivery up so that doesn't happen.
