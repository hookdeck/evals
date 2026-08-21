---
stage: investigate
suite: benchmark
gated_by: mixed
product:
  - event-gateway
topic:
  - filtering
motivation: A partial outage is the hardest support shape to diagnose from the outside. Everything that arrives works, so every dashboard looks healthy, and the only evidence is what is not there.
---

Our warehouse team says they're missing orders. Not all of them, and I can't
find a single failure anywhere I've looked. Every delivery I can see went
through fine.

Where are the missing ones going?
