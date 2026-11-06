/**
 * Compile-time lockstep between the TypeScript contract types and the key
 * lists the JSON Schemas are built from. This file is part of the build
 * (tsc), so adding a field to a type without adding it to its key list —
 * or vice versa — fails `pnpm -r build`. contracts.test.ts checks the other
 * half at runtime: key lists == schema properties.
 */
import type {
  CanaryMatchEvidence,
  DocumentHeadersEvidence,
  ThirdPartyContactEvidence,
} from './evidence.js';
import {
  CANARY_MATCH_KEYS,
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
  assertTrue<ExactKeys<typeof DOCUMENT_HEADER_NAMES, DocumentHeadersEvidence['headers']>>(true);

  // Privacy score and security observations are separate types: a security
  // observation is not a privacy finding, and it cannot count toward the score.
  const obs = {} as SecurityObservation;
  // @ts-expect-error — a SecurityObservation must never be usable as a PrivacyFinding
  const asPrivacy: PrivacyFinding = obs;
  // @ts-expect-error — countsTowardPrivacyScore is the literal `false` on observations
  const counted: SecurityObservation = { ...obs, countsTowardPrivacyScore: true };
  void asPrivacy;
  void counted;
}
