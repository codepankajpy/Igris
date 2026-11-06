/**
 * Recipients and their verdicts (report 3.0.0, docs/design/REPORT-3.0.0.md).
 *
 * Pure and deterministic: derived only from the report's contacts, its
 * findings and the evidence bundle they point into — so the engine, the
 * 2.x → 3.0.0 migration and any reader compute the same recipients.
 *
 * One recipient per (registrable domain, class) that the page contacted
 * over HTTP(S) or that received a form of the address. First party is never
 * a recipient. What it learned:
 *  - address: exact if any transmitted canary match (not cookie / storage)
 *    was an exact or encoded form; else hashed if any was hashed; else
 *    possible if only a truncated display form was; else none;
 *  - addressPhases: the phases of the matches behind that answer
 *    (exact + hashed for exact/hashed, truncated for possible);
 *  - ip: the phases in which it received HTTP(S) requests ([] = WebSocket only).
 *
 * The verdict is a fixed function of (class, address received?) — see
 * VERDICT_RULES. "possible" counts as no address.
 */
import type { Phase, ThirdPartyContact } from './report.js';
import type {
  CanaryMatchEvidence,
  EvidenceBundle,
  ThirdPartyContactEvidence,
} from './contracts/evidence.js';
import {
  VERDICTS,
  type AddressExposure,
  type FindingV3,
  type Recipient,
  type RecipientV3Class,
  type Verdict,
} from './contracts/report-v3.js';
import { CANARY_LEAK_DETECTOR_ID } from './detectors/canary-leak.js';
import { IP_EXPOSURE_DETECTOR_ID } from './detectors/ip-exposure.js';

export interface VerdictRule {
  verdict: Verdict;
  /** "verdict.<name>@<n>" */
  rule: string;
  reason: string;
}

/** Rule-id slug per class ("rpc" and "unidentified" read better than the class names). */
const SLUG: Record<RecipientV3Class, string> = {
  'unknown-third-party': 'unidentified',
  analytics: 'analytics',
  'error-monitoring': 'error-monitoring',
  'support-chat': 'support-chat',
  'rpc-provider': 'rpc',
  cdn: 'cdn',
  'ipfs-gateway': 'ipfs-gateway',
  'walletconnect-relay': 'walletconnect-relay',
  'wallet-sdk': 'wallet-sdk',
  'anon-rpc': 'anon-rpc',
};

type Cell = readonly [Verdict, string];

/**
 * The verdict table: class → [with address (exact/hashed), without address].
 * Each cell is one rule with one plain-English reason.
 */
