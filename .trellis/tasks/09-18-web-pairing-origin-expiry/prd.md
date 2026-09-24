# Web pairing expiry and listener-origin drift

## Problem

- Changing an embedded Web listener port can leave an automatically derived browser Origin on the old port, causing browser mutations such as pairing to be rejected.
- An expired desktop pairing code remains visible even though the server correctly rejects it.
- Browser Origin failures fall back to a generic request error.

## Acceptance

- An Origin that still equals the previous listener URL follows bind/port changes; custom domain, reverse-proxy and unspecified-bind Origins are preserved.
- Expired pairing codes are removed by both the in-process and helper-daemon status paths, and the settings page refreshes at expiry.
- Browser pairing reports an actionable bilingual Origin mismatch instead of a generic failure.
- Existing authentication, token storage, pairing claim, mobile access and server/device protocols remain unchanged.
