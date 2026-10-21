import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockSample,
  pickOffset,
  expectedPosition,
  inPreRoll,
  nextCorrection,
  TUNING,
} from '../shared/sync.js';

test('clockSample recovers the offset under symmetric latency', () => {
  // Server is 5000ms ahead. Request takes 30ms each way.
  const t0 = 1000;
  const t3 = 1060;
  const serverTime = 5000 + 1030; // stamped at the true midpoint
  const { offset, rtt } = clockSample(t0, t3, serverTime);
  assert.equal(rtt, 60);
  assert.ok(Math.abs(offset - 5000) < 0.001, `offset was ${offset}`);
});

test('clockSample stays correct when latency is asymmetric', () => {
  // 80ms out, 20ms back: the midpoint estimate absorbs the bias as error,
  // but the error is bounded by the asymmetry and must not flip sign wildly.
  const t0 = 0;
  const t3 = 100;
  const serverTime = 10000 + 80;
  const { offset, rtt } = clockSample(t0, t3, serverTime);
  assert.equal(rtt, 100);
  assert.ok(Math.abs(offset - (10000 + 30)) < 1e-9);
});

test('pickOffset prefers the lowest-latency sample', () => {
  const samples = [
    { offset: 100, rtt: 120 },
    { offset: 42, rtt: 12 },
    { offset: 90, rtt: 200 },
  ];
  assert.equal(pickOffset(samples), 42);
});

test('pickOffset ignores stale history outside the window', () => {
  const samples = [
    { offset: 999, rtt: 1 }, // ancient, best-looking gremlin
    { offset: 10, rtt: 40 },
    { offset: 12, rtt: 30 },
  ];
  assert.equal(pickOffset(samples, 2), 12);
});

test('pickOffset tolerates an empty window', () => {
  assert.equal(pickOffset([]), 0);
  assert.equal(pickOffset(undefined), 0);
});

test('expectedPosition tracks a playing room', () => {
  const state = { playing: true, position: 100, anchor: 10_000, rate: 1 };
  assert.equal(expectedPosition(state, 10_000), 100);
  assert.equal(expectedPosition(state, 12_000), 102);
  assert.equal(expectedPosition(state, 8_000), 100, 'pre-roll clamps to anchor position');
});

test('expectedPosition honours rate and paused rooms', () => {
  assert.equal(expectedPosition({ playing: true, position: 0, anchor: 0, rate: 2 }, 5000), 10);
  assert.equal(expectedPosition({ playing: false, position: 42, anchor: 0, rate: 1 }, 9999), 42);
  assert.equal(expectedPosition(null, 5), 0);
});

test('inPreRoll only during the scheduled start window', () => {
  const state = { playing: true, position: 0, anchor: 5000, rate: 1 };
  assert.equal(inPreRoll(state, 4000), true);
  assert.equal(inPreRoll(state, 5000), false);
  assert.equal(inPreRoll({ ...state, playing: false }, 4000), false);
});

test('nextCorrection leaves a well-synced player completely alone', () => {
  const r = nextCorrection({ currentTime: 100.02, expected: 100, nudging: false });
  assert.equal(r.action, 'none');
  assert.equal(r.rate, 1);
});

test('nextCorrection seeks when far out of sync', () => {
  const ahead = nextCorrection({ currentTime: 110, expected: 100, nudging: false });
  assert.equal(ahead.action, 'seek');
  assert.equal(ahead.seekTo, 100);

  const behind = nextCorrection({ currentTime: 95, expected: 100, nudging: false });
  assert.equal(behind.action, 'seek');
  assert.equal(behind.seekTo, 100);
});

test('nextCorrection nudges with the correct sign and bounded rate', () => {
  const ahead = nextCorrection({ currentTime: 100.3, expected: 100, nudging: false });
  assert.equal(ahead.action, 'nudge');
  assert.ok(ahead.rate < 1, 'ahead of the room => slow down');
  assert.ok(ahead.rate >= 1 - TUNING.MAX_NUDGE);

  const behind = nextCorrection({ currentTime: 99.7, expected: 100, nudging: false });
  assert.equal(behind.action, 'nudge');
  assert.ok(behind.rate > 1, 'behind the room => speed up');
  assert.ok(behind.rate <= 1 + TUNING.MAX_NUDGE);
});

test('nextCorrection uses hysteresis so it does not oscillate', () => {
  // Inside the deadband but still nudging: keep nudging until properly settled.
  const mid = nextCorrection({ currentTime: 100.04, expected: 100, nudging: true });
  assert.equal(mid.action, 'nudge');

  const settled = nextCorrection({ currentTime: 100.01, expected: 100, nudging: true });
  assert.equal(settled.action, 'restore');
  assert.equal(settled.rate, 1);
});

test('nextCorrection is stable across a simulated 60 second session', () => {
  let t = 0;
  let player = 0;
  const state = { playing: true, position: 0, anchor: 0, rate: 1 };
  let nudging = false;
  let seeks = 0;
  let maxDrift = 0;

  // Player runs 0.4% slow, like a real decoder that cannot quite keep up.
  for (let i = 0; i < 600; i++) {
    t += 0.1;
    player += 0.1 * 0.996;
    const expected = expectedPosition(state, t * 1000);
    const c = nextCorrection({ currentTime: player, expected, nudging });
    maxDrift = Math.max(maxDrift, Math.abs(c.drift));
    nudging = c.action === 'nudge';
    if (c.action === 'seek') {
      seeks++;
      player = c.seekTo;
      nudging = false;
    } else {
      player += 0.1 * (c.rate - 1);
    }
  }

  assert.equal(seeks, 0, 'a slightly slow player should be corrected without seeking');
  assert.ok(Math.abs(player - 60) < 0.15, `ended at ${player}`);
  assert.ok(maxDrift < TUNING.SEEK_THRESHOLD);
});
