---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - signature-verification
  - capabilities
motivation: Support corpus gap #5 - assistants misstate which verification schemes a source supports and get HMAC encoding or the signature header wrong, so verification silently fails.
---

I've got a provider that signs its webhooks with an HMAC but it isn't one of
the ones you list. What can I actually configure on the source, and what do I
need from them to set it up?
