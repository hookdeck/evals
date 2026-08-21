---
stage: resolve
suite: benchmark
product:
  - outpost
topic:
  - retries
requires:
  - outpost
motivation: The support case Outpost generates most reliably. A destination that keeps failing is auto-disabled to protect the system, and once the customer repairs their endpoint nothing starts again on its own — the held events are not retried until the destination is re-enabled. Outpost does emit `alert.destination.disabled` as an operator event, but only where a sink has been configured for it (Hookdeck Monitoring settings on managed, `OPERATION_EVENTS_TOPICS` plus a sink when self-hosted); on a deployment where nobody has, the first signal is the customer.
---

Acme emailed to say they stopped receiving order events some time yesterday.
Their engineer says their endpoint had a bad deploy but it's been fine since
this morning, and they've checked — nothing is arriving.

Work out why and get their events flowing again, including the ones they
missed.
