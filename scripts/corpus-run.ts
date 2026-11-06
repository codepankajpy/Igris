/**
 * Corpus harness: scan every corpus target N times through the real scanner
 * (egress public-only) and publish MEASURED results:
 *
 *  - pipeline outcome per run: capture → detection → evidence → report →
 *    verification (schema + integrity of every artifact);
 *  - failure taxonomy: site-unavailable / bot-blocked / browser-incompatible /
 *    scanner-error / detector-error / wallet-connect failures by step;
 *  - per-kit connection funnel. Denominator = ELIGIBLE targets: the target's
 *    kit (observed in discovery) and its page loaded in the run. Unavailable,
 *    bot-blocked and incompatible targets are reported separately and are
 *    never silently dropped;
 *  - finding-set determinism across runs of the same target.
 *
 * Usage:
 *   pnpm exec tsx scripts/corpus-run.ts --label <name> [--runs 2] [--dwell 4000]
 *        [--only <kit|id,...>] [--targets corpus/targets.json]
 * Writes corpus/results/<label>.json (+ .md); full artifacts go to
 * corpus/runs/<label>/ (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  contentHash,
  validateEvidenceBundle,
  validateReportV2,
  verifyReportIntegrity,
  type ScanResult,
} from '@igris/core';
import { writeScanArtifacts } from '@igris/cli';
import { scan } from '@igris/scanner';

interface Target {
  id: string;
  url: string;
  name: string;
  category: string;
  kit: string; // rainbowkit | connectkit | appkit | privy | dynamic | custom | unknown
  kitEvidence: { confidence: string; signals: string[]; observedAt: string };
  network: string;
  complexity: string;
}

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    runs: { type: 'string', default: '2' },
    dwell: { type: 'string', default: '4000' },
    only: { type: 'string' },
    targets: { type: 'string', default: 'corpus/targets.json' },
  },
});
if (!values.label || !/^[a-z0-9-]+$/.test(values.label)) {
  console.error('--label <lowercase-name> is required');
  process.exit(3);
}
const RUNS = Number(values.runs);
const DWELL = Number(values.dwell);
const all = (JSON.parse(readFileSync(values.targets!, 'utf8')) as { targets: Target[] }).targets;
const only = values.only?.split(',');
const targets = only ? all.filter((t) => only.includes(t.kit) || only.includes(t.id)) : all;

/** Funnel stage reached, from the connection failure category. */
const STAGE_BY_FAILURE: Record<string, number> = {
  'no-connect-control': 0,
  'unexpected-navigation': 1,
  'modal-not-opened': 1,
  'recipe-error': 1,
  'wallet-option-missing': 2,
  'request-not-issued': 3,
};
const STAGES = [
  'connect control found',
  'connect UI opened',
  'wallet option selected',
  'eth_requestAccounts issued',
  'connected',
];

interface RunRecord {
  run: number;
  ms: number;
  outcome: 'scanned' | 'page-failure' | 'detector-error';
  status?: string;
  failure?: { category: string; detail: string };
  connection?: {
    kitObserved: string;
    kitConfidence: string;
    recipe: string | null;
    outcome: string;
    failureCategory: string | null;
    failureStep: string | null;
    requestAccountsCalls: number;
  };
  verification?: { schema: boolean; integrity: boolean; problems: string[] };
  score?: number | null;
  coverage?: string;
  findingSet?: { sha256: string; count: number };
  fingerprints?: string[];
  evidenceSha256?: string;
  counts?: {
    contacts: number;
    ipExposureScored: number;
    ipExposureUnscored: number;
    leaksScored: number;
    security: number;
  };
  error?: string;
}

const outDir = join('corpus/runs', values.label);
const records: Array<{ target: Target; runs: RunRecord[] }> = [];

