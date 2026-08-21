---
stage: build
suite: benchmark
gated_by: mixed
product:
  - outpost
topic:
  - capabilities
requires:
  - outpost
motivation: Most Outpost traffic is webhooks, but delivering to a queue is a core capability and a different job — a type rather than a URL, credentials rather than a secret, and fields whose names differ per provider. This scores whether an agent can configure a non-HTTP destination from details it has to find, rather than reaching for the webhook shape it has seen most often.
---

Acme are moving off webhooks. Their endpoint keeps falling over under load and
they'd rather we drop order events straight onto a queue they already run.

They sent us the queue details last week — whoever picked up the ticket put
them in the repo.

Set that up, and stop sending their orders to the old endpoint.
