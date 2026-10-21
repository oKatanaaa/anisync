/**
 * Sync math shared by the browser client and the tests.
 *
 * The server is authoritative: it publishes an *anchor* — a (position, server
 * timestamp, rate) triple. Clients reconstruct "where should the video be right
 * now" from that anchor and nudge their own player toward it.
 *
 * Nothing here touches the DOM or the network, so it can be unit tested and
 * reasoned about in isolation. That is the whole point of this file.
 */

/** Drift correction tuning. Times are in seconds. */
export const TUNING = {
  /** Inside this window we do nothing at all — chasing noise makes it worse. */
  DEADBAND: 0.08,
  /** Above this we stop being clever and just seek. */
  SEEK_THRESHOLD: 0.6,
  /** Largest playbackRate deviation used for smooth catch-up. */
  MAX_NUDGE: 0.05,
  /** Once nudging, return to 1.0x only when drift is back inside this window. */
  SETTLE: 0.02,
};

/**
 * Turn the four NTP-ish timestamps into a clock offset and round trip time.
 *
 * @param {number} t0 client clock, request sent
 * @param {number} t3 client clock, response received
 * @param {number} serverTime server clock stamped between t0 and t3
 * @returns {{offset: number, rtt: number}} offset: add to client clock to get server clock
 */
export function clockSample(t0, t3, serverTime) {
  const rtt = t3 - t0;
  return { offset: serverTime - (t0 + t3) / 2, rtt };
}

/**
 * Pick the best sample from a sliding window: the one with the lowest round
 * trip, because queueing delay only ever pushes the estimate one way.
 *
 * @param {Array<{offset:number, rtt:number}>} samples
 */
export function pickOffset(samples, windowSize = 9) {
  if (!samples || samples.length === 0) return 0;
  const recent = samples.slice(-windowSize);
  let best = recent[0];
  for (const s of recent) if (s.rtt < best.rtt) best = s;
  return best.offset;
}

/**
 * Where the room says the video should be, in seconds, on the media timeline.
 *
 * @param {{playing:boolean, position:number, anchor:number, rate:number}} state
 * @param {number} serverNow current server-clock time in ms
 */
export function expectedPosition(state, serverNow) {
  if (!state) return 0;
  if (!state.playing) return state.position;
  const elapsed = (serverNow - state.anchor) / 1000;
  if (elapsed <= 0) return state.position; // scheduled start hasn't fired yet
  return state.position + elapsed * (state.rate || 1);
}

/** True while a play/seek is scheduled but hasn't reached its start time yet. */
export function inPreRoll(state, serverNow) {
  return Boolean(state && state.playing && serverNow < state.anchor);
}

/**
 * Decide what the local player should do to converge on the room position.
 *
 * @param {object} p
 * @param {number} p.currentTime local player position, seconds
 * @param {number} p.expected authoritative position, seconds
 * @param {boolean} p.nudging currently applying a rate nudge (hysteresis)
 * @returns {{action:'none'|'nudge'|'restore'|'seek', rate:number, seekTo?:number, drift:number}}
 */
export function nextCorrection({ currentTime, expected, nudging }) {
  const drift = currentTime - expected; // positive => we are ahead of the room
  const abs = Math.abs(drift);

  if (abs <= (nudging ? TUNING.SETTLE : TUNING.DEADBAND)) {
    return { action: nudging ? 'restore' : 'none', rate: 1, drift };
  }

  if (abs >= TUNING.SEEK_THRESHOLD) {
    return { action: 'seek', rate: 1, seekTo: expected, drift };
  }

  // Proportional catch-up: the further off we are, the harder we pull, but
  // never enough that anyone can hear the pitch shift.
  const gain = Math.min(TUNING.MAX_NUDGE, 0.015 + abs * 0.08);
  return { action: 'nudge', rate: 1 + (drift > 0 ? -gain : gain), drift };
}

/**
 * Widen a seek target slightly so we land in the middle of a keyframe cluster
 * instead of exactly on a cut, which makes the decoder hunt.
 */
export function seekTarget(expected) {
  return Math.max(0, expected);
}

/** Small helper for the "synced ±Nms" badge. */
export function describeDrift(driftSeconds) {
  const ms = Math.round(Math.abs(driftSeconds) * 1000);
  if (ms < 40) return { label: `synced ±${ms}ms`, tone: 'good' };
  if (ms < 250) return { label: `aligned ${ms}ms`, tone: 'ok' };
  return { label: `off by ${(ms / 1000).toFixed(2)}s`, tone: 'bad' };
}