for (const t of targets) {
  const runs: RunRecord[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    let result: ScanResult;
    try {
      result = await scan({ url: t.url, dwellMs: DWELL, egress: { mode: 'public-only' } });
    } catch (err) {
      // scan() throws only when the engine refuses its own output (detector
      // contract, redaction, schema): a detector error, not a site problem.
      runs.push({
        run: i,
        ms: Date.now() - t0,
        outcome: 'detector-error',
        error: String(err).slice(0, 300),
      });
      continue;
    }
    const { report, bundle } = result;
    writeScanArtifacts(join(outDir, t.id, `run-${i}`), result);
    let schema = true;
    try {
      validateReportV2(JSON.parse(JSON.stringify(report)));
      validateEvidenceBundle(JSON.parse(JSON.stringify(bundle)));
    } catch {
      schema = false;
    }
    const integrity = verifyReportIntegrity(report, bundle);
    const all2 = [...report.privacy.findings, ...report.security.observations];
    const c = report.scan.connection;
    runs.push({
      run: i,
      ms: Date.now() - t0,
      outcome: report.scan.failure ? 'page-failure' : 'scanned',
      status: report.scan.status,
      ...(report.scan.failure ? { failure: report.scan.failure } : {}),
      ...(c
        ? {
            connection: {
              kitObserved: c.kit.id,
              kitConfidence: c.kit.confidence,
              recipe: c.recipe,
              outcome: c.outcome,
              failureCategory: c.failure?.category ?? null,
              failureStep: c.failure?.step ?? null,
              requestAccountsCalls: c.requestAccountsCalls,
            },
          }
        : {}),
      verification: { schema, integrity: integrity.ok, problems: integrity.problems.slice(0, 3) },
      score: report.privacy.score,
      coverage: report.privacy.coverage,
      findingSet: report.findingSet,
      fingerprints: all2.map((f) => `${f.detector}|${f.id}|${f.title}`).sort(),
      evidenceSha256: report.evidence.sha256,
      counts: {
        contacts: report.contacts.length,
        ipExposureScored: report.privacy.findings.filter(
          (f) => f.detector === 'ip-exposure' && f.countsTowardPrivacyScore,
        ).length,
        ipExposureUnscored: report.privacy.findings.filter(
          (f) => f.detector === 'ip-exposure' && !f.countsTowardPrivacyScore,
        ).length,
        leaksScored: report.privacy.findings.filter(
          (f) => f.detector === 'canary-leak' && f.countsTowardPrivacyScore,
        ).length,
        security: report.security.observations.length,
      },
    });
    const r = runs.at(-1)!;
    console.log(
      `${t.id.padEnd(22)} run ${i}: ${r.status ?? r.outcome}${r.failure ? ` (${r.failure.category})` : ''}` +
        `${r.connection ? ` connect=${r.connection.outcome}${r.connection.failureCategory ? `/${r.connection.failureCategory}` : ''} kit=${r.connection.kitObserved}/${r.connection.kitConfidence}` : ''}` +
        ` ${Math.round(r.ms / 1000)}s`,
    );
  }
  records.push({ target: t, runs });
}

// ---------------- aggregation (first run decides eligibility) ----------------
const KITS = ['rainbowkit', 'connectkit', 'appkit', 'privy', 'dynamic', 'unidentified'];
const funnel: Record<string, unknown> = {};
for (const kit of KITS) {
  const ts = records.filter((r) => r.target.kit === kit);
  if (!ts.length) continue;
  const tally = (cat: string) =>
    ts.filter((r) => r.runs[0]?.failure?.category === cat).map((r) => r.target.id);
  const detectorErrors = ts
    .filter((r) => r.runs[0]?.outcome === 'detector-error')
    .map((r) => r.target.id);
  const eligible = ts.filter((r) => r.runs[0]?.outcome === 'scanned');
  const reached = STAGES.map(() => 0);
  const failures: Record<string, string[]> = {};
  for (const r of eligible) {
    const conn = r.runs[0]!.connection;
    const stage =
      conn?.outcome === 'connected'
        ? STAGES.length
        : (STAGE_BY_FAILURE[conn?.failureCategory ?? 'no-connect-control'] ?? 0);
    for (let s = 0; s < stage; s++) reached[s]! += 1;
    if (conn?.outcome !== 'connected')
      (failures[conn?.failureCategory ?? 'unknown'] ??= []).push(r.target.id);
  }
  const connected = reached[STAGES.length - 1]!;
  funnel[kit] = {
    targets: ts.length,
    excluded: {
      'site-unavailable': tally('site-unavailable'),
      'bot-blocked': tally('bot-blocked'),
      'browser-incompatible': tally('browser-incompatible'),
      'scanner-error': tally('scanner-error'),
      'detector-error': detectorErrors,
    },
    eligible: eligible.length,
    stages: Object.fromEntries(STAGES.map((s, i) => [s, reached[i]])),
    connected,
    connectionRate: eligible.length ? Number((connected / eligible.length).toFixed(3)) : null,
    failures,
  };
}

