import { expectedPosition } from '../shared/sync.js';

const RATE_VALUES = new Set([0.75, 1, 1.25, 1.5]);

/**
 * Server-authoritative playback state for one room.
 *
 * The room stores an anchor, never a live position: "at server time `anchor`,
 * the media was at `position`, advancing at `rate`". That single triple is what
 * every client reconstructs, which is why a paused server costs nothing and a
 * seek is one small message.
 *
 * This class holds no sockets. It reports what changed and the transport layer
 * decides who hears it, which keeps the state machine testable.
 */
export class Room {
  constructor({ id = 'main', maxViewers = 3, startDelayMs = 1200, seekDelayMs = 700, idleResetMs = 60_000, now = () => Date.now(), onEvent = () => {} } = {}) {
    this.id = id;
    this.maxViewers = maxViewers;
    this.startDelayMs = startDelayMs;
    this.seekDelayMs = seekDelayMs;
    this.now = now;
    this.onEvent = onEvent;
    this.idleResetMs = idleResetMs;
    this.emptySince = null;

    this.users = new Map();
    this.history = []; // chat + system notices, newest last
    this.locked = false;
    this.media = null; // { id, title, duration }

    this.state = {
      seq: 0,
      playing: false,
      position: 0,
      anchor: this.now(),
      rate: 1,
      updatedBy: null,
      mediaId: null,
    };
  }

  get full() {
    return this.users.size >= this.maxViewers;
  }

  /** Where the media should be right now, per the room's own clock. */
  expected(now = this.now()) {
    return expectedPosition(this.state, now);
  }

  host() {
    for (const u of this.users.values()) if (u.isHost) return u;
    return null;
  }

  snapshot() {
    return {
      state: { ...this.state },
      locked: this.locked,
      media: this.media,
      users: this.usersPayload(),
      chat: this.history.slice(-80),
      capacity: this.maxViewers,
      serverTime: this.now(),
    };
  }

  usersPayload() {
    return [...this.users.values()].map((u) => ({
      id: u.id,
      name: u.name,
      isHost: u.isHost,
      buffering: u.buffering,
      latency: u.latency,
    }));
  }

  join(user) {
    if (this.full) return { ok: false, error: 'full' };
    const isFirst = this.users.size === 0;
    const record = { ...user, isHost: isFirst, buffering: false, latency: null, joinedAt: this.now(), ready: false };
    this.users.set(record.id, record);
    this.emptySince = null;
    this.system(`${record.name} joined`);
    this.onEvent('users', this.usersPayload());
    return { ok: true, user: record };
  }

  leave(id) {
    const user = this.users.get(id);
    if (!user) return;
    this.users.delete(id);
    this.system(`${user.name} left`);
    if (user.isHost) {
      const next = [...this.users.values()][0];
      if (next) {
        next.isHost = true;
        this.system(`${next.name} is now host`);
      }
    }
    if (this.users.size === 0) {
      // Nobody is watching, so the timeline must not keep running: otherwise a
      // room left playing all evening greets the next person hours past the
      // credits. Freeze it where it was; the sweep rewinds it later.
      this.emptySince = this.now();
      if (this.state.playing) {
        this.#commit({ playing: false, position: this.expected(this.now()), anchor: this.now(), rate: 1 }, null);
      }
    }
    this.onEvent('users', this.usersPayload());
  }

  /**
   * The slice of room state worth keeping on disk. A process restart used to
   * lose the episode entirely: everyone's player cleared, and pressing play
   * answered "No media loaded".
   */
  persist(now = this.now()) {
    return {
      mediaId: this.state.mediaId || null,
      title: this.media?.title ?? null,
      duration: this.media?.duration ?? null,
      playing: Boolean(this.state.playing),
      position: this.expected(now),
      rate: this.state.rate,
      savedAt: now,
    };
  }

  /**
   * Put a saved episode back after a restart. It resumes *paused* at the last
   * position anyone saw - deliberately not "where it would have been by now":
   * nothing was playing while the process was down, so skipping ahead would
   * throw the room past dialogue nobody watched.
   */
  restore(saved) {
    if (!saved?.mediaId) return false;
    const duration = Number(saved.duration) || 0;
    let position = Math.max(0, Number(saved.position) || 0);
    if (duration > 0) position = Math.min(position, Math.max(0, duration - 2));
    this.media = { id: saved.mediaId, title: saved.title || 'Episode', duration };
    this.state = {
      ...this.state,
      seq: this.state.seq + 1,
      mediaId: saved.mediaId,
      playing: false,
      position,
      anchor: this.now(),
      rate: 1,
      updatedBy: null,
    };
    // Give a resumed room longer than the usual minute before the empty-room
    // sweeper rewinds it: people are still reopening their browsers after a
    // restart, and losing the place they just got back would be insulting.
    if (position > 0) this.idleResetMs = Math.max(this.idleResetMs, 10 * 60_000);
    return true;
  }

  /**
   * Called on a timer by the transport. An empty room is rewound to the start
   * after a grace period, so a brief reconnect keeps its place but a room left
   * overnight starts clean for the next person.
   */
  sweep(now = this.now()) {
    if (this.users.size > 0) {
      this.emptySince = null;
      return false;
    }
    if (this.emptySince == null) {
      this.emptySince = now;
      return false;
    }
    if (now - this.emptySince < this.idleResetMs) return false;
    if (!this.state.playing && this.state.position === 0) return false;
    this.#commit({ playing: false, position: 0, anchor: now, rate: 1 }, null);
    return true;
  }

