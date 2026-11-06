/**
 * THE scoring knobs. Every number that affects a score lives here and nowhere
 * else; docs/SCORING.md documents each one. This is a heuristic, not an audit.
 */
import type { RecipientClass } from './report.js';

export const WEIGHTS = {
  /**
   * Points subtracted when the canary address reaches a destination of this
   * class (per distinct (registrable domain, class) pair — see dedup below).
   * Rationale: an RPC provider necessarily learns the address to serve reads
   * (bad but expected); analytics/error/support tooling has no business seeing
   * it; an unknown third party is the worst case because nobody can audit it.
   */
  leak: {
    'rpc-provider': 15,
    'walletconnect-relay': 15,
    // The login / embedded-wallet vendor the dapp chose: it needs the address
    // to authenticate, but builds its own address ↔ IP ↔ session record.
    'wallet-sdk': 20,
    'ipfs-gateway': 20,
    cdn: 20,
    analytics: 25,
    'error-monitoring': 25,
    'support-chat': 25,
    'unknown-third-party': 35,
    // No penalty: the user chose to visit the first party, and anon-rpc is
    // the privacy-preserving path we recommend.
    'first-party': 0,
    'anon-rpc': 0,
  } satisfies Record<RecipientClass, number>,

  /**
   * Multiplier applied when a destination saw only *hashed* forms of the
   * address ("hashed, still linkable"): deterministic hashes can be joined
   * across datasets, but require the observer to precompute them.
   */
  hashedMultiplier: 0.5,

  /**
   * IP-exposure penalties: each distinct third-party registrable domain
   * contacted costs a little even when no address is seen, because the
   * third party learns the user's IP and that they use this dapp.
   * Phase B (after wallet connect) is slightly worse: the visit is now
   * known to be a *wallet user's* visit.
   */
  contact: {
    perDomainPreConnect: 2,
    perDomainPostConnect: 3,
    /** Cap per phase so one asset-heavy page doesn't zero the score. */
    capPerPhase: 15,
  },
} as const;
