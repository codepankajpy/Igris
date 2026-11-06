import { describe, expect, it } from 'vitest';
import type { CanaryMatchEvidence, EvidenceBundle, EvidenceItem } from './contracts/evidence.js';
import { evidenceId } from './contracts/evidence.js';
import type {
  AddressExposure,
  FindingV3,
  RecipientV3Class,
  Verdict,
} from './contracts/report-v3.js';
import { RECIPIENT_V3_CLASSES } from './contracts/report-v3.js';
import type { Phase, ThirdPartyContact } from './report.js';
import {
  VERDICT_RULES,
  addressReceived,
  computeRecipients,
  verdictFor,
  verdictsAtLeast,
} from './verdicts.js';

/** The verdict table of docs/design/REPORT-3.0.0.md, cell by cell. */
const TABLE: Array<[RecipientV3Class, Verdict, Verdict, string]> = [
  // class, with address, without address, rule slug
  ['unknown-third-party', 'unidentified', 'unidentified', 'unidentified'],
  ['analytics', 'tracking', 'tracking', 'analytics'],
  ['error-monitoring', 'tracking', 'avoidable', 'error-monitoring'],
  ['support-chat', 'tracking', 'avoidable', 'support-chat'],
  ['rpc-provider', 'avoidable', 'expected', 'rpc'],
  ['cdn', 'avoidable', 'expected', 'cdn'],
  ['ipfs-gateway', 'avoidable', 'expected', 'ipfs-gateway'],
  ['walletconnect-relay', 'expected', 'expected', 'walletconnect-relay'],
  ['wallet-sdk', 'expected', 'expected', 'wallet-sdk'],
  ['anon-rpc', 'expected', 'expected', 'anon-rpc'],
];

describe('verdict table (one test per cell)', () => {
  it('covers every recipient class exactly once', () => {
    expect(TABLE.map(([c]) => c).sort()).toEqual([...RECIPIENT_V3_CLASSES].sort());
  });
  for (const [cls, withAddress, without, slug] of TABLE) {
    for (const address of ['exact', 'hashed'] as const) {
      it(`${cls} + ${address} address → ${withAddress}`, () => {
        expect(verdictFor(cls, address)).toEqual({
          verdict: withAddress,
          rule: `verdict.${slug}-with-address@1`,
          reason: VERDICT_RULES[`verdict.${slug}-with-address@1`]!.reason,
        });
      });
    }
    for (const address of ['none', 'possible'] as const) {
      it(`${cls} + ${address} → ${without}`, () => {
        expect(verdictFor(cls, address)).toMatchObject({
          verdict: without,
          rule: `verdict.${slug}@1`,
        });
      });
    }
  }
  it('rpc-provider with address is the spec example rule', () => {
    expect(verdictFor('rpc-provider', 'exact').rule).toBe('verdict.rpc-with-address@1');
    expect(verdictFor('rpc-provider', 'exact').reason).toMatch(/Anon-RPC/);
  });
  it('the wallet-sdk reason states that the SDK keeps its own record', () => {
    expect(verdictFor('wallet-sdk', 'exact').reason).toMatch(/keeps its own record/);
  });
  it('20 rules, each with one plain sentence', () => {
    expect(Object.keys(VERDICT_RULES)).toHaveLength(20);
    for (const r of Object.values(VERDICT_RULES)) {
      expect(r.rule).toMatch(/^verdict\.[a-z0-9-]+@1$/);
      expect(r.reason).toMatch(/^[A-Z].*\.$/);
      expect(r.reason).not.toMatch(/score|points/i);
    }
  });
  it('possible is not a received address', () => {
    expect(
      ['exact', 'hashed', 'possible', 'none'].map((a) => addressReceived(a as AddressExposure)),
    ).toEqual([true, true, false, false]);
  });
  it('verdictsAtLeast follows unidentified > tracking > avoidable > expected', () => {
    expect(verdictsAtLeast('avoidable')).toEqual(['unidentified', 'tracking', 'avoidable']);
    expect(verdictsAtLeast('unidentified')).toEqual(['unidentified']);
  });
});

// ---------------------------------------------------------------------------

const contact = (over: Partial<ThirdPartyContact> = {}): ThirdPartyContact => ({
  host: 'api.segment.io',
  registrableDomain: 'segment.io',
  class: 'analytics',
  phases: ['post-connect'],
  requestCount: 1,
  ...over,
});
const match = (over: Partial<CanaryMatchEvidence> = {}): CanaryMatchEvidence => ({
  type: 'canary-match',
  phase: 'post-connect',
  location: 'request-body',
  method: 'POST',
  url: 'https://api.segment.io/v1/t',
  host: 'api.segment.io',
  registrableDomain: 'segment.io',
  recipientClass: 'analytics',
  encoding: 'lowercase',
  category: 'exact',
  snippet: '<CANARY>',
  ...over,
});

let n = 0;
function world(
  contacts: ThirdPartyContact[],
  leaks: Array<{ detector?: string; items: EvidenceItem[] }>,
): { contacts: ThirdPartyContact[]; findings: FindingV3[]; bundle: EvidenceBundle } {
  const items: Record<string, EvidenceItem> = {};
  const findings = leaks.map((l) => {
    const refs = l.items.map((i) => {
      items[evidenceId(i)] = i;
      return { id: evidenceId(i), type: i.type };
    });
    const id = `F-${(n++).toString(16).padStart(16, '0')}`;
    return {
      id,
      fingerprint: '0'.repeat(64),
      detector: l.detector ?? 'canary-leak',
      detectorVersion: '1.0.0',
      domain: 'privacy' as const,
      kind: 'issue' as const,
      severity: 'high' as const,
      confidence: 'confirmed' as const,
      title: 't',
      impact: 'i',
      remediation: 'r',
      evidence: refs,
    };
  });
  return { contacts, findings, bundle: { bundleVersion: 'igris.evidence.v3', items } };
}

