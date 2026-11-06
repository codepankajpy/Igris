/**
 * RPC inventory: which JSON-RPC endpoints the page called, which methods,
 * how often, and whether the wallet address appeared in those calls.
 * Telemetry (counts are volatile), never evidence. Built from the capture.
 */
import type { Capture } from './contracts/capture.js';
import { RPC_MAX_METHODS, type RpcEndpoint } from './contracts/report-v3.js';
import type { Classification } from './classify.js';
import { findCanary } from './detect.js';
import type { CanaryForms } from './encodings.js';
import type { Phase } from './report.js';

const METHOD = /^[A-Za-z0-9_]{1,64}$/;

/** JSON-RPC 2.0 method names in a body (single call or batch; other elements ignored). */
export function jsonRpcMethods(text: string | null): string[] {
  if (!text || text.length > 1_000_000) return [];
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof c !== 'object' || c === null) continue;
    const { jsonrpc, method } = c as { jsonrpc?: unknown; method?: unknown };
    if (jsonrpc === '2.0' && typeof method === 'string' && METHOD.test(method)) out.push(method);
  }
  return out;
}

export interface RpcInventoryOptions {
  classify: (host: string) => Classification;
  canary: CanaryForms;
  wasBlocked?: (u: URL) => boolean;
}

export function buildRpcInventory(capture: Capture, opts: RpcInventoryOptions): RpcEndpoint[] {
  const acc = new Map<
    string,
    {
      c: Classification;
      phases: Set<Phase>;
      requests: number;
      calls: Map<string, number>;
      address: boolean;
    }
  >();
  const add = (url: string, text: string | null, phase: Phase) => {
    const methods = jsonRpcMethods(text);
    if (!methods.length) return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (!u.hostname || opts.wasBlocked?.(u)) return;
    const c = opts.classify(u.hostname);
    const a = acc.get(c.host) ?? {
      c,
      phases: new Set(),
      requests: 0,
      calls: new Map(),
      address: false,
    };
    a.phases.add(phase);
    a.requests += 1;
    for (const m of methods) a.calls.set(m, (a.calls.get(m) ?? 0) + 1);
    if (!a.address && findCanary(text!, opts.canary).some((m) => m.category !== 'partial'))
      a.address = true;
    acc.set(c.host, a);
  };
  for (const r of capture.requests) add(r.url, r.body, r.phase);
  for (const f of capture.wsFrames) if (f.direction === 'sent') add(f.url, f.payload, f.phase);
  const order: Phase[] = ['pre-connect', 'post-connect'];
  return [...acc.values()]
    .map(({ c, phases, requests, calls, address }) => ({
      host: c.host,
      registrableDomain: c.registrableDomain,
      class: c.class,
      phases: order.filter((p) => phases.has(p)),
      requests,
      calls: [...calls.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, RPC_MAX_METHODS)
        .map(([method, count]) => ({ method, count })),
      addressSeen: address,
    }))
    .sort((x, y) => (x.host < y.host ? -1 : x.host > y.host ? 1 : 0));
}
