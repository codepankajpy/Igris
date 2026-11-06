/**
 * Compile-time lockstep between the TypeScript contract types and the key
 * lists the JSON Schemas are built from. This file is part of the build
 * (tsc), so adding a field to a type without adding it to its key list —
 * or vice versa — fails `pnpm -r build`. contracts.test.ts checks the other
 * half at runtime: key lists == schema properties.
 */
import type {
  ContactClassificationEvidence,
  CanaryMatchEvidence,
  DocumentHeadersEvidence,
  ThirdPartyContactEvidence,
} from './evidence.js';
import {
  CANARY_MATCH_KEYS,
  CONTACT_CLASSIFICATION_KEYS,
  DOCUMENT_HEADERS_KEYS,
  DOCUMENT_HEADER_NAMES,
  THIRD_PARTY_CONTACT_KEYS,
} from './evidence.js';
import type {
  FindingV2,
  PrivacyFinding,
  ReportV2,
  ScanMetaV2,
  SecurityObservation,
  TelemetryV2,
} from './report-v2.js';
import { FINDING_KEYS, REPORT_V2_KEYS, SCAN_META_KEYS, TELEMETRY_KEYS } from './report-v2.js';
import type {
  FindingV3,
  PrivacyFindingV3,
  Recipient,
  RecipientLearned,
  ReportV3,
  SecurityObservationV3,
  Timeline,
  TimelineRecipient,
} from './report-v3.js';
import {
  FINDING_V3_KEYS,
  RECIPIENT_KEYS,
  RECIPIENT_LEARNED_KEYS,
  REPORT_V3_KEYS,
  TIMELINE_KEYS,
  TIMELINE_RECIPIENT_KEYS,
} from './report-v3.js';

/** true iff the key list is exactly keyof T (no missing, no extra). */
type ExactKeys<K extends readonly string[], T> = [Exclude<keyof T, K[number]>] extends [never]
  ? [Exclude<K[number], keyof T>] extends [never]
    ? true
    : false
  : false;

function assertTrue<T extends true>(_: T): void {}

export function _lockstep(): void {
  assertTrue<ExactKeys<typeof FINDING_KEYS, FindingV2>>(true);
  assertTrue<ExactKeys<typeof SCAN_META_KEYS, ScanMetaV2>>(true);
  assertTrue<ExactKeys<typeof TELEMETRY_KEYS, TelemetryV2>>(true);
  assertTrue<ExactKeys<typeof REPORT_V2_KEYS, ReportV2>>(true);
  assertTrue<ExactKeys<typeof CANARY_MATCH_KEYS, CanaryMatchEvidence>>(true);
  assertTrue<ExactKeys<typeof THIRD_PARTY_CONTACT_KEYS, ThirdPartyContactEvidence>>(true);
  assertTrue<ExactKeys<typeof DOCUMENT_HEADERS_KEYS, DocumentHeadersEvidence>>(true);
  assertTrue<ExactKeys<typeof CONTACT_CLASSIFICATION_KEYS, ContactClassificationEvidence>>(true);
  assertTrue<ExactKeys<typeof DOCUMENT_HEADER_NAMES, DocumentHeadersEvidence['headers']>>(true);
  assertTrue<ExactKeys<typeof FINDING_V3_KEYS, FindingV3>>(true);
  assertTrue<ExactKeys<typeof RECIPIENT_KEYS, Recipient>>(true);
  assertTrue<ExactKeys<typeof RECIPIENT_LEARNED_KEYS, RecipientLearned>>(true);
  assertTrue<ExactKeys<typeof TIMELINE_KEYS, Timeline>>(true);
  assertTrue<ExactKeys<typeof TIMELINE_RECIPIENT_KEYS, TimelineRecipient>>(true);
  assertTrue<ExactKeys<typeof REPORT_V3_KEYS, ReportV3>>(true);

  // Privacy score and security observations are separate types: a security
  // observation is not a privacy finding, and it cannot count toward the score.
  const obs = {} as SecurityObservation;
  // @ts-expect-error — a SecurityObservation must never be usable as a PrivacyFinding
  const asPrivacy: PrivacyFinding = obs;
  // @ts-expect-error — countsTowardPrivacyScore is the literal `false` on observations
  const counted: SecurityObservation = { ...obs, countsTowardPrivacyScore: true };
  void asPrivacy;
  void counted;

  // 3.0.0: the same separation by type, and no score flag at all.
  const obs3 = {} as SecurityObservationV3;
  // @ts-expect-error — a 3.0.0 security observation is not a privacy finding
  const asPrivacy3: PrivacyFindingV3 = obs3;
  // @ts-expect-error — 3.0.0 findings carry no countsTowardPrivacyScore
  const flagged: FindingV3 = { ...obs3, countsTowardPrivacyScore: false };
  void asPrivacy3;
  void flagged;
}
