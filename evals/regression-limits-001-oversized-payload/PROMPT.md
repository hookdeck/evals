---
stage: investigate
suite: regression
product:
  - event-gateway
topic:
  - capabilities
motivation: Support corpus gaps #2 and #3 - assistants state a wrong payload ceiling, and customers design around the wrong number or chase the wrong cause when ingestion silently rejects requests.
---

Some of our order events just aren't showing up. Most come through fine but a
few never arrive at all, and I can't see them anywhere. Can you work out what's
going on?
