---
stage: build
suite: benchmark
gated_by: discovery
product:
  - event-gateway
topic:
  - rate-limits
motivation: Every model provider publishes a requests-per-minute ceiling, and exceeding it turns a working integration into a stream of 429s.
---

The API we forward enrichment jobs to allows sixty requests a minute and starts
returning 429s past that. We're well over it at peak.

Make our deliveries stay inside their limit.
