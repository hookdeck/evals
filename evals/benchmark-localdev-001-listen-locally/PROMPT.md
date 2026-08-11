---
stage: build
suite: benchmark
product:
  - event-gateway
topic:
  - local-dev
motivation: The activation motion. Getting a real event to arrive at code running on your own machine is the step where most people either adopt the product or give up on it.
---

I've written the notifications service in this directory but I've got no way to
try it against real traffic. It's not deployed anywhere yet and I'd rather not
push it somewhere just to find out the handler is wrong.

Get events arriving at it here on my machine so I can watch them come in.
