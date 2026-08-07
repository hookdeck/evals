---
stage: build
suite: regression
product:
  - event-gateway
topic:
  - signature-verification
motivation: Support corpus gap #5 - assistants misstate the HMAC options a source accepts, and a wrong encoding or header name fails silently because the symptom looks like the provider misbehaving.
---

I'm receiving webhooks from an internal service that isn't one of the providers
you support out of the box. It signs each request like this:

```
POST /
X-Acme-Signature: 5xO8jH2Qm1kV9pAzR3sT7uYwXcNbMlKjHgFdSaPoIuY=
Content-Type: application/json

{"order_id":"ord_4821","total":1250}
```

The signature is the request body signed with SHA-256 using our shared secret
`acme_whsec_5f2b91`. Set up a Hookdeck source that verifies these.
