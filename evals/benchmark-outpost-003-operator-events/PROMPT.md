---
stage: build
suite: benchmark
product:
  - outpost
topic:
  - alerting
requires:
  - outpost
motivation: Follows the incident in benchmark-outpost-002. A destination was auto-disabled, the customer's events were held, and nobody found out until the customer emailed. Outpost emits `alert.destination.disabled` for exactly this, but it is delivered only to a configured operator events destination, and this project has none. The routes that configure it are absent from the published OpenAPI spec and from the API reference, so this measures whether an agent can set up alerting it cannot read about.
---

Last week one of our customers' destinations was switched off after a bad
deploy on their side, and their events piled up until they emailed us. We
found it by hand.

We don't want to find out that way again. Set us up so that when Outpost
disables a customer's destination, the alert reaches this endpoint:

    https://mock.hookdeck.com/operator-alerts

Consecutive delivery failures building up towards that threshold would be
useful too — we'd rather know before a destination is switched off than after.
