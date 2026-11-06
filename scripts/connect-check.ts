/**
 * Connect check (diagnostics): run the real scanner (egress public-only) on
 * each URL and print the connect-phase diagnostics (scan.connection).
 *
 * Usage: pnpm exec tsx scripts/connect-check.ts [--dwell 2000] <url> [url…]
 */
import { parseArgs } from 'node:util';
import { scan } from '@igris/scanner';

const { values, positionals } = parseArgs({
  options: { dwell: { type: 'string', default: '2000' } },
  allowPositionals: true,
});
if (positionals.length === 0) {
  console.error('usage: connect-check.ts [--dwell ms] <url> [url…]');
  process.exit(3);
}
for (const url of positionals) {
  const t0 = Date.now();
  try {
    const { report, bundle } = await scan({
      url,
      dwellMs: Number(values.dwell),
      egress: { mode: 'public-only' },
    });
    const c = report.scan.connection;
    console.log(
      JSON.stringify({
        url,
        status: report.scan.status,
        failure: report.scan.failure ?? null,
        score: report.privacy.score,
        kit: c?.kit.id,
        kitConfidence: c?.kit.confidence,
        recipe: c?.recipe,
        outcome: c?.outcome,
        connectFailure: c?.failure,
        steps: c?.steps.map((s) => `${s.step}:${s.result}:${s.detail}`),
        requestAccounts: c?.requestAccountsCalls,
        ledger: report.privacy.ledger.map(
          (l) => `-${l.points} ${l.rule}: ${l.label.slice(0, 140)}`,
        ),
        leaks: report.privacy.findings
          .filter((f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore)
          .map((f) => {
            const e = bundle.items[f.evidence[0]!.id];
            return e?.type === 'canary-match'
              ? `${f.severity} ${e.host} (${e.recipientClass}) ${e.location}/${e.encoding} ${e.url.slice(0, 120)}`
              : f.title;
          }),
        seconds: Math.round((Date.now() - t0) / 1000),
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ url, error: String(err).slice(0, 300) }));
  }
}
