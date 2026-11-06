/**
 * Build corpus/targets.json from one or more discovery files.
 *
 *  - Only candidates whose page LOADED become scan targets. Unavailable,
 *    bot-blocked and incompatible candidates stay in the discovery report.
 *  - `kit` is the CONFIRMED kit (its modal observed live) or "unidentified".
 *    Unconfirmed static/network hints are kept in `kitHint`, never in `kit`.
 *  - `category` comes from the section comments of the candidates file.
 *  - `network` is recorded as "not-measured": discovery does not observe
 *    chain requirements, and the corpus does not guess them.
 *
 * Usage: pnpm exec tsx scripts/corpus-targets.ts <candidates.txt> <out.json> <discovery.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [candidatesFile, outFile, ...discoveryFiles] = process.argv.slice(2);
if (!candidatesFile || !outFile || discoveryFiles.length === 0) {
  console.error('usage: corpus-targets.ts <candidates.txt> <out.json> <discovery.json>...');
  process.exit(3);
}

// Category from the most recent "# Section" comment above each URL.
const category = new Map<string, string>();
let section = 'uncategorised';
for (const line of readFileSync(candidatesFile, 'utf8').split('\n')) {
  const t = line.trim();
  if (
    t.startsWith('# ') &&
    !t.includes('http') &&
    t.length < 60 &&
    !/^# (Candidate|Selection|Kits|which|unavailability|reconnaissance)/i.test(t)
  )
    section = t.slice(2).toLowerCase();
  else if (/^https?:\/\//.test(t)) category.set(t, section);
}

interface Fp {
  id: string;
  confidence: string;
  signals: string[];
}
interface Rec {
  url: string;
  observedAt: string;
  load: { ok: boolean; category?: string };
  staticFingerprint?: Fp;
  open?: { outcome: string; clicked: string | null; fingerprint: Fp };
}

const byUrl = new Map<string, Rec>();
for (const f of discoveryFiles) {
  for (const r of (JSON.parse(readFileSync(f, 'utf8')) as { results: Rec[] }).results)
    byUrl.set(r.url, r); // later files win
}

const targets = [...byUrl.values()]
  .filter((r) => r.load.ok)
  .map((r) => {
    const fps = [r.open?.fingerprint, r.staticFingerprint].filter(Boolean) as Fp[];
    const confirmed = fps.find((f) => f.confidence === 'high');
    const hint = fps.find((f) => f.id !== 'none' && f.confidence !== 'high');
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    return {
      id: host.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
      url: r.url,
      name: host,
      category: category.get(r.url) ?? 'research-added',
      kit: confirmed ? confirmed.id : 'unidentified',
      kitEvidence: {
        confidence: confirmed ? 'high' : 'none',
        signals: confirmed?.signals ?? [],
        observedAt: r.observedAt,
        source: 'scripts/corpus-discover.ts (live)',
      },
      ...(hint
        ? {
            kitHint: {
              id: hint.id,
              confidence: hint.confidence,
              signals: hint.signals,
              note: 'unconfirmed: no kit modal observed',
            },
          }
        : {}),
      connectControl: r.open?.clicked ?? null,
      openOutcome: r.open?.outcome ?? null,
      network: 'not-measured',
      complexity:
        r.open?.outcome === 'modal-opened' ? 'single-click opens kit modal' : 'not-established',
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(
  outFile,
  JSON.stringify(
    {
      version: 1,
      generatedBy: 'scripts/corpus-targets.ts',
      fromDiscovery: discoveryFiles,
      targets,
    },
    null,
    2,
  ) + '\n',
);
const kits = new Map<string, number>();
for (const t of targets) kits.set(t.kit, (kits.get(t.kit) ?? 0) + 1);
console.log(
  `wrote ${outFile}: ${targets.length} targets — ${[...kits].map(([k, v]) => `${k}=${v}`).join(', ')}`,
);