const determinism = records
  .filter((r) => r.runs.length >= 2 && r.runs.every((x) => x.outcome === 'scanned'))
  .map((r) => {
    const [a, b] = r.runs;
    const sameStatus = a!.status === b!.status;
    const equal = a!.findingSet!.sha256 === b!.findingSet!.sha256;
    const onlyA = a!.fingerprints!.filter((f) => !b!.fingerprints!.includes(f));
    const onlyB = b!.fingerprints!.filter((f) => !a!.fingerprints!.includes(f));
    return {
      id: r.target.id,
      sameStatus,
      findingSetEqual: equal,
      onlyInRun1: onlyA,
      onlyInRun2: onlyB,
      evidenceEqual: a!.evidenceSha256 === b!.evidenceSha256,
    };
  });
const verification = records.flatMap((r) =>
  r.runs.filter((x) => x.verification).map((x) => ({ id: r.target.id, ...x.verification! })),
);

const summary = {
  version: 1,
  label: values.label,
  generatedAt: new Date().toISOString(),
  config: { runs: RUNS, dwellMs: DWELL, egress: 'public-only', targets: targets.length },
  funnel,
  determinism: {
    comparable: determinism.length,
    findingSetEqual: determinism.filter((d) => d.findingSetEqual).length,
    statusEqual: determinism.filter((d) => d.sameStatus).length,
    evidenceEqual: determinism.filter((d) => d.evidenceEqual).length,
    differences: determinism.filter((d) => !d.findingSetEqual),
  },
  verification: {
    artifacts: verification.length,
    schemaValid: verification.filter((v) => v.schema).length,
    integrityOk: verification.filter((v) => v.integrity).length,
    failures: verification.filter((v) => !v.schema || !v.integrity),
  },
  targets: records.map((r) => ({
    id: r.target.id,
    url: r.target.url,
    kit: r.target.kit,
    runs: r.runs.map(({ fingerprints: _f, ...x }) => x),
  })),
};
mkdirSync('corpus/results', { recursive: true });
writeFileSync(
  join('corpus/results', `${values.label}.json`),
  JSON.stringify(summary, null, 2) + '\n',
);
writeFileSync(join('corpus/results', `${values.label}.md`), renderMarkdown(summary));
console.log(
  `\nwrote corpus/results/${values.label}.{json,md} (resultsHash ${contentHash(summary.funnel).slice(0, 12)})`,
);
process.exit(0);

function renderMarkdown(s: typeof summary): string {
  const lines = [
    `# Corpus results: ${s.label}`,
    '',
    `Generated ${s.generatedAt} by scripts/corpus-run.ts · ${s.config.targets} targets × ${s.config.runs} runs · dwell ${s.config.dwellMs} ms · egress ${s.config.egress}.`,
    'Denominator = eligible targets (page loaded in run 1). Excluded targets are listed, never dropped.',
    '',
    '| kit | targets | unavailable | bot-blocked | incompatible | scanner/detector error | eligible | ' +
      STAGES.join(' | ') +
      ' | rate |',
    '| --- | ' +
      Array(7 + STAGES.length)
        .fill('---')
        .join(' | ') +
      ' |',
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped summary rows
  for (const [kit, f] of Object.entries(s.funnel) as Array<[string, any]>) {
    const ex = f.excluded;
    lines.push(
      `| ${kit} | ${f.targets} | ${ex['site-unavailable'].length} | ${ex['bot-blocked'].length} | ${ex['browser-incompatible'].length} | ${ex['scanner-error'].length + ex['detector-error'].length} | ${f.eligible} | ` +
        STAGES.map((st) => f.stages[st]).join(' | ') +
        ` | ${f.connectionRate === null ? 'n/a' : `${Math.round(f.connectionRate * 100)}%`} |`,
    );
  }
  lines.push(
    '',
    `Determinism: ${s.determinism.findingSetEqual}/${s.determinism.comparable} targets had an identical finding set across runs (status equal ${s.determinism.statusEqual}, evidence hash equal ${s.determinism.evidenceEqual}).`,
    `Verification: ${s.verification.schemaValid}/${s.verification.artifacts} schema-valid, ${s.verification.integrityOk}/${s.verification.artifacts} integrity-ok.`,
    '',
  );
  return lines.join('\n') + '\n';
}
