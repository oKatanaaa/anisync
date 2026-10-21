import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/rooms.js';

/** A room whose clock we drive by hand, so every assertion is deterministic. */
function makeRoom({ maxViewers = 3, startDelayMs = 1000, seekDelayMs = 500 } = {}) {
  let clock = 1_000_000;
  const events = [];
  const room = new Room({
    maxViewers,
    startDelayMs,
    seekDelayMs,
    now: () => clock,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return {
    room,
    events,
    tick: (ms) => {
      clock += ms;
      return clock;
    },
    now: () => clock,
    join: (id, name = id) => {
      const res = room.join({ id, name });
      assert.ok(res.ok, `join ${name} should succeed`);
      return res.user;
    },
    load: (duration = 90) => {
      const user = [...room.users.values()][0];
      assert.equal(room.apply(user, { t: 'select', mediaId: 'abc', title: 'Ep 1', duration }).ok, true);
      return user;
    },
  };
}

const types = (events, type) => events.filter((e) => e.type === type).map((e) => e.payload);

test('the first person in becomes host, the next one does not', () => {
  const t = makeRoom();
  const a = t.join('a', 'Aiko');
  const b = t.join('b', 'Bela');
  assert.equal(a.isHost, true);
  assert.equal(b.isHost, false);
  assert.equal(t.room.host().id, 'a');
});

test('an episode survives a restart, paused where it stopped', () => {
  const first = makeRoom();
  const user = first.join('a', 'Ana');
  first.room.apply(user, { t: 'select', mediaId: 'abc123', title: 'Episode 04', duration: 1440 });
  first.tick(1500); // the room holds playback briefly after a load, on purpose
  assert.deepEqual(first.room.apply(user, { t: 'play', playing: true }), { ok: true });
  first.tick(30_000);

  // What the process writes to disk before it goes away.
  const playing = first.room.expected();
  assert.ok(playing > 28, `expected the room to have advanced, got ${playing}s`);
  const saved = first.room.persist();
  assert.equal(saved.mediaId, 'abc123');
  assert.equal(saved.playing, true);
  assert.equal(saved.position, playing, 'the snapshot stores where playback had reached');

  // A fresh process puts it back.
  const second = new Room({ now: () => 2_000_000 });
  assert.equal(second.restore(saved), true);
  assert.equal(second.state.mediaId, 'abc123');
  assert.equal(second.state.playing, false, 'resumes paused: everyone was disconnected');
  assert.equal(second.state.position, saved.position, 'resumes at the same second');
  assert.equal(second.media.title, 'Episode 04');
});

test('a restore never runs past the end, and ignores an empty snapshot', () => {
  const room = new Room({ now: () => 5_000_000 });
  room.restore({ mediaId: 'abc123', title: 'Short', duration: 100, playing: true, position: 99, savedAt: 0 });
  assert.equal(room.state.position, 98, 'clamped to just before the end');
  assert.equal(new Room({}).restore(null), false);
  assert.equal(new Room({}).restore({ mediaId: null }), false);
});

test('a fourth person is turned away', () => {
  const t = makeRoom({ maxViewers: 3 });
  t.join('a');
  t.join('b');
  t.join('c');
  assert.equal(t.room.full, true);
  const res = t.room.join({ id: 'd', name: 'Dee' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'full');
  assert.equal(t.room.users.size, 3);
});

test('playing advances the expected position with the clock', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 10 });
  // The first second is the pre-roll, so 5 s of wall clock is 4 s of playback.
  t.tick(5000);
  assert.ok(Math.abs(t.room.expected() - 14) < 0.01, `expected ~14, got ${t.room.expected()}`);
});

test('the start delay gives every player time to buffer', () => {
  const t = makeRoom({ startDelayMs: 1000 });
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 5 });
  assert.equal(t.room.expected(), 5, 'position must not advance during the pre-roll');
  t.tick(1000);
  assert.ok(Math.abs(t.room.expected() - 5) < 0.01);
  t.tick(2000);
  assert.ok(Math.abs(t.room.expected() - 7) < 0.01);
});

test('pausing freezes everyone where they are', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 0 });
  t.tick(3000);
  t.room.apply(t.room.host(), { t: 'pause' });
  const at = t.room.expected();
  t.tick(60_000);
  assert.ok(Math.abs(t.room.expected() - at) < 0.01, 'a long pause must not drift');
  assert.equal(t.room.state.playing, false);
});

test('seeking while paused leaves the room paused', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'seek', position: 40, resume: false });
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.expected(), 40);
});

