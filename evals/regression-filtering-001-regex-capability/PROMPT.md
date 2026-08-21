---
stage: build
suite: regression
gated_by: discovery
product:
  - event-gateway
topic:
  - filtering
motivation: Support ticket, June 2026. An assistant described regex payload filtering and a "Channel" field, neither of which exist, and the integration was built against both before the mistake surfaced.
---

Our order references look like `ORD-2026-AC-4821`. We migrated formats at the
start of the year and the old ones are still coming through, which my service
chokes on.

Can I use a regex on the reference to only let this year's format through? What
is the closest I can get?
