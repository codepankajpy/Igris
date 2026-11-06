export {
  scan,
  SCANNER_VERSION,
  SCAN_STAGES,
  type ScanOptions,
  type EgressPolicy,
  type ScanStage,
  type ScanProgressEvent,
} from './scan.js';
export { TrafficRecorder, BODY_CAP_BYTES, type Capture } from './capture.js';
export type { ScanResult } from '@igris/core';
export { WalletReadHandler } from './stub-rpc.js';
export { buildWalletInitScript, type WalletInitConfig } from './wallet-init.js';
export {
  startEgressProxy,
  egressChromiumArgs,
  parseAuthority,
  type EgressProxy,
  type EgressProxyOptions,
  type BlockedEgress,
  type Resolver,
} from './egress/proxy.js';
export { isPublicAddress, isPublicIPv4, isPublicIPv6 } from './egress/ip-policy.js';
export {
  classifyLoad,
  cleanNavError,
  observeLoad,
  type LoadObservation,
  type LoadVerdict,
} from './load-state.js';
export {
  collectKitSignals,
  identifyKit,
  type KitFingerprint,
  type KitSignal,
} from './connect/fingerprint.js';
export {
  scoreCandidates,
  isNavigatingLink,
  TIERS,
  MIN_SCORE,
  type ScoredCandidate,
} from './connect/candidates.js';
export { openConnectUi, isUnexpectedNavigation, type OpenResult } from './connect/open.js';
export { INVENTORY_PROBE, walletOptionAncestryProbe } from './connect/page-probes.js';
