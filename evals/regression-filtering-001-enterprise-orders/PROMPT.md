---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - filtering
motivation: Support ticket, June 2026. An assistant described regex payload filtering and a "Channel" field, neither of which exist, and the integration was built against both before the mistake surfaced.
---

We're getting far more order webhooks than we can process and I only want the
big enterprise ones reaching my service. Send through orders over $500 from
customers on one of our enterprise domains, `@acme.com` or `@globex.com`.
Everything else should be filtered out.
