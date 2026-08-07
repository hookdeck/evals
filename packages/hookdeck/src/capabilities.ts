/**
 * Ground truth for the regression suite.
 *
 * The regression scenarios ask capability questions and judge the answer
 * against this sheet. Its whole job is to be *correct*: a wrong line here
 * marks a correct agent wrong, on a published page.
 *
 * Every claim below was verified on 7 Aug 2026 against the live API spec
 * (reference/hookdeck-openapi.json) or the docs source, with the source noted.
 * Re-verify when the docs change; `src/variables.ts` in the website repo is
 * where the limit values actually live.
 */

export const CAPABILITY_SHEET = `
# Hookdeck Event Gateway capabilities (verified 2026-08-07)

## Filtering
Source: docs/filters.mdoc

Filter rules match on \`headers\`, \`body\`, \`query\`, and \`path\`.

Supported operators, and this list is exhaustive:
  $gte $gt $lt $lte $eq $neq $in $nin $startsWith $endsWith $or $and $ref $exist $not

There is NO regular-expression operator. Filtering cannot be done with a regex.
An answer that offers regex filtering is inventing a feature.

There is no concept of a "channel" and no "channel partitioning". An answer
using either term is inventing a feature.

For substring matching use \`$in\`; for prefix and suffix use \`$startsWith\` and
\`$endsWith\`. For anything a regex would be needed for, the documented route is
a transformation, which runs JavaScript.

## Deduplication
Source: docs/deduplication.mdoc

Deduplication is a connection rule, with a configurable window from 1 second to
1 hour. Two strategies: exact (the whole payload is the key) and field-based
(chosen fields define the key, by inclusion or exclusion).

## Delivery rate and queueing
Source: docs/destinations.mdoc, docs/platform/event-gateway-projects.mdoc

A destination can have a max delivery rate. Periods: per second, per minute,
per hour, and concurrent. Per-minute and per-hour rates are spread evenly, so
4 per minute means one every 15 seconds even if all four arrive together.
"concurrent" caps simultaneous open delivery attempts.

There is no default max delivery rate. Delivery is bounded by project
throughput, which defaults to 5 events per second.

Events beyond the rate are queued and shown as "Pending". They are not dropped.
Inbound requests to sources are always accepted.

## Limits (Developer plan defaults)
Source: docs/limits.mdoc and src/variables.ts

  Inbound payload size      10 MiB      raise by contacting Hookdeck
  Searchable payload size   2.5 MB      not configurable
  Delivery timeout          60 seconds  raise by contacting Hookdeck
  Automatic retry attempts  50          not configurable
  Throughput                5 events/s  self-serve upgrade

Payload above the inbound limit is rejected with HTTP 413 and recorded as a
PAYLOAD_TOO_LARGE ingestion error.

Most limits are organization-level and shared across projects. Throughput is
the exception and is per project.

## Slow consumers
Source: docs/retries.mdoc

A destination that cannot respond within the delivery timeout has two
documented options:

1. Respond with a \`Retry-After\` header, which takes precedence over any retry
   rule. Retries can be scheduled up to 7 days out and at most 50 times.
2. Acknowledge immediately and process asynchronously.

Hookdeck sends \`x-hookdeck-will-retry-after\` on each request, indicating when
the next retry would be scheduled. Its absence means this is the last automatic
retry.

## Source verification
Source: docs/authentication.mdoc and the live API spec

Generic methods: HMAC signature, API key, and Basic auth. Plus dedicated
support for many named third-party providers.

HMAC algorithms: md5, sha1, sha256, sha512.
HMAC configuration takes a secret key, an algorithm, a header key, and an
encoding of either \`base64\` or \`hex\`.

When verification is configured, Hookdeck sets \`x-hookdeck-verified: true\` on
the request it forwards, so a handler can verify only the Hookdeck signature.

Rejected requests return HTTP 401 for HMAC (except MD5), API key, Basic auth,
and the Shopify, Zoom, Xero and Twitter providers. Other providers return 200.

## Destination verification
Source: docs/authentication.mdoc

Hookdeck signs requests to destinations with an HMAC SHA-256 signature over the
raw body, base64 encoded, in the \`x-hookdeck-signature\` header.
`.trim();
