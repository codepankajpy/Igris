# Recipes

A recipe is a per-site click path for dapps whose connect flow the generic
heuristic (docs/METHODOLOGY.md → "Connect heuristics") cannot drive — custom
modals, multi-step onboarding, cookie walls.

Usage: `igris scan <url> --recipe recipes/example.json`

## Schema (v1)

```jsonc
{
  "version": 1,
  "steps": [
    {
      "click": "<Playwright selector>", // CSS, text=…, role=… all work
      "waitMs": 500, // optional pause after the click (default 500)
    },
  ],
}
```

Steps run in order after phase A settles; each failed click is logged into
the report's notes (the scan continues, and ends as `wallet-connect-failed`
if the wallet never connects). Type definition:
[packages/scanner/src/connect.ts](../packages/scanner/src/connect.ts).

See [example-cookie-wall.json](./example-cookie-wall.json): accept a cookie
banner, open the connect modal, pick the injected wallet.