const TABLE: Record<RecipientV3Class, { address: Cell; none: Cell }> = {
  'unknown-third-party': {
    address: [
      'unidentified',
      'An unidentified third party received the wallet address; nobody can say what it does with it.',
    ],
    none: [
      'unidentified',
      'An unidentified third party was contacted; nobody can say what it does with what it receives.',
    ],
  },
  analytics: {
    address: [
      'tracking',
      'An analytics service received the wallet address and can tie it to the visitor’s profile; the app does not need it to work.',
    ],
    none: ['tracking', 'An analytics service profiles visitors; the app does not need it to work.'],
  },
  'error-monitoring': {
    address: [
      'tracking',
      'An error-monitoring service received the wallet address, which it does not need, and stores it with the visitor’s IP and device data.',
    ],
    none: [
      'avoidable',
      'An error-monitoring service learns the visitor’s IP address; the app works without it.',
    ],
  },
  'support-chat': {
    address: [
      'tracking',
      'A support-chat service received the wallet address, which it does not need, alongside the visitor’s IP.',
    ],
    none: [
      'avoidable',
      'A support-chat service learns the visitor’s IP address; the app works without it.',
    ],
  },
  'rpc-provider': {
    address: [
      'avoidable',
      'An RPC provider received the wallet address with the visitor’s IP; routing reads through Anon-RPC or the wallet avoids this.',
    ],
    none: [
      'expected',
      'An RPC provider serves the app’s blockchain reads; it received no full or hashed form of the wallet address.',
    ],
  },
  cdn: {
    address: [
      'avoidable',
      'A CDN received the wallet address, which it does not need to serve files.',
    ],
    none: [
      'expected',
      'A CDN serves the app’s files; it received no full or hashed form of the wallet address.',
    ],
  },
  'ipfs-gateway': {
    address: [
      'avoidable',
      'An IPFS gateway received the wallet address, which it does not need to serve content.',
    ],
    none: [
      'expected',
      'An IPFS gateway serves the app’s content; it received no full or hashed form of the wallet address.',
    ],
  },
  'walletconnect-relay': {
    address: [
      'expected',
      'The WalletConnect relay carries the wallet connection; it can link the address to the visitor’s IP.',
    ],
    none: ['expected', 'The WalletConnect relay carries the wallet connection.'],
  },
  'wallet-sdk': {
    address: [
      'expected',
      'The login or wallet SDK the dApp chose needs the address to sign the user in, but keeps its own record of it (address, IP, device, sessions) outside the dApp.',
    ],
    none: [
      'expected',
      'The login or wallet SDK the dApp chose; it received no full or hashed form of the wallet address.',
    ],
  },
  'anon-rpc': {
    address: [
      'expected',
      'Anon-RPC relays the app’s reads without revealing the visitor’s IP to the RPC provider.',
    ],
    none: [
      'expected',
      'Anon-RPC relays the app’s reads without revealing the visitor’s IP to the RPC provider.',
    ],
  },
};

/** Every verdict rule, keyed by rule id (for documentation and tests). */
export const VERDICT_RULES: Readonly<Record<string, VerdictRule>> = Object.fromEntries(
  (Object.keys(TABLE) as RecipientV3Class[]).flatMap((cls) =>
    (['address', 'none'] as const).map((k) => {
      const [verdict, reason] = TABLE[cls][k];
      const rule = `verdict.${SLUG[cls]}${k === 'address' ? '-with-address' : ''}@1`;
      return [rule, { verdict, rule, reason }];
    }),
  ),
);

/** True when the address (exact or hashed) reached the recipient; "possible" does not count. */
export function addressReceived(address: AddressExposure): boolean {
  return address === 'exact' || address === 'hashed';
}

/** The verdict rule for a class and what it learned of the address. */
export function verdictFor(cls: RecipientV3Class, address: AddressExposure): VerdictRule {
  const withAddress = addressReceived(address);
  const [verdict, reason] = TABLE[cls][withAddress ? 'address' : 'none'];
  return {
    verdict,
    rule: `verdict.${SLUG[cls]}${withAddress ? '-with-address' : ''}@1`,
    reason,
  };
}

const VERDICT_RANK: Record<Verdict, number> = Object.fromEntries(
  VERDICTS.map((v, i) => [v, i]),
) as Record<Verdict, number>;

/** Sort order: verdict (unidentified first), then domain, then class. */
export function compareRecipients(
  a: Pick<Recipient, 'verdict' | 'registrableDomain' | 'class'>,
  b: Pick<Recipient, 'verdict' | 'registrableDomain' | 'class'>,
): number {
  return (
    VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
    (a.registrableDomain < b.registrableDomain
      ? -1
      : a.registrableDomain > b.registrableDomain
        ? 1
        : 0) ||
    (a.class < b.class ? -1 : a.class > b.class ? 1 : 0)
  );
}

const PHASE_ORDER: Record<Phase, number> = { 'pre-connect': 0, 'post-connect': 1 };
const sortPhases = (s: Set<Phase>): Phase[] =>
  [...s].sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]);

/** Canary matches in these locations stayed on the visitor's machine. */
const LOCAL_LOCATIONS = new Set(['cookie', 'local-storage', 'session-storage']);

export function isTransmitted(e: Pick<CanaryMatchEvidence, 'location'>): boolean {
  return !LOCAL_LOCATIONS.has(e.location);
}

