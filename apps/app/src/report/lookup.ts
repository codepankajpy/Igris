/**
 * Lookups that join the report to its evidence bundle for display. Pure
 * indexing and ordering of backend data — no verdicts, no judgements.
 */
import type {
  CanaryMatchEvidence,
  EvidenceBundle,
  EvidenceItem,
  FindingV3,
  Recipient,
  ReportV3,
} from '@igris/core/contracts';

/** Order of evidence strength for display (exact form, then hashed, then partial). */
const CATEGORY_RANK: Record<string, number> = { exact: 0, hashed: 1, partial: 2 };
const TYPE_RANK: Record<string, number> = {
  'canary-match': 0,
  'third-party-contact': 1,
  'contact-classification': 2,
  'document-headers': 3,
};

export const recipientKey = (x: { registrableDomain: string; class: string }) =>
  `${x.registrableDomain}|${x.class}`;

export interface Lookup {
  finding: Map<string, FindingV3>;
  /** Evidence about a recipient, strongest first. */
  evidenceFor(r: Recipient): Array<{ id: string; item: EvidenceItem }>;
  /** Distinct "where · encoding" of full / hashed address forms the recipient received. */
  howFor(r: Recipient): string[];
  firstAddressMs(r: Recipient): number | null;
  firstContactMs(r: Recipient): number | null;
}

const LOCATION: Record<string, string> = {
  url: 'URL',
  'request-header': 'request header',
  'request-body': 'request body',
  'response-set-cookie': 'Set-Cookie',
  'websocket-frame': 'WebSocket frame',
  cookie: 'cookie',
  'local-storage': 'localStorage',
  'session-storage': 'sessionStorage',
};
export const locationLabel = (l: string) => LOCATION[l] ?? l;

export function buildLookup(report: ReportV3, bundle: EvidenceBundle): Lookup {
  const finding = new Map<string, FindingV3>(
    [...report.privacy.findings, ...report.security.observations].map((f) => [f.id, f]),
  );
  const times = new Map((report.timeline?.recipients ?? []).map((t) => [recipientKey(t), t]));
  const items = Object.entries(bundle.items);

  const matchesOf = (r: Recipient) => {
    const seen = new Set<string>();
    const out: Array<{ id: string; item: CanaryMatchEvidence }> = [];
    for (const fid of r.findingIds) {
      for (const ref of finding.get(fid)?.evidence ?? []) {
        const item = bundle.items[ref.id];
        if (item?.type !== 'canary-match' || seen.has(ref.id)) continue;
        if (item.registrableDomain !== r.registrableDomain || item.recipientClass !== r.class)
          continue;
        seen.add(ref.id);
        out.push({ id: ref.id, item });
      }
    }
    return out.sort(
      (a, b) =>
        (CATEGORY_RANK[a.item.category] ?? 9) - (CATEGORY_RANK[b.item.category] ?? 9) ||
        a.id.localeCompare(b.id),
    );
  };

  return {
    finding,
    evidenceFor(r) {
      const hosts = new Set(r.hosts);
      const other = items
        .filter(
          ([, i]) =>
            (i.type === 'third-party-contact' &&
              i.registrableDomain === r.registrableDomain &&
              i.recipientClass === r.class) ||
            (i.type === 'contact-classification' && hosts.has(i.host)),
        )
        .map(([id, item]) => ({ id, item }))
        .sort(
          (a, b) => TYPE_RANK[a.item.type]! - TYPE_RANK[b.item.type]! || a.id.localeCompare(b.id),
        );
      return [...matchesOf(r), ...other];
    },
    howFor(r) {
      const out: string[] = [];
      for (const { item } of matchesOf(r)) {
        if (item.category === 'partial') continue;
        const s = `${locationLabel(item.location)} · ${item.encoding}`;
        if (!out.includes(s)) out.push(s);
      }
      return out;
    },
    firstAddressMs: (r) => times.get(recipientKey(r))?.firstAddressMs ?? null,
    firstContactMs: (r) => times.get(recipientKey(r))?.firstContactMs ?? null,
  };
}

export function evidenceTitle(i: EvidenceItem): string {
  switch (i.type) {
    case 'canary-match':
      return `${i.host} · ${locationLabel(i.location)} · ${i.encoding}`;
    case 'third-party-contact':
      return `${i.host} · ${i.phases.join(' + ')}`;
    case 'document-headers':
      return `${i.documentUrl} · HTTP ${i.status}`;
    case 'contact-classification':
      return `${i.host} → ${i.relationship}`;
  }
}

export const EVIDENCE_TYPE_LABEL: Record<EvidenceItem['type'], string> = {
  'canary-match': 'Address match',
  'third-party-contact': 'Third-party contact',
  'document-headers': 'Document headers',
  'contact-classification': 'Classification',
};

export const PHASE_LABEL: Record<string, string> = {
  'pre-connect': 'before connecting',
  'post-connect': 'after connecting',
};
export const phases = (ps: readonly string[]) => ps.map((p) => PHASE_LABEL[p] ?? p).join(' and ');