test('seeking while playing keeps playing from the new spot', () => {
  const t = makeRoom({ seekDelayMs: 500 });
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 0 });
  t.tick(2000);
  t.room.apply(t.room.host(), { t: 'seek', position: 60, resume: true });
  assert.equal(t.room.state.playing, true);
  t.tick(1500);
  assert.ok(Math.abs(t.room.expected() - 61) < 0.01, `expected ~61, got ${t.room.expected()}`);
});

test('positions are clamped to the media', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'seek', position: 5000, resume: false });
  assert.equal(t.room.state.position, 89.75);
  t.room.apply(t.room.host(), { t: 'seek', position: -20, resume: false });
  assert.equal(t.room.state.position, 0);
  t.room.apply(t.room.host(), { t: 'seek', position: 'nonsense', resume: false });
  assert.equal(t.room.state.position, 0);
});

test('an unsupported playback rate is refused', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  assert.equal(t.room.apply(t.room.host(), { t: 'rate', value: 3 }).ok, false);
  assert.equal(t.room.apply(t.room.host(), { t: 'rate', value: 1.25 }).ok, true);
});

test('locking the room blocks everyone but the host', () => {
  const t = makeRoom();
  const host = t.join('a', 'Aiko');
  const guest = t.join('b', 'Bela');
  t.load(90);
  assert.equal(t.room.apply(host, { t: 'lock', value: true }).ok, true);
  assert.equal(t.room.locked, true);

  for (const msg of [
    { t: 'play', position: 0 },
    { t: 'pause' },
    { t: 'seek', position: 30 },
    { t: 'select', mediaId: 'zzz', title: 'Other' },
  ]) {
    const res = t.room.apply(guest, msg);
    assert.equal(res.ok, false, `${msg.t} should be refused`);
    assert.match(res.error, /host/i);
  }
  assert.equal(t.room.apply(host, { t: 'play', position: 0 }).ok, true);
});

test('the transport may hand over its own user object, not the stored record', () => {
  // index.js builds a connection object and passes *that* to apply(). Joining
  // stores a copy, so trusting the caller's object silently disables every
  // isHost check — this is the bug that made the lock button do nothing.
  const t = makeRoom();
  t.join('a', 'Aiko');
  t.load(90);
  const transportUser = { id: 'a', name: 'Aiko' }; // no isHost property at all

  assert.equal(t.room.apply(transportUser, { t: 'lock', value: true }).ok, true);
  assert.equal(t.room.locked, true);

  // And the same for the read-only telemetry the roster depends on.
  t.room.apply(transportUser, { t: 'latency', value: 37 });
  t.room.apply(transportUser, { t: 'buffering', value: true });
  const me = t.room.usersPayload().find((u) => u.id === 'a');
  assert.equal(me.latency, 37);
  assert.equal(me.buffering, true);
});

test('a promoted user is recognised even through a transport object', () => {
  const t = makeRoom();
  t.join('a', 'Aiko');
  t.join('b', 'Bela');
  t.load(90);
  const bela = { id: 'b', name: 'Bela' };
  assert.equal(t.room.apply(bela, { t: 'lock', value: true }).ok, false, 'not host yet');
  t.room.leave('a');
  assert.equal(t.room.apply(bela, { t: 'lock', value: true }).ok, true, 'now host');
});

test('only the host can lock or unlock', () => {
  const t = makeRoom();
  t.join('a', 'Aiko');
  const guest = t.join('b', 'Bela');
  const res = t.room.apply(guest, { t: 'lock', value: true });
  assert.equal(res.ok, false);
  assert.equal(t.room.locked, false);
});

test('when the host leaves the next person takes over', () => {
  const t = makeRoom();
  t.join('a', 'Aiko');
  t.join('b', 'Bela');
  t.room.leave('a');
  assert.equal(t.room.host().id, 'b');
  assert.ok(types(t.events, 'chat').some((c) => /Bela is now host/.test(c.text)));
});

test('the last person leaving does not hand the room to nobody', () => {
  const t = makeRoom();
  t.join('a');
  t.room.leave('a');
  assert.equal(t.room.host(), null);
  assert.equal(t.room.users.size, 0);
});

test('an abandoned room freezes instead of playing to itself', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 0 });
  t.tick(30_000);

  const where = t.room.expected();
  t.room.leave('a');
  assert.equal(t.room.state.playing, false, 'nobody is watching, so it must stop');
  assert.ok(Math.abs(t.room.state.position - where) < 0.01, 'it stops where the viewer was');

  // It must not creep forward while empty.
  t.tick(60_000);
  assert.ok(Math.abs(t.room.expected() - where) < 0.01, 'an empty room does not advance');

  t.join('b', 'Bela');
  assert.equal(t.room.state.playing, false, 'rejoining never starts playback by itself');
  assert.ok(Math.abs(t.room.expected() - where) < 0.01, 'a quick reconnect keeps its place');
});

