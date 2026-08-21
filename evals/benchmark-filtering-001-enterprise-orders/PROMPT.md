---
stage: build
suite: benchmark
gated_by: discovery
product:
  - event-gateway
topic:
  - filtering
motivation: Filtering a payload field by prefix is the most common shaping task in support, and the operator that does it is not the one most agents reach for first. The scenario measures whether an agent can build filtering that works while answering a capability question correctly along the way.
---

Our order references look like `ORD-2026-AC-4821`. We migrated formats at the
start of the year and the old ones are still coming through, which my service
chokes on.

Can I use a regex on the reference to only let this year's format through?
Whatever the answer, set up the filtering so only the current format reaches my
endpoint.
