# Browser observation spike (P0-2b)

Refs #2155 (CDP live browser session observation).

Minimal chain, no new runtime dependency:

```text
browser-use / Playwright action
  -> examples/browser-observation-client.js (external-event envelope)
  -> huqan-gate generic (review/block on payment, submit, exfil targets)
  -> observed result -> receipt
```

## What's covered

- `browser.navigated`, `browser.clicked`, `custom/browser.typed`,
  `custom/browser.submitted` map to `huqan.external-event.v1`.
- Targets are page-level (`page:<host><path>#<element>`); DOM text, inputs,
  cookies and screenshots never enter the envelope.
- Payment/submit targets default to `review` hint so the gate never silently
  allows them.

## What's explicitly not covered

- No CDP connection, no Playwright dependency, no screenshot capture.
- Full session timeline stays in #2155; this spike is the producer contract only.