test('a long-empty room is rewound for the next person', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'seek', position: 40, resume: false });
  t.room.leave('a');

  // Inside the grace period nothing is rewound.
  t.tick(1000);
  t.room.sweep(t.now());
  assert.equal(t.room.state.position, 40);

  // After it, the next person starts at the beginning with the episode still loaded.
  t.tick(120_000);
  assert.equal(t.room.sweep(t.now()), true);
  assert.equal(t.room.state.position, 0);
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.state.mediaId, 'abc');

  t.join('b', 'Bela');
  assert.ok(t.room.expected() < 1);
});

test('winding an episode off the end pauses the room', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 0 });
  t.tick(89_000);
  const res = t.room.apply(t.room.host(), { t: 'ended' });
  assert.equal(res.ok, true);
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.state.position, 90);
  t.tick(10_000);
  assert.equal(t.room.state.position, 90, 'the room must not keep counting past the credits');
});

test('a late ended message cannot rewind a replay', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'ended' });
  t.room.apply(t.room.host(), { t: 'play', position: 0 });
  t.room.apply(t.room.host(), { t: 'ended' });
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.state.position, 90);
});

test('ended is ignored while the room is already paused', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  const before = t.room.state.seq;
  t.room.apply(t.room.host(), { t: 'ended' });
  assert.equal(t.room.state.seq, before, 'no state churn for a no-op');
});

test('the room forgets an episode whose file disappeared', () => {
  const t = makeRoom();
  t.join('a');
  t.load(90);
  t.room.apply(t.room.host(), { t: 'play', position: 0 });

  assert.equal(t.room.forgetMedia(), true);
  assert.equal(t.room.state.mediaId, null);
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.state.position, 0);
  assert.equal(t.room.media, null);
  assert.ok(t.room.history.some((h) => /no longer in the library/.test(h.text)));

  // Forgetting twice is a no-op, so a rescan cannot spam the chat.
  assert.equal(t.room.forgetMedia(), false);
});

test('chat is trimmed, capped and ignores empty messages', () => {
  const t = makeRoom();
  const a = t.join('a', 'Aiko');
  const before = t.room.history.length;
  t.room.chat(a, '   ');
  assert.equal(t.room.history.length, before);

  t.room.chat(a, `  hello ${'x'.repeat(900)}  `);
  const entry = t.room.history.at(-1);
  assert.ok(entry.text.length <= 500, `capped at 500, got ${entry.text.length}`);
  assert.equal(entry.text.startsWith('hello'), true);
  assert.equal(entry.text.endsWith('x'), true);
  assert.equal(entry.from, 'Aiko');
});

test('chat history does not grow without bound', () => {
  const t = makeRoom();
  const a = t.join('a');
  for (let i = 0; i < 300; i++) t.room.chat(a, `message ${i}`);
  assert.ok(t.room.history.length <= 120, `history is ${t.room.history.length}`);
  assert.match(t.room.history.at(-1).text, /message 299/);
});

test('buffering and latency show up on the roster', () => {
  const t = makeRoom();
  const a = t.join('a', 'Aiko');
  t.room.apply(a, { t: 'buffering', value: true });
  t.room.apply(a, { t: 'latency', value: 42 });
  const me = t.room.usersPayload().find((u) => u.id === 'a');
  assert.equal(me.buffering, true);
  assert.equal(me.latency, 42);
});

test('loading an episode resets the timeline and says so', () => {
  const t = makeRoom();
  const a = t.join('a', 'Aiko');
  t.load(90);
  t.room.apply(a, { t: 'play', position: 0 });
  t.tick(5000);
  t.room.apply(a, { t: 'select', mediaId: 'def', title: 'Ep 2', duration: 120 });
  assert.equal(t.room.state.position, 0);
  assert.equal(t.room.state.playing, false);
  assert.equal(t.room.media.duration, 120);
  assert.ok(t.room.history.some((h) => /Aiko loaded Ep 2/.test(h.text)));
});

test('every change bumps the sequence number', () => {
  const t = makeRoom();
  const a = t.join('a');
  t.load(90);
  const seq = t.room.state.seq;
  t.room.apply(a, { t: 'play', position: 0 });
  t.room.apply(a, { t: 'pause' });
  t.room.apply(a, { t: 'seek', position: 10 });
  assert.equal(t.room.state.seq, seq + 3);
});

test('unknown messages are refused without breaking the room', () => {
  const t = makeRoom();
  const a = t.join('a');
  const res = t.room.apply(a, { t: 'rm -rf' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown/);
  assert.equal(t.room.users.size, 1);
});

test('play is refused when nothing is loaded', () => {
  const t = makeRoom();
  const a = t.join('a');
  const res = t.room.apply(a, { t: 'play', position: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /No media/);
});
