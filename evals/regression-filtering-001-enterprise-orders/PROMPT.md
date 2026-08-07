---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - filtering
motivation: Crisp incident, June 2026 - a customer's assistant invented regex payload filtering and a "Channel" field, and the customer built against both before discovering neither exists.
---

We're getting far more order webhooks than we can process and I only want the
big enterprise ones reaching my service. Send through orders over $500 from
customers on one of our enterprise domains, `@acme.com` or `@globex.com`.
Everything else should be filtered out.
