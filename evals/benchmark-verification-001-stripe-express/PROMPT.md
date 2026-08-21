---
stage: build
suite: benchmark
gated_by: discovery
product:
  - event-gateway
topic:
  - signature-verification
motivation: The vendor golden path. Receiving a provider's webhooks is the first thing most developers do with Hookdeck, and doing it safely is the part that goes wrong quietly.
---

We're taking Stripe payments and I need our orders API to react when a checkout
completes. Right now nothing is wired up.

Set it up so Stripe events reach the `/orders` endpoint, and make sure the
endpoint only accepts requests that genuinely came through, not anything that
turns up at the URL. I'm still working on this locally, and I don't want to miss
events while I'm developing.
