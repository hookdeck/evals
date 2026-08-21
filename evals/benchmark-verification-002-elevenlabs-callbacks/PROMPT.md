---
stage: build
suite: benchmark
gated_by: discovery
product:
  - event-gateway
topic:
  - signature-verification
motivation: A provider outside the handful every model has memorised. The setup is the same shape as the popular ones and the details are not, so an answer from memory looks right and rejects real traffic.
---

We're using ElevenLabs for transcription and they call us back when a job
finishes. The callbacks need to reach the transcripts service in this directory,
and I don't want it accepting anything that didn't genuinely come from them via
our gateway.

Set that up.