  /**
   * The file behind the loaded episode disappeared (deleted, renamed, cache
   * cleared). Leaving the reference in place makes every joining client ask the
   * server for `/undefined`, so the room forgets it and says why.
   */
  forgetMedia() {
    if (!this.media && !this.state.mediaId) return false;
    this.media = null;
    this.#commit({ playing: false, position: 0, anchor: this.now(), rate: 1, mediaId: null }, null);
    this.system('That episode is no longer in the library');
    return true;
  }

  system(text) {
    const entry = { id: `s${this.now()}${Math.random().toString(16).slice(2, 6)}`, kind: 'system', text, at: this.now() };
    this.#pushChat(entry);
  }

  chat(user, text) {
    const clean = String(text ?? '').slice(0, 500).trim();
    if (!clean) return;
    this.#pushChat({
      id: `m${this.now()}${Math.random().toString(16).slice(2, 6)}`,
      kind: 'chat',
      from: user.name,
      fromId: user.id,
      text: clean,
      at: this.now(),
    });
  }

  #pushChat(entry) {
    this.history.push(entry);
    if (this.history.length > 120) this.history.splice(0, this.history.length - 120);
    this.onEvent('chat', entry);
  }

  #commit(changes, user) {
    this.state = { ...this.state, ...changes, seq: this.state.seq + 1, updatedBy: user ? user.name : null };
    this.onEvent('state', { ...this.state });
  }

  /** Returns { ok, error } — errors are shown to the client, not thrown. */
  apply(user, msg) {
    const now = this.now();
    // The transport passes its own connection object, which is *not* the record
    // held in this.users (joining stores a copy). Trusting the caller's object
    // meant isHost was always undefined here: the host could never lock the
    // room, and buffering/latency updates were written to a throwaway object.
    const actor = this.users.get(user?.id) ?? user;
    const guarded = this.locked && !actor?.isHost;
    const clampPos = (p) => {
      const value = Number(p);
      if (!Number.isFinite(value) || value < 0) return 0;
      const max = this.media?.duration || 0;
      return max ? Math.min(value, Math.max(0, max - 0.25)) : value;
    };

    switch (msg.t) {
      case 'play': {
        if (guarded) return { ok: false, error: 'Only the host can control playback right now' };
        if (!this.state.mediaId) return { ok: false, error: 'No media loaded' };
        const pos = clampPos(msg.position ?? this.expected(now));
        this.#commit({ playing: true, position: pos, anchor: now + this.startDelayMs, rate: this.state.rate || 1 }, actor);
        return { ok: true };
      }

      case 'pause': {
        if (guarded) return { ok: false, error: 'Only the host can control playback right now' };
        const pos = this.expected(now);
        this.#commit({ playing: false, position: pos, anchor: now, rate: 1 }, actor);
        return { ok: true };
      }

      case 'seek': {
        if (guarded) return { ok: false, error: 'Only the host can control playback right now' };
        const pos = clampPos(msg.position);
        const playing = Boolean(msg.resume ?? this.state.playing);
        this.#commit(
          { playing, position: pos, anchor: now + (playing ? this.seekDelayMs : 0), rate: playing ? this.state.rate || 1 : 1 },
          actor,
        );
        return { ok: true };
      }

      case 'rate': {
        if (guarded) return { ok: false, error: 'Only the host can control playback right now' };
        const rate = Number(msg.value);
        if (!RATE_VALUES.has(rate)) return { ok: false, error: 'Unsupported rate' };
        const pos = this.expected(now);
        this.#commit({ rate, position: pos, anchor: now }, actor);
        return { ok: true };
      }

      case 'select': {
        if (guarded) return { ok: false, error: 'Only the host can load media right now' };
        if (!msg.mediaId) return { ok: false, error: 'Missing mediaId' };
        this.media = { id: msg.mediaId, title: msg.title || 'Untitled', duration: Number(msg.duration) || 0 };
        this.#commit({ playing: false, position: 0, anchor: now, rate: 1, mediaId: msg.mediaId }, actor);
        this.system(`${actor?.name ?? 'someone'} loaded ${this.media.title}`);
        return { ok: true };
      }

      case 'lock': {
        if (!actor?.isHost) return { ok: false, error: 'Only the host can lock the room' };
        this.locked = Boolean(msg.value);
        this.system(this.locked ? 'Playback locked to the host' : 'Playback unlocked');
        this.onEvent('lock', { locked: this.locked });
        return { ok: true };
      }

      // The episode reached its last frame on some player. Stop the room at the
      // credits instead of letting the anchor run past the duration forever.
      case 'ended': {
        if (!this.state.playing) return { ok: true };
        const duration = this.media?.duration || this.state.position;
        this.#commit({ playing: false, position: duration, anchor: now, rate: 1 }, actor);
        return { ok: true };
      }

      case 'buffering': {
        if (actor) actor.buffering = Boolean(msg.value);
        this.onEvent('users', this.usersPayload());
        return { ok: true };
      }

      case 'latency': {
        if (actor) actor.latency = Number(msg.value) || null;
        this.onEvent('users', this.usersPayload());
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown message: ${msg.t}` };
    }
  }
}
