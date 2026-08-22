---
stage: build
suite: benchmark
gated_by: discovery
product:
  - outpost
topic:
  - sdk
requires:
  - outpost
extra_skills:
  - outpost
motivation: The reason people adopt Outpost. Sending webhooks to your own customers is a product feature, and every team that builds it by hand rebuilds retries, verification and a subscription model badly.
---

We want our customers to be able to subscribe to events from our platform, so
they can react when an order is placed rather than polling us for it.

Set that up for our first customer, `acme`, so they receive order events at
their endpoint. Then show me it works by sending one through.
