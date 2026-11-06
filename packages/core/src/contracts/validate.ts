/**
 * JSON Schema validation of the published contracts (Ajv, draft 2020-12,
 * strict mode). Used by the engine (evidence items), the migration, the CLI
 * (`igris verify`, `igris publish`) and the contract tests.
 */
// Named export: avoids CJS default-import interop differences between
// tsc (NodeNext), tsx and vitest.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_BUNDLE_SCHEMA_V1,
  EVIDENCE_BUNDLE_SCHEMA_V2,
  EVIDENCE_BUNDLE_VERSION_V1,
  EVIDENCE_BUNDLE_VERSION_V2,
  EVIDENCE_ITEM_SCHEMA,
  EVIDENCE_ITEM_SCHEMA_V2,
  EVIDENCE_ITEM_SCHEMA_V1,
} from './evidence.js';
import type { EvidenceBundleV1, EvidenceItem } from './evidence.js';
import {
  REPORT_SCHEMA_2_0_0,
  REPORT_SCHEMA_2_1_0,
  REPORT_SCHEMA_2_2_0,
  REPORT_V2_0_VERSION,
  REPORT_V2_1_VERSION,
} from './report-v2.js';
import type { ReportV2 } from './report-v2.js';

export class SchemaValidationError extends Error {
  constructor(
    public readonly schema: string,
    public readonly errors: ErrorObject[],
  ) {
    super(
      `${schema} validation failed: ` +
        errors
          .slice(0, 5)
          .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
          .join('; '),
    );
    this.name = 'SchemaValidationError';
  }
}

let compiled:
  | {
      item: ValidateFunction;
      bundleV1: ValidateFunction;
      bundleV2: ValidateFunction;
      bundle: ValidateFunction;
      report200: ValidateFunction;
      report210: ValidateFunction;
      report: ValidateFunction;
    }
  | undefined;

function validators() {
  if (!compiled) {
    // strict: unknown keywords/formats are errors, so a typo in a schema
    // cannot silently disable a check.
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addFormat('date-time', {
      type: 'string',
      validate: (s: string) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) &&
        !Number.isNaN(Date.parse(s)),
    });
    ajv.addSchema(EVIDENCE_ITEM_SCHEMA_V1);
    ajv.addSchema(EVIDENCE_ITEM_SCHEMA_V2);
    ajv.addSchema(EVIDENCE_ITEM_SCHEMA);
    compiled = {
      item: ajv.getSchema(EVIDENCE_ITEM_SCHEMA.$id)!,
      bundleV1: ajv.compile(EVIDENCE_BUNDLE_SCHEMA_V1),
      bundleV2: ajv.compile(EVIDENCE_BUNDLE_SCHEMA_V2),
      bundle: ajv.compile(EVIDENCE_BUNDLE_SCHEMA),
      report200: ajv.compile(REPORT_SCHEMA_2_0_0),
      report210: ajv.compile(REPORT_SCHEMA_2_1_0),
      report: ajv.compile(REPORT_SCHEMA_2_2_0),
    };
  }
  return compiled;
}

function check<T>(fn: ValidateFunction, name: string, value: unknown): T {
  if (!fn(value)) throw new SchemaValidationError(name, fn.errors ?? []);
  return value as T;
}

/** Validates an evidence item against the CURRENT (v3) item schema. */
export function validateEvidenceItem(value: unknown): EvidenceItem {
  return check(validators().item, 'evidence item', value);
}

/** Validates igris.evidence.v1 / v2 (frozen) and v3 bundles, by version. */
export function validateEvidenceBundle(value: unknown): EvidenceBundleV1 {
  const v = (value as { bundleVersion?: unknown } | null)?.bundleVersion;
  return v === EVIDENCE_BUNDLE_VERSION_V1
    ? check(validators().bundleV1, 'evidence bundle v1', value)
    : v === EVIDENCE_BUNDLE_VERSION_V2
      ? check(validators().bundleV2, 'evidence bundle v2', value)
      : check(validators().bundle, 'evidence bundle', value);
}

/** Validates report 2.0.0 / 2.1.0 (frozen) and 2.2.0, by reportVersion. */
export function validateReportV2(value: unknown): ReportV2 {
  const v = (value as { reportVersion?: unknown } | null)?.reportVersion;
  return v === REPORT_V2_0_VERSION
    ? check(validators().report200, 'report 2.0.0', value)
    : v === REPORT_V2_1_VERSION
      ? check(validators().report210, 'report 2.1.0', value)
      : check(validators().report, 'report 2.2.0', value);
}
