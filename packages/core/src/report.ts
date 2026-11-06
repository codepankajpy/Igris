/**
 * Versioned report schema: TypeScript types plus a JSON Schema document kept
 * in lockstep. Bump REPORT_VERSION on any breaking shape change.
 */
import type { MatchCategory } from './encodings.js';

export const REPORT_VERSION = '1.0.0';

export type Phase = 'pre-connect' | 'post-connect';

export const RECIPIENT_CLASSES = [
  'first-party',
  'rpc-provider',
  'analytics',
  'error-monitoring',
  'support-chat',
  'walletconnect-relay',
  'ipfs-gateway',
  'cdn',
  'anon-rpc',
  'unknown-third-party',
] as const;
export type RecipientClass = (typeof RECIPIENT_CLASSES)[number];

export type LeakLocation =
  | 'url'
  | 'request-header'
  | 'request-body'
  | 'response-set-cookie'
  | 'websocket-frame'
  | 'cookie'
  | 'local-storage'
  | 'session-storage';

export type ScanStatus = 'completed' | 'page-load-failed' | 'wallet-connect-failed';

export interface Finding {
  /** Stable, deterministic id: "f1", "f2", … in sorted order. */
  id: string;
  category: MatchCategory;
  encoding: string;
  location: LeakLocation;
  /** Destination URL with the canary redacted. */
  url: string;
  /** HTTP method, or "WS" for websocket frames, "-" for cookies/storage. */
  method: string;
  host: string;
  registrableDomain: string;
  class: RecipientClass;
  phase: Phase;
  /** Canary replaced by <CANARY>, 40 chars of context either side. */
  snippet: string;
  /**
   * false for: partial matches (low confidence), storage/cookie findings
   * (persisted locally, no third party involved), and first-party/anon-rpc
   * destinations.
   */
  countsTowardScore: boolean;
}

export interface ThirdPartyContact {
  host: string;
  registrableDomain: string;
  class: RecipientClass;
  phases: Phase[];
  requestCount: number;
  methods?: string[];
  resourceTypes?: string[];
}

export interface ReportSummary {
  totalRequests: number;
  preConnectRequests: number;
  postConnectRequests: number;
  wsConnections: number;
  cookiesCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
}

export interface SecurityHeaders {
  cspPresent: boolean;
  hstsPresent: boolean;
  xFrameOptions?: string;
}

export interface WalletRead {
  method: string;
  count: number;
}

export interface PenaltyLine {
  id: string;
  /** Human-readable explanation of this deduction. */
  label: string;
  /** Points subtracted (positive number). */
  points: number;
  /** Which weight rule produced it, e.g. "leak.analytics". */
  rule: string;
  findingIds: string[];
}

export interface Report {
  reportVersion: string;
  scannerVersion: string;
  target: string;
  hostname: string;
  scannedAt: string;
  chainId: number;
  status: ScanStatus;
  /** The throwaway canary address used for this scan (never reused). */
  canaryAddress: string;
  spoofMetaMask: boolean;
  findings: Finding[];
  thirdParties: ThirdPartyContact[];
  /** Reads the dapp routed through the wallet — best case, no penalty. */
  readsViaWallet: WalletRead[];
  usesAnonRpc: boolean;
  score: number;
  ledger: PenaltyLine[];
  errors: string[];
  summary?: ReportSummary;
  securityHeaders?: SecurityHeaders;
  connectionLog?: string[];
}

/**
 * JSON Schema (draft 2020-12) for Report. Exported so external consumers can
 * validate reports without TypeScript; kept in lockstep with the types above
 * (a unit test checks a real report against it).
 */
export const REPORT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://igris.dev/schemas/report-1.0.0.json',
  title: 'Igris scan report',
  type: 'object',
  required: [
    'reportVersion',
    'scannerVersion',
    'target',
    'hostname',
    'scannedAt',
    'chainId',
    'status',
    'canaryAddress',
    'spoofMetaMask',
    'findings',
    'thirdParties',
    'readsViaWallet',
    'usesAnonRpc',
    'score',
    'ledger',
    'errors',
  ],
  properties: {
    reportVersion: { type: 'string' },
    scannerVersion: { type: 'string' },
    target: { type: 'string' },
    hostname: { type: 'string' },
    scannedAt: { type: 'string', format: 'date-time' },
    chainId: { type: 'integer' },
    status: { enum: ['completed', 'page-load-failed', 'wallet-connect-failed'] },
    canaryAddress: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
    spoofMetaMask: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'category',
          'encoding',
          'location',
          'url',
          'method',
          'host',
          'registrableDomain',
          'class',
          'phase',
          'snippet',
          'countsTowardScore',
        ],
        properties: {
          id: { type: 'string' },
          category: { enum: ['exact', 'hashed', 'partial'] },
          encoding: { type: 'string' },
          location: {
            enum: [
              'url',
              'request-header',
              'request-body',
              'response-set-cookie',
              'websocket-frame',
              'cookie',
              'local-storage',
              'session-storage',
            ],
          },
          url: { type: 'string' },
          method: { type: 'string' },
          host: { type: 'string' },
          registrableDomain: { type: 'string' },
          class: { enum: [...RECIPIENT_CLASSES] },
          phase: { enum: ['pre-connect', 'post-connect'] },
          snippet: { type: 'string' },
          countsTowardScore: { type: 'boolean' },
        },
      },
    },
    thirdParties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['host', 'registrableDomain', 'class', 'phases', 'requestCount'],
        properties: {
          host: { type: 'string' },
          registrableDomain: { type: 'string' },
          class: { enum: [...RECIPIENT_CLASSES] },
          phases: { type: 'array', items: { enum: ['pre-connect', 'post-connect'] } },
          requestCount: { type: 'integer' },
          methods: { type: 'array', items: { type: 'string' } },
          resourceTypes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    readsViaWallet: {
      type: 'array',
      items: {
        type: 'object',
        required: ['method', 'count'],
        properties: { method: { type: 'string' }, count: { type: 'integer' } },
      },
    },
    usesAnonRpc: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    ledger: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label', 'points', 'rule', 'findingIds'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          points: { type: 'number' },
          rule: { type: 'string' },
          findingIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    errors: { type: 'array', items: { type: 'string' } },
    summary: {
      type: 'object',
      properties: {
        totalRequests: { type: 'integer' },
        preConnectRequests: { type: 'integer' },
        postConnectRequests: { type: 'integer' },
        wsConnections: { type: 'integer' },
        cookiesCount: { type: 'integer' },
        localStorageCount: { type: 'integer' },
        sessionStorageCount: { type: 'integer' },
      },
    },
    securityHeaders: {
      type: 'object',
      properties: {
        cspPresent: { type: 'boolean' },
        hstsPresent: { type: 'boolean' },
        xFrameOptions: { type: 'string' },
      },
    },
    connectionLog: { type: 'array', items: { type: 'string' } },
  },
} as const;
