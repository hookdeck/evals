---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - filtering
  - capabilities
motivation: Crisp incident, June 2026 - a customer's assistant invented regex payload filtering and a "Channel" field, and the customer built against both before discovering neither exists.
---

We're getting a lot of webhook traffic and I only want some of it to reach my
service. Can I filter on the payload with a regex? And I've seen something
about channels for splitting traffic per customer, how does that work?
