import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/rooms.js';
import { BUFFER, bufferedAhead, requiredBuffer } from '../shared/playback.js';

function party() {
  let now = 1_000_000;
  const room = new Room({ now: () => now, startDelayMs: 100, seekDelayMs: 50 });
  const a = room.join({ id: 'a', name: 'Ana', bufferSync: true }).user;
  const b = room.join({ id: 'b', name: 'Ben', bufferSync: true }).user;
  room.apply(a, { t: 'select', mediaId: 'episode', duration: 120 });
  const report = (user, values = {}) => room.apply({ id: user.id, name: user.name }, {
    t: 'playback', mediaId: 'episode', seq: room.state.seq, position: room.state.position,
    ahead: 20, decodable: true, managed: true, stalled: false, ...values,
  });
  const start = (position = 20) => {
    room.apply(a, { t: 'play', position }); report(a); report(b); now += 100;
  };
  return { room, a, b, report, start, tick: (ms) => { now += ms; } };
}

test('buffer ranges must cover the playhead, not just a later part of the file', () => {
  assert.equal(bufferedAhead([[0, 4], [12, 30]], 6), 0);
  assert.equal(bufferedAhead([[0, 4], [12, 30]], 13), 17);
  assert.equal(bufferedAhead([[0, 4]], 4), 0);
  assert.equal(requiredBuffer({ duration: 120, position: 118, recovering: true }), 1.85);
});

test('the room starts together only after every managed viewer has a reserve', () => {
  const t = party();
  t.room.apply(t.a, { t: 'play', position: 20 });
  assert.equal(t.room.state.buffering, true);
  t.tick(5000);
  assert.equal(t.room.expected(), 20);
  t.report(t.a, { ahead: 12 }); t.report(t.b, { ahead: 7 });
  assert.equal(t.room.state.buffering, true);
  t.report(t.b, { ahead: 8 });
  assert.equal(t.room.state.buffering, false);
  t.tick(1100);
  assert.equal(t.room.expected(), 21);
});

test('a sustained stall freezes the timeline and refills before resuming', () => {
  const t = party(); t.start(); t.tick(1000);
  t.report(t.b, { position: 20.7, ahead: 0, stalled: true, decodable: false });
  assert.equal(t.room.state.buffering, false, 'a short interruption is tolerated');
  t.tick(1100);
  t.report(t.b, { position: 20.7, ahead: 0.1, stalled: true, decodable: false });
  assert.equal(t.room.state.buffering, true);
  assert.equal(t.room.state.position, 20.7, 'do not skip the line missed by the stalled viewer');
  t.report(t.a); t.report(t.b, { ahead: 8 });
  assert.equal(t.room.state.buffering, true, 'recovery requires a larger reserve');
  t.tick(1000); t.report(t.b, { ahead: 12 });
  assert.equal(t.room.state.buffering, false);
});

test('a source swap at local zero cannot rewind the room to the beginning', () => {
  const t = party(); t.start(60);
  t.report(t.b, { position: 0, ahead: 0, loading: true, decodable: false, stalled: true });
  t.tick(1100);
  t.report(t.b, { position: 0, ahead: 0, loading: true, decodable: false, stalled: true });
  assert.equal(t.room.state.buffering, true);
  assert.ok(t.room.state.position >= 60);
});

test('late reports from a previous seek or episode cannot release a hold', () => {
  const t = party(); t.start();
  const oldSeq = t.room.state.seq;
  t.room.apply(t.a, { t: 'seek', position: 70 });
  t.report(t.a);
  t.report(t.b, { seq: oldSeq });
  t.report(t.b, { mediaId: 'previous-episode' });
  assert.equal(t.room.state.buffering, true);
  t.report(t.b, { position: 0 });
  assert.equal(t.room.state.buffering, true, 'old position is not readiness at the new target');
  t.report(t.b);
  assert.equal(t.room.state.buffering, false);
});

test('an intentional pause cancels automatic resume, including with the host lock', () => {
  const t = party();
  t.room.apply(t.a, { t: 'lock', value: true });
  t.room.apply(t.a, { t: 'play', position: 20 });
  t.room.apply(t.a, { t: 'pause' });
  t.report(t.a); t.report(t.b);
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.state.buffering, false);
  t.room.apply(t.a, { t: 'play', position: 20 });
  t.report(t.a); t.report(t.b);
  assert.equal(t.room.state.buffering, false, 'the host lock never blocks a guest readiness report');
});

test('leaving or an expired report does not strand the remaining viewers', () => {
  const t = party();
  t.room.apply(t.a, { t: 'play', position: 20 }); t.report(t.a);
  t.room.leave(t.b.id);
  assert.equal(t.room.state.buffering, false);
  const u = party();
  u.room.apply(u.a, { t: 'play', position: 20 });
  u.tick(BUFFER.REPORT_TTL_MS + 100);
  u.report(u.a);
  u.room.sweep();
  assert.equal(u.room.state.buffering, false);
  u.room.leave(u.a.id); u.room.leave(u.b.id);
  assert.equal(u.room.state.playing, false);
});

test('near the credits, available tail data is enough; native playback uses a smaller target', () => {
  const t = party();
  t.room.apply(t.a, { t: 'play', position: 118 });
  t.report(t.a, { ahead: 2 }); t.report(t.b, { ahead: 2 });
  assert.equal(t.room.state.buffering, false);
  const u = party();
  u.room.apply(u.a, { t: 'play', position: 20 });
  u.report(u.a, { ahead: 2, managed: false }); u.report(u.b, { ahead: 2, managed: false });
  assert.equal(u.room.state.buffering, false);
});

test('autoplay-gated viewers do not repeatedly pause people already watching', () => {
  const t = party(); t.start();
  t.report(t.b, { blocked: true, stalled: true, ahead: 0 });
  t.tick(2000); t.report(t.b, { blocked: true, stalled: true, ahead: 0 });
  assert.equal(t.room.state.buffering, false);
});

test('invalid readiness numbers are rejected without changing the room', () => {
  const t = party(); t.room.apply(t.a, { t: 'play', position: 20 });
  assert.equal(t.report(t.a, { ahead: Infinity }).ok, false);
  assert.equal(t.report(t.a, { position: -1 }).ok, false);
  assert.equal(t.room.state.buffering, true);
});