describe('computeRecipients', () => {
  it('a contact with no address: none, ip phases, ip-exposure finding linked', () => {
    const c = contact({ phases: ['post-connect', 'pre-connect'] });
    const w = world(
      [c],
      [
        {
          detector: 'ip-exposure',
          items: [
            {
              type: 'third-party-contact',
              host: c.host,
              registrableDomain: c.registrableDomain,
              recipientClass: 'analytics',
              phases: ['pre-connect', 'post-connect'],
              methods: [],
              resourceTypes: [],
            },
          ],
        },
      ],
    );
    const [r] = computeRecipients(w);
    expect(r).toMatchObject({
      registrableDomain: 'segment.io',
      class: 'analytics',
      hosts: ['api.segment.io'],
      learned: { address: 'none', addressPhases: [], ip: ['pre-connect', 'post-connect'] },
      verdict: 'tracking',
      rule: 'verdict.analytics@1',
      findingIds: [w.findings[0]!.id],
    });
  });

  it('exact beats hashed beats possible; addressPhases follow the reported form', () => {
    const levels: Array<[CanaryMatchEvidence[], AddressExposure, Phase[]]> = [
      [[match({ category: 'partial', phase: 'pre-connect' })], 'possible', ['pre-connect']],
      [
        [match({ category: 'partial', phase: 'pre-connect' }), match({ category: 'hashed' })],
        'hashed',
        ['post-connect'],
      ],
      [
        [match({ category: 'hashed', phase: 'pre-connect' }), match({ category: 'exact' })],
        'exact',
        ['pre-connect', 'post-connect'],
      ],
    ];
    for (const [items, address, phases] of levels) {
      const [r] = computeRecipients(world([contact()], [{ items }]));
      expect(r!.learned.address).toBe(address);
      expect(r!.learned.addressPhases).toEqual(phases);
    }
  });

  it('cookie / storage matches are not transmissions and first party is never a recipient', () => {
    const w = world(
      [
        contact({
          class: 'first-party',
          host: 'app.example.org',
          registrableDomain: 'example.org',
        }),
      ],
      [
        { items: [match({ location: 'local-storage' })] },
        { items: [match({ location: 'cookie', host: 'segment.io' })] },
        {
          items: [
            match({
              recipientClass: 'first-party',
              host: 'api.example.org',
              registrableDomain: 'example.org',
            }),
          ],
        },
      ],
    );
    expect(computeRecipients(w)).toEqual([]);
  });

  it('a WebSocket-only recipient has ip [] and still gets a verdict', () => {
    const w = world(
      [],
      [
        {
          items: [
            match({
              location: 'websocket-frame',
              method: 'WS',
              host: 'relay.walletconnect.com',
              registrableDomain: 'walletconnect.com',
              recipientClass: 'walletconnect-relay',
            }),
          ],
        },
      ],
    );
    expect(computeRecipients(w)).toEqual([
      expect.objectContaining({
        class: 'walletconnect-relay',
        learned: { address: 'exact', addressPhases: ['post-connect'], ip: [] },
        verdict: 'expected',
        rule: 'verdict.walletconnect-relay-with-address@1',
      }),
    ]);
  });

  it('one recipient per (domain, class); hosts merged; sorted by verdict, domain, class', () => {
    const w = world(
      [
        contact({ host: 'cdn.b.example', registrableDomain: 'b.example', class: 'cdn' }),
        contact({
          host: 'x.a.example',
          registrableDomain: 'a.example',
          class: 'unknown-third-party',
        }),
        contact({
          host: 'y.a.example',
          registrableDomain: 'a.example',
          class: 'unknown-third-party',
        }),
        contact({ host: 'rpc.a.example', registrableDomain: 'a.example', class: 'rpc-provider' }),
        contact(),
      ],
      [],
    );
    const rs = computeRecipients(w);
    expect(rs.map((r) => [r.verdict, r.registrableDomain, r.class, r.hosts])).toEqual([
      ['unidentified', 'a.example', 'unknown-third-party', ['x.a.example', 'y.a.example']],
      ['tracking', 'segment.io', 'analytics', ['api.segment.io']],
      ['expected', 'a.example', 'rpc-provider', ['rpc.a.example']],
      ['expected', 'b.example', 'cdn', ['cdn.b.example']],
    ]);
  });

  it('is deterministic regardless of input order', () => {
    const cs = [
      contact(),
      contact({
        host: 'o1.ingest.sentry.io',
        registrableDomain: 'sentry.io',
        class: 'error-monitoring',
      }),
    ];
    const a = computeRecipients(world(cs, [{ items: [match()] }]));
    const b = computeRecipients(world([...cs].reverse(), [{ items: [match()] }]));
    expect(a.map((r) => [r.registrableDomain, r.verdict])).toEqual(
      b.map((r) => [r.registrableDomain, r.verdict]),
    );
  });
});

describe('anon-rpc and possible addresses (review findings)', () => {
  it('reasons never claim "no address" in a way that contradicts a possible match', () => {
    for (const cls of ['rpc-provider', 'cdn', 'ipfs-gateway', 'wallet-sdk'] as const) {
      expect(verdictFor(cls, 'possible').reason).not.toMatch(/saw no wallet address/);
    }
  });
});
