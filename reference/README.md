# API reference

`hookdeck-openapi.json` is fetched from the live API:

```bash
curl -s https://api.hookdeck.com/2025-07-01/openapi -o reference/hookdeck-openapi.json
```

Use this, not `hookdeck/hookdeck-api-schema`, which was last updated in December 2024
and is substantially wrong: destination create has a different shape, rate limiting has
moved into `config`, the `MOCK_API` destination type is missing, and Delivery Groups
does not appear at all.

Refresh it before writing scorers for a new scenario, and verify against a real call.
Both mismatches found while building the provisioner surfaced only at runtime.
