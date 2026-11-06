export { scan, SCANNER_VERSION, type ScanOptions, type EgressPolicy } from './scan.js';
export { buildReport, type BuildReportInput } from './report-builder.js';
export { TrafficRecorder, BODY_CAP_BYTES, type Capture } from './capture.js';
export { WalletReadHandler } from './stub-rpc.js';
export { buildWalletInitScript, type WalletInitConfig } from './wallet-init.js';
export { CONNECT_TEXT, WALLET_OPTION_TEXTS, type Recipe } from './connect.js';
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
