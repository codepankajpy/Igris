# Igris browser extension — STUB

Status: **stub, not loaded in a real browser yet (UNVERIFIED).**

## What it demonstrates

The privacy-safe design for a registry extension: it must **not** query Arkiv
(or anything) per visited site — that would stream the user's browsing
history to an RPC endpoint. Instead it bundles a registry snapshot
(`igris snapshot` → `snapshot.json`) and matches the active tab's hostname
**locally**. The popup makes zero network requests.

## What exists

- `manifest.json` (MV3, `activeTab`+`tabs` only), `popup.html`, `popup.js`.

## How to try it

1. `pnpm igris snapshot --registry local --local-file igris-registry.json --out extension/snapshot.json`
   (or against Arkiv once records exist).
2. Chrome → `chrome://extensions` → Developer mode → "Load unpacked" → this
   directory.
3. Visit a scanned site, click the icon.

## Exactly what is missing

- Not tested in a real browser (no automated MV3 test in the suite).
- No snapshot auto-refresh (a privacy-honest design: refresh only on explicit
  user action in the popup, from the user-configured endpoint).
- No badge/onscreen indicator; popup only.
- No store packaging/signing.
