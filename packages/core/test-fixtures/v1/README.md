# Frozen v1 reports (migration regression fixtures)

Never regenerate or hand-edit these: they pin what v1 actually produced.

| File                                                             | Source                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `leaky-1.0.0.json`, `fixed-1.0.0.json`, `viewer-scan-1.0.0.json` | `git show b915636:examples/<name>/report.json` (pre-P0)                                     |
| `leaky-1.1.0.json`, `fixed-1.1.0.json`, `viewer-scan-1.1.0.json` | `examples/` as committed at `14b7b91` (P0)                                                  |
| `uniswap-1.0.0.json`                                             | a real scan of app.uniswap.org made before P0 (was in the untracked `igris-out/`)           |
| `github-1.0.0.json`                                              | a real scan of github.com made during the 2026-11-06 assessment (headers wrongly "missing") |
| `dead-1.0.0.json`                                                | the assessment scan of `http://127.0.0.1:9` — `page-load-failed` that 1.0.0 scored **100**  |
