/**
 * JSON Schema validation of the published contracts (Ajv, draft 2020-12,
 * strict mode). Used by the engine (evidence items), the migration, the CLI
 * (`igris verify`, `igris publish`) and the contract tests.
 */
// Named export: avoids CJS default-import interop differences between
// tsc (NodeNext), tsx and vitest.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { EVIDENCE_BUNDLE_SCHEMA, EVIDENCE_ITEM_SCHEMA } from './evidence.js';
import type { EvidenceBundleV1, EvidenceItem } from './evidence.js';
import { REPORT_V2_SCHEMA } from './report-v2.js';
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
      bundle: ValidateFunction;
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
    ajv.addSchema(EVIDENCE_ITEM_SCHEMA);
    compiled = {
      item: ajv.getSchema(EVIDENCE_ITEM_SCHEMA.$id)!,
      bundle: ajv.compile(EVIDENCE_BUNDLE_SCHEMA),
      report: ajv.compile(REPORT_V2_SCHEMA),
    };
  }
  return compiled;
}

function check<T>(fn: ValidateFunction, name: string, value: unknown): T {
  if (!fn(value)) throw new SchemaValidationError(name, fn.errors ?? []);
  return value as T;
}

export function validateEvidenceItem(value: unknown): EvidenceItem {
  return check(validators().item, 'evidence item', value);
}

export function validateEvidenceBundle(value: unknown): EvidenceBundleV1 {
  return check(validators().bundle, 'evidence bundle', value);
}

export function validateReportV2(value: unknown): ReportV2 {
  return check(validators().report, 'report v2', value);
}
