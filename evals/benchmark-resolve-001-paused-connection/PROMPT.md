---
stage: resolve
suite: benchmark
product:
  - event-gateway
topic:
  - retries
motivation: A recurring support pattern. Nothing is broken and nothing errors, so the person reporting it has no thread to pull on and the answer is in a field nobody thinks to check.
---

Checkout events stopped reaching our orders API. Nothing's changed on our side
that I know of, and the endpoint is up.

Get them flowing again.
