/** VOD can trade a little startup time for resilience to Wi-Fi/relay dips. */
export const BUFFER = {
  FORWARD: 60,
  START: 8,
  RESUME: 12,
  NATIVE: 2,
  REPORT_MS: 500,
  REPORT_TTL_MS: 8000,
  STALL_GRACE_MS: 1000,
};

/** Contiguous data ahead of a position; later, disjoint ranges do not count. */
export function bufferedAhead(ranges, position) {
  for (const [start, end] of ranges) {
    if (start <= position + 0.05 && end > position) return Math.max(0, end - position);
  }
  return 0;
}

export function requiredBuffer({ managed = true, recovering = false, position = 0, duration = 0 }) {
  const target = managed ? (recovering ? BUFFER.RESUME : BUFFER.START) : BUFFER.NATIVE;
  return duration > 0 ? Math.min(target, Math.max(0, duration - position - 0.15)) : target;
}
