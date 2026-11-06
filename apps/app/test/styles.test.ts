import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

/** Every declaration block whose selector list contains `selector` (exact, comma-split). */
function blocks(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out;
}
const RED = /--signal|239,\s*75,\s*75|#ef4b4b|#ffb3b3|#fff\b/i;

describe('red is reserved for "the address reached a tracking/unidentified recipient" (defect 3)', () => {
  const failures = [
    '.form-error::before',
    '.sev.critical i',
    '.sev.critical',
    '.stage.failed .stage-mark',
    '.log-status.failed',
    '.check.bad .check-mark',
    '.failure',
  ];
  for (const sel of failures)
    it(`${sel} is drawn without the signal red`, () => {
      const bs = blocks(sel);
      expect(bs.length, `${sel} has a rule`).toBeGreaterThan(0);
      for (const b of bs) expect(b).not.toMatch(RED);
    });

  it('failure marks stay distinguishable from success marks', () => {
    const ok = blocks('.check-mark').join('');
    const bad = blocks('.check.bad .check-mark').join('');
    expect(ok).toMatch(/background:\s*var\(--fg\)/); // filled
    expect(bad).toMatch(/background:\s*transparent/); // hollow ring
    expect(bad).toMatch(/inset 0 0 0 [\d.]+px var\(--fg\)/);
    const done = blocks('.stage.done .stage-mark').join('');
    const failed = blocks('.stage.failed .stage-mark').join('');
    expect(done).toMatch(/background:\s*var\(--fg\)/);
    expect(failed).toMatch(/background:\s*transparent/);
    expect(blocks('.log-status.failed::before').join('')).toMatch(/content:\s*'× '/);
    expect(blocks('.form-error::before').join('')).toMatch(/content:\s*'×'/);
    // Critical: a double ring, unlike high's plain glowing dot.
    expect(blocks('.sev.critical i').join('')).toMatch(/0 0 0 2px var\(--bg-1\)/);
  });

  it('the signal red is still used for the address-to-tracker cases', () => {
    expect(blocks('.recipient.signal').join('')).toMatch(/--signal/);
    expect(blocks('.state-address-to-trackers .state-mark').join('')).toMatch(/--signal/);
  });
});

describe('wallet-request risks and agreement statuses use the neutral emphasis, never the signal red', () => {
  const neutral = [
    '.wr-flag',
    '.wr-flag::before',
    '.wr-card.risk',
    '.wr-emph',
    '.tl-wr path',
    '.tl-wr.risk path',
    '.chip.st-agree',
    '.chip.st-differ',
    '.chip.st-partial',
    '.agreement-unverified',
    '.chip.node-chip',
  ];
  for (const sel of neutral)
    it(`${sel} is drawn without the signal red`, () => {
      const bs = blocks(sel);
      expect(bs.length, `${sel} has a rule`).toBeGreaterThan(0);
      for (const b of bs) expect(b).not.toMatch(RED);
    });
  it('a risky wallet request is still told apart: filled triangle, foreground edge', () => {
    expect(blocks('.tl-wr path').join('')).toMatch(/fill:\s*var\(--bg\)/);
    expect(blocks('.tl-wr.risk path').join('')).toMatch(/fill:\s*var\(--fg\)/);
    expect(blocks('.wr-card.risk').join('')).toMatch(/inset 2px 0 0 var\(--fg\)/);
  });
});

/** The e2e quiet-window comment states the app does not poll (defect 6): keep that true. */
describe('the app does not poll', () => {
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
  // Two intervals only: the live scan clock (no request) and the header's
  // same-origin /api/registry status check (the API may start after the page).
  it('the only intervals are the live scan clock and the same-origin registry status check', () => {
    const hits = files(SRC).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/setInterval\(([^\n]*)/g)].map(
        (m) => `${relative(SRC, f)}: ${m[1]}`,
      ),
    );
    expect(hits.sort()).toEqual([
      'main.tsx: check, 20_000);',
      'pages/Scan.tsx: () => setNow(Date.now()), 250);',
    ]);
  });
});