export interface RecipientInput {
  /** Report contacts (first-party entries, if any, are ignored). */
  contacts: readonly ThirdPartyContact[];
  /** All findings of the report (privacy and security; 2.x or 3.0.0 shape). */
  findings: readonly Pick<FindingV3, 'id' | 'detector' | 'evidence'>[];
  bundle: EvidenceBundle;
}

interface Acc {
  registrableDomain: string;
  class: RecipientV3Class;
  hosts: Set<string>;
  ip: Set<Phase>;
  exact: Set<Phase>;
  hashed: Set<Phase>;
  partial: Set<Phase>;
  findingIds: Set<string>;
}

/** The recipients of a scan, with verdicts, in report order. */
export function computeRecipients(input: RecipientInput): Recipient[] {
  const acc = new Map<string, Acc>();
  const get = (registrableDomain: string, cls: RecipientV3Class): Acc => {
    const key = `${registrableDomain}|${cls}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        registrableDomain,
        class: cls,
        hosts: new Set(),
        ip: new Set(),
        exact: new Set(),
        hashed: new Set(),
        partial: new Set(),
        findingIds: new Set(),
      };
      acc.set(key, a);
    }
    return a;
  };

  for (const c of input.contacts) {
    if (c.class === 'first-party' || !c.host) continue;
    const a = get(c.registrableDomain, c.class);
    a.hosts.add(c.host);
    for (const p of c.phases) a.ip.add(p);
  }

  for (const f of input.findings) {
    if (f.detector !== CANARY_LEAK_DETECTOR_ID && f.detector !== IP_EXPOSURE_DETECTOR_ID) continue;
    for (const ref of f.evidence) {
      const item = input.bundle.items[ref.id];
      if (!item) continue;
      if (f.detector === CANARY_LEAK_DETECTOR_ID && item.type === 'canary-match') {
        const e: CanaryMatchEvidence = item;
        if (e.recipientClass === 'first-party' || !isTransmitted(e) || !e.host) continue;
        // Anon-RPC is the private path we recommend: what it relays is an
        // observation, not an exposure (spec: address from canary-leak issues).
        if (e.recipientClass === 'anon-rpc') {
          get(e.registrableDomain, e.recipientClass).hosts.add(e.host);
          continue;
        }
        const a = get(e.registrableDomain, e.recipientClass);
        a.hosts.add(e.host);
        a.findingIds.add(f.id);
        (e.category === 'exact' ? a.exact : e.category === 'hashed' ? a.hashed : a.partial).add(
          e.phase,
        );
      } else if (f.detector === IP_EXPOSURE_DETECTOR_ID && item.type === 'third-party-contact') {
        const e: ThirdPartyContactEvidence = item;
        if (e.recipientClass === 'first-party') continue;
        const a = acc.get(`${e.registrableDomain}|${e.recipientClass}`);
        // ip-exposure evidence mirrors the contacts; it never creates a recipient.
        if (a) a.findingIds.add(f.id);
      }
    }
  }

  const out: Recipient[] = [];
  for (const a of acc.values()) {
    const address: AddressExposure = a.exact.size
      ? 'exact'
      : a.hashed.size
        ? 'hashed'
        : a.partial.size
          ? 'possible'
          : 'none';
    const addressPhases =
      address === 'exact' || address === 'hashed'
        ? new Set([...a.exact, ...a.hashed])
        : address === 'possible'
          ? a.partial
          : new Set<Phase>();
    const v = verdictFor(a.class, address);
    out.push({
      registrableDomain: a.registrableDomain,
      class: a.class,
      hosts: [...a.hosts].sort(),
      learned: { address, addressPhases: sortPhases(addressPhases), ip: sortPhases(a.ip) },
      verdict: v.verdict,
      rule: v.rule,
      reason: v.reason,
      findingIds: [...a.findingIds].sort(),
    });
  }
  return out.sort(compareRecipients);
}

/** The worst verdict first; `atLeast(v)` = every verdict as bad as or worse than v. */
export function verdictsAtLeast(v: Verdict): Verdict[] {
  return VERDICTS.slice(0, VERDICTS.indexOf(v) + 1);
}
