---
stage: resolve
suite: benchmark
product:
  - outpost
topic:
  - retries
requires:
  - outpost
motivation: The support case Outpost generates most reliably. A destination that keeps failing is switched off to protect the system, and once the customer fixes their endpoint nothing starts again on its own — the events are held, the dashboard looks healthy, and the only signal is a customer saying they stopped receiving anything.
---

Acme emailed to say they stopped receiving order events some time yesterday.
Their engineer says their endpoint had a bad deploy but it's been fine since
this morning, and they've checked — nothing is arriving.

Work out why and get their events flowing again, including the ones they
missed.
