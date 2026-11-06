/** CLI contract (designed for CI). */
export const EXIT = {
  OK: 0,
  /** Scan completed but the score is below --fail-under. */
  BELOW_THRESHOLD: 1,
  /** The scan itself failed (page did not load, browser crashed, …). */
  SCAN_ERROR: 2,
  INVALID_ARGS: 3,
} as const;
