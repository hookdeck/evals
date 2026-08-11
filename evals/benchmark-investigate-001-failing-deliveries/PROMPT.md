---
stage: investigate
suite: benchmark
product:
  - event-gateway
topic:
  - retries
motivation: The most common shape of support request. Something has stopped working, the person reporting it cannot see which part, and the answer is in delivery history they have not looked at.
---

Our order events aren't all getting through. The fulfilment side seems fine but
something's definitely broken, and I've had it flagged twice this week.

Can you work out what's actually going wrong?
