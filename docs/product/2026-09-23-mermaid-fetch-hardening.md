# Mermaid fetch hardening

Status: in progress (feature/mermaid-fetch-hardening, from main 8f73322). Target: 0.1.9.

## Why

The lane 4 security review (P2-1) found a model-authored sequence diagram can make the Console
request a same-origin URL while Mermaid lays the diagram out: `properties Alice: {"icon": "/api/..."}`
becomes an SVG `<image>` whose `xlink:href` Mermaid's `sanitizeUrl` allows, and the desktop shell
attaches the session header to requests for the local service. `details Alice: <id>` reads an
element of the app's own document by id and applies its JSON the same way.

The app's policy (`img-src 'self' data:`) keeps every such request on the local service, no
response is readable by the diagram, and no GET route the app mounts has a side effect, so the
exposure is a blind request. It shipped in 0.1.8 with model artifacts v1.

## What changes

To be written by the lane.

## Tests

To be written by the lane.

## Known gaps

To be written by the lane.
