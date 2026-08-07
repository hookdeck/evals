---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - rate-limits
  - capabilities
motivation: Support corpus gaps #2 and #3 - repeated tickets where an assistant stated a wrong delivery timeout or payload ceiling, and the customer designed around the wrong number.
---

Before I build this out I need to know what I'm working with. How big can the
payloads be, and how long does my endpoint have to respond? One of the things
I'm processing takes about five minutes.
