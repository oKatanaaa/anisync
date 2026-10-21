import {
  clockSample,
  pickOffset,
  expectedPosition,
  inPreRoll,
  nextCorrection,
  describeDrift,
} from '/shared/sync.js';

const $ = (id) => document.getElementById(id);

const el = {
  video: $('video'),
  altAudio: $('altAudio'),
  trackMenu: $('trackMenu'),
  subGroup: $('subGroup'),
  subList: $('subList'),
  audioGroup: $('audioGroup'),
  audioList: $('audioList'),
  stage: $('stage'),
  controls: $('controls'),
  placeholder: $('placeholder'),
  placeholderTitle: $('placeholderTitle'),
  placeholderText: $('placeholderText'),
  placeholderBtn: $('placeholderBtn'),
  gate: $('gate'),
  stageTag: $('stageTag'),
  seek: $('seek'),
  time: $('time'),
  playBtn: $('playBtn'),
  muteBtn: $('muteBtn'),
  volume: $('volume'),
  subsBtn: $('subsBtn'),
  fsBtn: $('fsBtn'),
  syncBadge: $('syncBadge'),
  roomChip: $('roomChip'),
  avatars: $('avatars'),
  nowTitle: $('nowTitle'),
  nowSub: $('nowSub'),
  lockBtn: $('lockBtn'),
  messages: $('messages'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  people: $('people'),
  library: $('library'),
  libraryHint: $('libraryHint'),
  rescanBtn: $('rescanBtn'),
  uploadInput: $('uploadInput'),
  uploadBar: $('uploadBar'),
  join: $('join'),
  joinForm: $('joinForm'),
  joinError: $('joinError'),
  nameInput: $('nameInput'),
  toasts: $('toasts'),
};

const state = {
  ws: null,
  me: null,
  room: null, // {state, locked, media, users, capacity}
  media: null,
  sourceUrl: null,
  mediaList: [],
  tracks: { sub: 'styled', audio: 0 },
  altActive: false,
  userMuted: false,
  cleanPending: null,
  users: [],
  offset: 0,
  samples: [],
  nudging: false,
  dragging: false,
  settleUntil: 0,
  gateVisible: false,
  loadStartedAt: 0,
  lastReloadAt: 0,
  name: localStorage.getItem('anisync:name') || '',
  retries: 0,
  pingTimer: null,
  libRefreshAt: 0,
  confirmDelete: null,
};

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function toast(text, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, 3200);
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function hueFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function initials(name) {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

function setBadge(label, tone = '') {
  const span = el.syncBadge.querySelector('span');
  if (span.textContent !== label) span.textContent = label;
  el.syncBadge.className = `badge ${tone}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Identifies this tab across reloads, so a refresh never looks like a new seat. */
function sessionId() {
  let id = sessionStorage.getItem('anisync:session');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('anisync:session', id);
  }
  return id;
}

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?name=${encodeURIComponent(name)}&s=${sessionId()}`;
  setBadge('connecting…');

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    // A successful open clears the backoff so a long session cannot exhaust it.
    state.retries = 0;
    setBadge('syncing clock…');
    startPings();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };

  ws.onclose = (event) => {
    stopPings();
    // Another tab took this seat over (same session id): don't fight it.
    if (event.code === 4002) {
      setBadge('open in another tab', 'ok');
      return;
    }
    if (event.code === 4001) {
      showJoin('The room is full — three seats only.');
      return;
    }
    // Keep trying forever: a watch party lasts hours and Wi-Fi blips. The delay
    // is capped, and jittered so three clients do not stampede a restarting
    // server in lockstep.
    state.retries += 1;
    const base = Math.min(15_000, 600 * 2 ** Math.min(state.retries, 5));
    const delay = base * (0.75 + Math.random() * 0.5);
    setBadge(state.retries > 2 ? 'disconnected · retrying' : 'reconnecting…', state.retries > 2 ? 'bad' : 'ok');
    setTimeout(() => connect(name), delay);
  };
}

let offlineToastAt = 0;

/**
 * Quiet messages are telemetry (clock pings, latency, buffering); a user's
 * click is not quiet, because silently dropping it looks like a broken button.
 */
function send(msg, { quiet = false } = {}) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Keep a short trail so sync disputes can be settled with evidence.
    (window.__sent ||= []).push({ at: Math.round(performance.now()), ...msg });
    if (window.__sent.length > 200) window.__sent.shift();
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  if (!quiet && performance.now() - offlineToastAt > 4000) {
    offlineToastAt = performance.now();
    toast('Not connected — reconnecting…', 'error');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

function startPings() {
  stopPings();
  const ping = () => {
    send({ t: 'ping', id: Math.random().toString(36).slice(2), cts: performance.now() }, { quiet: true });
  };
  ping();
  state.pingTimer = setInterval(ping, 3000);
}

function stopPings() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

function onPong(msg) {
  const t3 = performance.now();
  const sample = clockSample(msg.cts, t3, msg.sts);
  if (sample.rtt > 4000) return; // a stalled tab is not a usable sample
  state.samples.push(sample);
  if (state.samples.length > 30) state.samples.shift();
  state.offset = pickOffset(state.samples, 9);
  send({ t: 'latency', value: Math.round(sample.rtt) }, { quiet: true });
  // The drift badge is normally driven by the playback loop, which does not run
  // until something is loaded — so report the clock on its own until then.
  if (!state.media) setBadge(`connected · ${Math.round(sample.rtt)}ms`, 'good');
}

const serverNow = () => performance.now() + state.offset;

/**
 * Diagnostic ring buffer. If two people ever swear they are out of sync, this
 * is the evidence: every sample is stamped with the *server* clock, so two
 * machines' logs can be compared directly.
 */
const debugSamples = [];

function recordSample(roomState, position, expected) {
  debugSamples.push({
    t: Math.round(serverNow()),
    pos: Number(position.toFixed(3)),
    exp: Number(expected.toFixed(3)),
    playing: Boolean(roomState.playing),
    ready: el.video.readyState,
  });
  if (debugSamples.length > 900) debugSamples.shift();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handle(msg) {
  switch (msg.t) {
    case 'pong':
      return onPong(msg);

    case 'welcome': {
      state.me = msg.you;
      state.room = {
        state: msg.state,
        locked: msg.locked,
        media: msg.media,
        users: msg.users,
        capacity: msg.capacity,
      };
      state.users = msg.users;
      el.join.classList.add('hidden');
      msg.chat?.forEach(appendMessage);
      renderPeople();
      renderAvatars();
      updateLockButton();
      updateMetaUI();
      refreshLibrary();
      if (msg.media) loadMedia(msg.media);
      if (msg.state?.mediaId && !msg.media) refreshLibrary();
      if (msg.state?.playing) {
        // Autoplay is likely blocked until the user clicks something.
        setTimeout(() => requestPlay(), 60);
      }
      return;
    }

    case 'state': {
      if (!state.room) return;
      const previous = state.room.state;
      state.room.state = msg;
      (window.__states ||= []).push({ at: Math.round(performance.now()), seq: msg.seq, playing: msg.playing, position: msg.position });
      if (!msg.mediaId && state.media) clearMedia();
      if (msg.mediaId && msg.mediaId !== state.media?.id) {
        const known = state.mediaList.find((m) => m.id === msg.mediaId);
        if (known) loadMedia(known);
        else refreshLibrary();
      }
      if (previous && previous.playing !== msg.playing) {
        el.stage.classList.toggle('paused', !msg.playing);
        setPlayIcon(msg.playing);
      }
      return;
    }

    case 'users': {
      state.users = msg.users;
      state.room && (state.room.users = msg.users);
      // Promotion happens server-side when the host leaves; without this the
      // new host keeps a disabled Lock button until they reload.
      const mine = state.me && msg.users.find((u) => u.id === state.me.id);
      if (mine && state.me.isHost !== mine.isHost) {
        state.me.isHost = mine.isHost;
        updateLockButton();
      }
      renderPeople();
      renderAvatars();
      return;
    }

    case 'chat':
      appendMessage(msg.entry);
      return;

    case 'media':
      if (msg.media) {
        upsertMedia(msg.media);
        loadMedia(msg.media);
      }
      return;

    case 'progress': {
      const card = el.library.querySelector(`[data-media="${msg.id}"]`);
      if (card) {
        const bar = card.querySelector('.progress > i');
        if (bar) bar.style.width = `${msg.progress}%`;
        const label = card.querySelector('.meta');
        if (label) label.textContent = `${msg.stage || 'working'} · ${msg.progress}%`;
      }
      // The subtitle-free copy is being built for the episode on screen: show
      // the progress inside the track menu, where the viewer is looking.
      if (state.cleanPending?.id === msg.id && msg.stage === 'clean') {
        state.cleanPending.progress = msg.progress;
        renderTrackMenu();
      }
      // The episode we just uploaded is being converted: keep the upload row
      // honest instead of leaving it stuck at 100%.
      for (const job of UPLOAD.active) {
        if (job.mediaId === msg.id && job.phase === 'preparing') {
          job.encode = msg.progress;
          job.startedEncoding = true;
          scheduleUploadRender();
        }
      }
      return;
    }

    case 'library': {
      // refreshLibrary is async: reading state.mediaList before it resolves
      // would compare against the previous library and miss a new rendition.
      refreshLibrary().then(() => {
        // An upload finishes twice: bytes, then encoding. Only the library
        // knows about the second one.
        for (const job of UPLOAD.active) {
          if (!job.mediaId || job.phase !== 'preparing' || job.finishing) continue;
          const uploaded = state.mediaList.find((m) => m.id === job.mediaId);
          if (uploaded?.prepared) {
            job.finishing = true;
            job.phase = 'done';
            job.encode = 100;
            job.startedEncoding = true;
            renderUpload();
            setTimeout(() => finishJob(job), 1500);
          } else if (uploaded?.error) {
            job.finishing = true;
            job.phase = 'failed';
            job.error = uploaded.error;
            renderUpload();
            setTimeout(() => finishJob(job), 5000);
          }
        }
        // Keep the on-screen episode in step with the library: a new rendition
        // (subtitle-free copy, rebuilt cache) changes what we should be playing.
        const fresh = state.media ? state.mediaList.find((m) => m.id === state.media.id) : null;
        if (fresh) {
          state.media = { ...state.media, ...fresh };
          const waiting = state.cleanPending?.id === fresh.id;
          if (waiting && fresh.cleanUrl) {
            state.cleanPending = null;
            applyTracks();
            setBadge('ready', 'ok');
          } else if (waiting) {
            renderTrackMenu();
          }
        }
        // The rendition may have just been (re)built — a wiped cache, or an
        // encode that finished while we were pointed at a missing file. Retry
        // instead of leaving the player dead until a manual reload.
        if (state.media?.prepared && el.video.error) {
          state.loadRetries = 0;
          retryPlayback();
        }
      });
      return;
    }

    case 'lock':
      state.room && (state.room.locked = msg.locked);
      updateLockButton();
      return;

    case 'error':
      toast(msg.message, 'error');
      return;

    case 'notice':
      toast(msg.text, msg.level === 'error' ? 'error' : '');
      return;

    case 'rejected':
      showJoin(msg.message || 'Room is full.');
      return;

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Playback control
// ---------------------------------------------------------------------------

function setPlayIcon(playing) {
  el.playBtn.querySelector('.i-play').classList.toggle('hidden', playing);
  el.playBtn.querySelector('.i-pause').classList.toggle('hidden', !playing);
}

/**
 * Autoplay needs a single, well-behaved attempt: calling play() again while a
 * previous promise is pending aborts it, and a burst of AbortErrors used to
 * leave the room stuck behind the click-to-start overlay forever.
 */
let playPending = false;

function requestPlay() {
  if (playPending || !el.video.src) return;
  playPending = true;
  const attempt = el.video.play();
  if (!attempt || typeof attempt.then !== 'function') {
    playPending = false;
    return;
  }
  attempt
    .then(() => {
      playPending = false;
      showGate(false);
    })
    .catch((err) => {
      playPending = false;
      // Only a genuine policy block needs a gesture; anything else (a pending
      // seek, a source swap) is transient and retried on the next tick.
      if (err && err.name === 'NotAllowedError') showGate(true);
    });
}

function showGate(visible) {
  state.gateVisible = visible;
  el.gate.classList.toggle('hidden', !visible);
}

function togglePlay() {
  if (!state.room || !state.media) return;
  const playing = state.room.state?.playing;
  if (playing) return send({ t: 'pause' });

  const duration = el.video.duration || state.media.duration || 0;
  const atEnd = el.video.ended || (duration > 0 && duration - el.video.currentTime < 0.6);
  // Pressing play after the episode finished is a request to watch it again,
  // not to resume the last half-second.
  send({ t: 'play', position: atEnd ? 0 : el.video.currentTime });
}

/**
 * Seeking must preserve the room's play/pause state: scrubbing while paused
 * should leave everyone paused, not quietly start playback under them.
 */
function seekTo(seconds, { resume = null } = {}) {
  const duration = el.video.duration || state.media?.duration || 0;
  const target = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.25)));
  const shouldResume = resume ?? Boolean(state.room?.state?.playing);
  state.settleUntil = performance.now() + 700;
  send({ t: 'seek', position: target, resume: shouldResume });
}

/**
 * A range request that dies mid-flight (flaky Wi-Fi, a laptop waking up) can
 * leave the video at readyState 0 with no error event at all. Rather than
 * staring at a black rectangle forever, re-issue load() a couple of times.
 */
function recoverStalledLoad(now) {
  if (!state.media || !el.video.src || el.video.readyState > 0 || el.video.error) return;
  if (!state.loadStartedAt || now - state.loadStartedAt < 6000) return;
  if (now - state.lastReloadAt < 8000) return;
  state.lastReloadAt = now;
  state.loadStartedAt = now;
  console.warn('media load stalled, retrying');
  el.video.load();
  if (state.room?.state?.playing) requestPlay();
}

/**
 * The heartbeat of the whole product: compare where we are with where the room
 * says we should be, and converge. Runs four times a second; a well-synced
 * player is a no-op here.
 */
function tick() {
  const roomState = state.room?.state;
  if (!roomState || !state.media || !el.video.src) return updateTimeUI();
  recoverStalledLoad(performance.now());
  if (el.video.readyState < 1) return updateTimeUI();

  const now = serverNow();
  const position = el.video.currentTime;
  syncAltAudio(roomState, position);

  if (inPreRoll(roomState, now)) {
    if (!el.video.paused) el.video.pause();
    if (Math.abs(position - roomState.position) > 0.15) el.video.currentTime = roomState.position;
    setBadge('starting…', 'ok');
    updateTimeUI();
    return;
  }

  if (!roomState.playing) {
    if (!el.video.paused) el.video.pause();
    const drift = position - roomState.position;
    if (Math.abs(drift) > 0.2 && !el.video.seeking) el.video.currentTime = roomState.position;
    if (state.nudging) {
      state.nudging = false;
      setRate(1);
    }
    setBadge(`paused · ${state.users.length}/${state.room.capacity} in room`);
    updateTimeUI();
    return;
  }

  if (el.video.paused && !state.gateVisible) requestPlay();

  // Give a fresh seek a moment to land before judging it.
  if (performance.now() < state.settleUntil || el.video.seeking) return updateTimeUI();

  const duration = el.video.duration || state.media?.duration || 0;
  // Past the credits the anchor keeps advancing; chasing it makes every player
  // hard-seek into the void and snap back to 0:00. Hold at the last frame.
  const expected = duration ? Math.min(expectedPosition(roomState, now), duration) : expectedPosition(roomState, now);
  const correction = nextCorrection({ currentTime: position, expected, nudging: state.nudging });

  switch (correction.action) {
    case 'seek':
      el.video.currentTime = correction.seekTo;
      state.nudging = false;
      setRate(1);
      break;
    case 'nudge':
      state.nudging = true;
      setRate(correction.rate);
      break;
    case 'restore':
      state.nudging = false;
      setRate(1);
      break;
    default:
      break;
  }

  recordSample(roomState, position, expected);
  const d = describeDrift(correction.drift);
  const rtt = Math.round(state.samples.at(-1)?.rtt ?? 0);
  setBadge(`${d.label} · ${rtt}ms`, state.nudging ? 'ok' : d.tone);
  updateTimeUI();
}

function setRate(rate) {
  if (Math.abs(el.video.playbackRate - rate) < 0.001) return;
  el.video.preservesPitch = true;
  el.video.mozPreservesPitch = true;
  el.video.webkitPreservesPitch = true;
  el.video.playbackRate = rate;
}

function updateTimeUI() {
  const duration = el.video.duration || state.media?.duration || 0;
  const current = el.video.currentTime || 0;
  if (!state.dragging) {
    el.seek.max = duration || 1;
    el.seek.value = Math.min(current, duration || 1);
    const pct = duration ? (current / duration) * 100 : 0;
    el.seek.style.setProperty('--progress', `${pct}%`);
    el.time.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
  }
}

// ---------------------------------------------------------------------------
// Media + subtitles
// ---------------------------------------------------------------------------

function withRetryParam(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set('r', String(Date.now()));
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** Re-attach the current episode after a failed load, a few times at most. */
function retryPlayback() {
  if (!state.media) return;
  state.loadRetries = (state.loadRetries || 0) + 1;
  if (state.loadRetries > 6) {
    toast('That episode could not be rebuilt — check the server log.', 'error');
    return;
  }
  setBadge('rebuilding episode…', 'ok');
  setTimeout(() => {
    if (!state.media) return;
    loadMedia(state.media, { force: true });
    if (state.room?.state?.playing) requestPlay();
  }, Math.min(5000, 1500 * state.loadRetries));
}

/**
 * The room's episode vanished from the library (deleted file, cleared cache).
 * Put the stage back to a clean empty state instead of leaving a dead URL in
 * the player and a generic playback error on screen.
 */
function clearMedia() {
  state.media = null;
  state.sourceUrl = null;
  state.cleanPending = null;
  state.nudging = false;
  state.altActive = false;
  el.altAudio.pause();
  el.altAudio.removeAttribute('src');
  detachTextTracks();
  closeTrackMenu();
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  el.stage.classList.add('empty');
  el.stageTag.classList.add('hidden');
  el.placeholder.classList.remove('hidden');
  el.placeholderTitle.textContent = 'Nothing loaded yet';
  el.placeholderText.textContent =
    'Open the library and pick an episode. Everything gets prepared locally, then everyone watches the same timeline.';
  el.nowTitle.textContent = 'No episode loaded';
  el.nowSub.textContent = '—';
  el.subsBtn.classList.add('hidden');
  el.subsBtn.classList.remove('on');
  updateTimeUI();
}

function loadMedia(media, { force = false } = {}) {
  if (!media || !media.playbackUrl) return;
  if (!force && state.media?.id === media.id && el.video.src) {
    state.media = media;
    updateMetaUI();
    renderTrackMenu();
    return;
  }

  state.media = media;
  state.nudging = false;
  state.cleanPending = null;
  state.tracks = defaultTracks(media);
  setRate(1);

  el.placeholder.classList.add('hidden');
  el.stage.classList.remove('empty');
  el.stageTag.textContent = media.title;
  el.stageTag.classList.remove('hidden');
  updateMetaUI();

  // One entry point decides which rendition and which tracks to use.
  applyTracks({ keepPosition: false, force });
  state.loadStartedAt = performance.now();
  state.lastReloadAt = 0;
}

// ---------------------------------------------------------------------------
// Audio and subtitle tracks
//
// These are per viewer, never room-wide: one person may watch the dub with
// Spanish subs while the others keep the original audio. The choice is
// remembered per episode (and as a default for the next one).
//
// Burned-in subtitles are the default because they keep ASS typesetting, but
// they cannot be switched off — so asking for "off" or another track switches to
// a subtitle-free rendition that the server builds once, on demand.
// ---------------------------------------------------------------------------

const TRACK_PREF_KEY = 'anisync:tracks';

function readTrackPrefs() {
  try {
    return JSON.parse(localStorage.getItem(TRACK_PREF_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveTrackPref(mediaId, patch) {
  const prefs = readTrackPrefs();
  prefs[mediaId] = { ...(prefs[mediaId] || {}), ...patch };
  prefs.last = { ...(prefs.last || {}), ...patch };
  try {
    localStorage.setItem(TRACK_PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

const textSubs = (media) => (media?.subs || []).filter((s) => !s.bitmap && s.vtt);

function defaultTracks(media) {
  const prefs = readTrackPrefs();
  const saved = prefs[media.id] || prefs.last || {};
  const subs = textSubs(media);

  let sub = saved.sub;
  if (sub === undefined) sub = media.bakedSubs ? 'styled' : subs.length ? String(subs[0].index) : 'off';
  sub = String(sub);
  if (sub !== 'styled' && sub !== 'off' && !subs.some((s) => String(s.index) === sub)) {
    sub = media.bakedSubs ? 'styled' : 'off';
  }

  const audioTracks = media.audioTracks || [];
  let audio = Number(saved.audio);
  if (!audioTracks.some((t) => t.index === audio)) audio = 0;

  return { sub, audio };
}

/** Which subtitle entries the menu offers, and in what order. */
function subtitleOptions(media) {
  if (!media) return [];
  const subs = textSubs(media);
  const options = [];
  if (media.bakedSubs && subs.length) {
    options.push({ value: 'styled', label: subs[0].label || 'Subtitles', note: 'styled' });
    options.push({ value: 'off', label: 'Off' });
    for (const s of subs.slice(1)) options.push({ value: String(s.index), label: s.label, note: s.external ? 'external' : '' });
    return options;
  }
  for (const s of subs) options.push({ value: String(s.index), label: s.label, note: s.external ? 'external' : '' });
  if (subs.length) options.push({ value: 'off', label: 'Off' });
  return options;
}

function audioOptions(media) {
  const tracks = media?.audioTracks || [];
  if (tracks.length < 2) return [];
  return tracks.map((t) => ({
    value: t.index,
    label: t.label,
    note: t.muxed ? '' : t.external ? 'external' : '',
  }));
}

/** Apply the current subtitle + audio choice to the player. */
function applyTracks({ keepPosition = true, force = false } = {}) {
  const media = state.media;
  if (!media) return;

  const subs = textSubs(media);
  const choice = state.tracks.sub;
  const wanted = choice === 'off' || choice === 'styled' ? null : subs.find((s) => String(s.index) === choice) || null;

  let url = media.playbackUrl;
  if (choice !== 'styled') {
    if (media.cleanUrl) url = media.cleanUrl;
    // No subtitle-free copy yet: keep showing the burned-in picture while the
    // server builds one, rather than flashing a black frame at the viewer.
    else requestClean(media);
  }

  setSource(url, wanted, { keepPosition, force });
  applyAudio();
  renderTrackMenu();
  updateMetaUI();
}

/**
 * Point the <video> at a rendition, keeping the position and play state. `track`
 * is a soft subtitle track to show, or null for none/burned-in.
 */
function setSource(url, track, { keepPosition = true, force = false } = {}) {
  const media = state.media;
  if (!media || !url) return;

  // A forced load must reload even when the URL is unchanged: that is exactly
  // the "retry the same episode after a rebuild" case.
  if (!force && state.sourceUrl === url && el.video.src) {
    showTextTrack(media, track);
    return;
  }

  const at = keepPosition ? el.video.currentTime || 0 : 0;
  const wasPlaying = !el.video.paused && !el.video.ended;

  state.sourceUrl = url;
  el.video.pause();
  // A forced reload gets a fresh URL: Chrome is happy to reuse the failed
  // response for the same URL, which would make the retry pointless.
  el.video.src = force ? withRetryParam(url) : url;
  el.video.poster = media.poster || '';
  el.video.load();
  showTextTrack(media, track);

  el.video.addEventListener(
    'loadedmetadata',
    () => {
      if (keepPosition && at > 0.5) el.video.currentTime = at;
      if (wasPlaying || state.room?.state?.playing) requestPlay();
    },
    { once: true },
  );
}

function detachTextTracks() {
  for (const node of [...el.video.querySelectorAll('track')]) node.remove();
}

/** Soft subtitles: no typesetting, but switchable and switchable-off. */
function showTextTrack(media, track) {
  detachTextTracks();
  if (!track || !track.vtt) return;
  const node = document.createElement('track');
  node.kind = 'subtitles';
  node.label = track.label || 'Subtitles';
  node.srclang = track.lang || 'und';
  node.src = `/media/${media.id}/subs/${track.vtt}`;
  node.default = true;
  el.video.appendChild(node);
  const enable = () => {
    const native = el.video.textTracks?.[0];
    if (native) native.mode = 'showing';
  };
  node.addEventListener('load', enable);
  setTimeout(enable, 200);
}

/** Alternate audio plays from a second element while the video is muted. */
function applyAudio() {
  const media = state.media;
  if (!media) return;
  const tracks = media.audioTracks || [];
  const chosen = tracks.find((t) => t.index === state.tracks.audio) || tracks[0];

  if (!chosen || chosen.muxed || !chosen.url) {
    el.altAudio.pause();
    el.altAudio.removeAttribute('src');
    state.altActive = false;
    el.video.muted = Boolean(state.userMuted) || el.video.volume === 0;
    return;
  }

  state.altActive = true;
  if (el.altAudio.src !== new URL(chosen.url, location.origin).href) {
    el.altAudio.src = chosen.url;
    el.altAudio.currentTime = el.video.currentTime || 0;
  }
  el.altAudio.volume = el.video.volume;
  el.video.muted = true;
  if (state.room?.state?.playing) el.altAudio.play().catch(() => {});
}

function syncAltAudio(roomState, position) {
  if (!state.altActive || !el.altAudio.src) return;
  const alt = el.altAudio;
  if (roomState.playing) {
    if (alt.paused && !el.video.paused) alt.play().catch(() => {});
    if (Math.abs(alt.currentTime - position) > 0.15) alt.currentTime = position;
    if (Math.abs(alt.playbackRate - el.video.playbackRate) > 0.001) alt.playbackRate = el.video.playbackRate;
  } else if (!alt.paused) {
    alt.pause();
  }
}

/** Ask the server for the subtitle-free rendition; it is cached afterwards. */
function requestClean(media) {
  if (state.cleanPending?.id === media.id) return;
  state.cleanPending = { id: media.id, progress: 0 };
  send({ t: 'variant', id: media.id, variant: 'clean' });
  setBadge('building subtitle-free copy…', 'ok');
  renderTrackMenu();
}

function chooseSubtitle(value) {
  const media = state.media;
  if (!media) return;
  state.tracks.sub = String(value);
  saveTrackPref(media.id, { sub: state.tracks.sub });
  applyTracks();
  closeTrackMenu();
}

function chooseAudio(index) {
  const media = state.media;
  if (!media) return;
  state.tracks.audio = Number(index);
  saveTrackPref(media.id, { audio: state.tracks.audio });
  applyTracks();
  closeTrackMenu();
}

function trackItem({ label, note, active, onClick, disabled }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `track-item${active ? ' active' : ''}`;
  button.disabled = Boolean(disabled);

  button.setAttribute('aria-pressed', String(Boolean(active)));

  const tick = document.createElement('span');
  tick.className = 'tick';
  tick.setAttribute('aria-hidden', 'true');
  tick.textContent = '✓';

  const name = document.createElement('span');
  name.className = 'track-name';
  name.textContent = label;

  button.append(tick, name);

  if (note) {
    const hint = document.createElement('span');
    hint.className = 'track-note';
    hint.textContent = note;
    button.append(hint);
  }

  button.addEventListener('click', onClick);
  return button;
}

function renderTrackMenu() {
  const media = state.media;
  const subOpts = subtitleOptions(media);
  const audioOpts = audioOptions(media);

  // Nothing to switch: no button, no menu, no clutter.
  const show = subOpts.length > 1 || audioOpts.length > 1;
  el.subsBtn.classList.toggle('hidden', !show);
  if (!show) {
    closeTrackMenu();
    return;
  }

  el.subGroup.classList.toggle('hidden', subOpts.length < 2);
  el.audioGroup.classList.toggle('hidden', audioOpts.length < 2);

  const pending = state.cleanPending?.id === media?.id ? state.cleanPending : null;
  const pendingNote = pending ? `preparing ${Math.max(1, Math.round(pending.progress))}%` : '';

  el.subList.replaceChildren(
    ...subOpts.map((option) =>
      trackItem({
        label: option.label,
        note: option.value === state.tracks.sub && pendingNote ? pendingNote : option.note,
        active: option.value === state.tracks.sub,
        onClick: () => chooseSubtitle(option.value),
      }),
    ),
  );

  el.audioList.replaceChildren(
    ...audioOpts.map((option) =>
      trackItem({
        label: option.label,
        note: option.note,
        active: option.value === state.tracks.audio,
        onClick: () => chooseAudio(option.value),
      }),
    ),
  );

  const onSoftSubs = state.tracks.sub !== 'styled';
  el.subsBtn.classList.toggle('on', onSoftSubs || state.altActive);
}

function toggleTrackMenu() {
  if (el.trackMenu.classList.contains('hidden')) openTrackMenu();
  else closeTrackMenu();
}

function openTrackMenu() {
  renderTrackMenu();
  el.trackMenu.classList.remove('hidden');
  el.subsBtn.setAttribute('aria-expanded', 'true');
}

function closeTrackMenu() {
  el.trackMenu.classList.add('hidden');
  el.subsBtn.setAttribute('aria-expanded', 'false');
}

function updateMetaUI() {
  const media = state.media;
  if (!media) return;
  el.nowTitle.textContent = media.title;

  const bits = [];
  if (media.duration) bits.push(fmtTime(media.duration));
  // Report what is being streamed, not what the file is: a 4K release is
  // served at the 1080p cap and saying "2160p" would be a lie.
  const streamed = media.streamHeight || media.height;
  if (streamed) bits.push(`${streamed}p${media.height > streamed ? ' (from ' + media.height + 'p)' : ''}`);
  if (media.hdr) bits.push('HDR tone-mapped');
  const softSubs = textSubs(media);
  if (media.bakedSubs) bits.push('subtitles burned in');
  else if (softSubs.length) bits.push(`${softSubs.length} subtitle track${softSubs.length > 1 ? 's' : ''}`);
  if (media.bakedSubs && softSubs.length > 1) bits.push(`${softSubs.length - 1} switchable`);
  const audioCount = media.audioTracks?.length || 0;
  if (audioCount > 1) bits.push(`${audioCount} audio tracks`);
  if (media.hasBitmapSubs && !media.bakedSubs) bits.push('bitmap subs not supported');
  if (media.fonts?.length) bits.push(`${media.fonts.length} font${media.fonts.length > 1 ? 's' : ''} embedded`);
  el.nowSub.textContent = bits.join(' · ') || '—';

  el.placeholderTitle.textContent = 'Ready when you are';
  el.placeholderText.textContent = 'Press play — everyone in the room follows your timeline.';
}

// ---------------------------------------------------------------------------
// Room rendering
// ---------------------------------------------------------------------------

function renderAvatars() {
  el.avatars.replaceChildren();
  for (const user of state.users.slice(0, 5)) {
    const node = document.createElement('div');
    node.className = 'avatar' + (user.buffering ? ' buffering' : '') + (user.isHost ? ' is-host' : '');
    node.style.background = `linear-gradient(135deg, hsl(${hueFor(user.name)} 80% 72%), hsl(${(hueFor(user.name) + 40) % 360} 80% 62%))`;
    node.textContent = initials(user.name);
    node.title = `${user.name}${user.isHost ? ' (host)' : ''}${user.buffering ? ' · buffering' : ''}`;
    el.avatars.appendChild(node);
  }
  const capacity = state.room?.capacity ?? 3;
  el.roomChip.textContent = `${state.users.length} / ${capacity} seats`;
}

function renderPeople() {
  el.people.replaceChildren();
  for (const user of state.users) {
    const li = document.createElement('li');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = `linear-gradient(135deg, hsl(${hueFor(user.name)} 80% 72%), hsl(${(hueFor(user.name) + 40) % 360} 80% 62%))`;
    avatar.textContent = initials(user.name);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = user.name + (user.id === state.me?.id ? ' (you)' : '');
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = user.latency != null ? `${user.latency} ms round trip` : 'measuring…';
    meta.append(name, sub);

    li.append(avatar, meta);
    if (user.isHost) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'host';
      li.appendChild(tag);
    }
    const status = document.createElement('span');
    status.className = 'state';
    status.textContent = user.buffering ? 'buffering…' : 'ready';
    li.appendChild(status);
    el.people.appendChild(li);
  }
}

function updateLockButton() {
  const isHost = state.me?.isHost;
  const locked = Boolean(state.room?.locked);
  el.lockBtn.textContent = locked ? 'Unlock controls' : 'Lock controls';
  el.lockBtn.classList.toggle('on', locked);
  el.lockBtn.disabled = !isHost;
  el.lockBtn.title = isHost
    ? 'Only the host can control playback while locked'
    : 'Only the host can change this';
}

// Joining replays history *and* delivers the live "X joined" broadcast, so the
// same entry can arrive twice. Render each id once.
const seenEntries = new Set();

function appendMessage(entry) {
  if (!entry) return;
  if (entry.id) {
    if (seenEntries.has(entry.id)) return;
    seenEntries.add(entry.id);
    if (seenEntries.size > 500) seenEntries.clear();
  }
  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;

  const node = document.createElement('div');
  node.className = 'msg';
  if (entry.kind === 'system') {
    node.classList.add('system');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = entry.text;
    node.appendChild(bubble);
  } else {
    if (entry.fromId && entry.fromId === state.me?.id) node.classList.add('mine');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = entry.from || 'someone';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = entry.text;
    node.append(who, bubble);
  }
  el.messages.appendChild(node);
  if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function refreshLibrary() {
  try {
    const response = await fetch('/api/library');
    const data = await response.json();
    state.mediaList = data.media || [];
    renderLibrary();
    if (data.room?.state?.mediaId && !state.media) {
      const current = state.mediaList.find((m) => m.id === data.room.state.mediaId);
      if (current) loadMedia(current);
    }
  } catch {
    /* transient; the next event will retry */
  }
}

function upsertMedia(media) {
  const index = state.mediaList.findIndex((m) => m.id === media.id);
  if (index >= 0) state.mediaList[index] = media;
  else state.mediaList.push(media);
  renderLibrary();
}

function renderLibrary() {
  el.library.replaceChildren();
  if (!state.mediaList.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No video files found yet. Upload one above, or drop files into the server’s media/ folder and rescan.';
    el.library.appendChild(empty);
    return;
  }

  for (const media of state.mediaList) {
    const card = document.createElement('div');
    card.className = 'card' + (state.media?.id === media.id ? ' playing' : '');
    card.dataset.media = media.id;

    let thumb = null;
    if (media.poster) {
      thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.loading = 'lazy';
      thumb.alt = '';
      thumb.src = media.poster;
      thumb.onerror = () => {
        thumb.style.visibility = 'hidden';
      };
    }

    const body = document.createElement('div');
    body.className = 'body';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = media.title;
    title.title = media.rel;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    if (media.duration) bits.push(fmtTime(media.duration));
    if (media.height) bits.push(`${media.height}p`);
    if (media.subs?.length) bits.push(`${media.subs.length} sub`);
    meta.textContent = bits.join(' · ') || 'probing…';

    const row = document.createElement('div');
    row.className = 'row';

    if (media.error) {
      const err = document.createElement('span');
      err.className = 'meta';
      err.style.color = 'var(--bad)';
      err.textContent = 'failed';
      err.title = media.error;
      row.appendChild(err);
    } else if (media.prepared) {
      const play = document.createElement('button');
      play.className = 'btn primary compact';
      play.textContent = state.media?.id === media.id ? 'Playing' : 'Play';
      play.onclick = () => {
        send({ t: 'select', mediaId: media.id });
        selectTab('chat');
      };
      row.appendChild(play);
    } else {
      const prep = document.createElement('button');
      prep.className = 'btn ghost compact';
      prep.textContent = media.preparing ? 'Preparing…' : 'Prepare';
      prep.disabled = media.preparing;
      prep.onclick = async () => {
        prep.disabled = true;
        prep.textContent = 'Preparing…';
        await fetch(`/api/media/${media.id}/prepare`, { method: 'POST' });
        refreshLibrary();
      };
      row.appendChild(prep);
    }

    const del = document.createElement('button');
    del.className = 'btn ghost compact card-delete';
    del.type = 'button';
    del.textContent = '✕';
    del.title = media.preparing
      ? 'Preparing — you can delete this once the encode finishes'
      : `Delete ${media.title} from the server`;
    del.setAttribute('aria-label', `Delete ${media.title}`);
    del.disabled = Boolean(media.preparing);
    del.onclick = () => {
      state.confirmDelete = media.id;
      renderLibrary();
    };
    row.appendChild(del);

    if (media.preparing || (!media.prepared && media.progress > 0)) {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const fill = document.createElement('i');
      fill.style.width = `${media.progress || 0}%`;
      progress.appendChild(fill);
      row.appendChild(progress);
    }

    // Deleting is a two-step action, and the question has to survive a library
    // refresh (a rescan, another episode finishing) instead of being wiped by
    // the next render.
    if (state.confirmDelete === media.id) row.replaceChildren(...confirmDeleteRow(media));

    body.append(title, meta, row);
    if (thumb) card.append(thumb, body);
    else {
      card.classList.add('no-thumb');
      card.append(body);
    }
    el.library.appendChild(card);
  }
}

/**
 * Delete asks in place: the card's own buttons become a question, which is
 * smaller and less jarring than a modal. The file goes to media/.trash, so a
 * misclick on a 20 GB episode is recoverable.
 */
function confirmDeleteRow(media) {
  const onScreen = state.media?.id === media.id;

  const question = document.createElement('span');
  question.className = 'confirm-text';
  question.textContent = onScreen ? 'Delete? Stops the room.' : 'Delete this file?';

  const yes = document.createElement('button');
  yes.className = 'btn compact danger';
  yes.type = 'button';
  yes.textContent = 'Delete';
  yes.onclick = async () => {
    yes.disabled = true;
    yes.textContent = 'Deleting…';
    state.confirmDelete = null;
    try {
      const response = await fetch(`/api/media/${media.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `delete failed (${response.status})`);
      }
      toast(`${media.title} removed`);
    } catch (err) {
      toast(err.message || 'delete failed', 'error');
    }
    await refreshLibrary();
  };

  const no = document.createElement('button');
  no.className = 'btn ghost compact';
  no.type = 'button';
  no.textContent = 'Cancel';
  no.onclick = () => {
    state.confirmDelete = null;
    renderLibrary();
  };

  return [question, yes, no];
}

// ---------------------------------------------------------------------------
// Uploads: one at a time, with an honest progress read-out
// ---------------------------------------------------------------------------

const UPLOAD = {
  queue: [],
  active: [],
  // Three at a time keeps a LAN link saturated without turning the per-file
  // speed and ETA into noise. The server still encodes one at a time.
  maxConcurrent: 3,
  renderTimer: null,
  seq: 0,
};

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

const fmtEta = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s left`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m left`;
};

/** Bytes per second over the last few samples, so the number is not jittery. */
function uploadSpeed(job) {
  const samples = job.samples;
  if (samples.length < 2) return NaN;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.t - first.t) / 1000;
  if (seconds < 0.25) return NaN;
  return (last.b - first.b) / seconds;
}

function scheduleUploadRender() {
  if (UPLOAD.renderTimer) return;
  // Progress events arrive many times a second; the DOM does not need them all.
  UPLOAD.renderTimer = setTimeout(() => {
    UPLOAD.renderTimer = null;
    renderUpload();
  }, 120);
}

function uploadRow(job) {
  const row = document.createElement('div');
  row.className = 'upload-row';
  row.dataset.job = String(job.id);

  const top = document.createElement('div');
  top.className = 'upload-top';

  const phase = document.createElement('span');
  phase.className = 'upload-phase';
  phase.textContent = 'Uploading';

  const name = document.createElement('span');
  name.className = 'upload-name';
  name.textContent = job.file.name;
  name.title = job.file.name;

  const cancel = document.createElement('button');
  cancel.className = 'upload-cancel';
  cancel.type = 'button';
  cancel.textContent = '✕';
  cancel.title = `Cancel ${job.file.name}`;
  cancel.setAttribute('aria-label', `Cancel ${job.file.name}`);

  top.append(phase, name, cancel);

  const track = document.createElement('div');
  track.className = 'upload-track';
  const fill = document.createElement('i');
  track.appendChild(fill);

  const detail = document.createElement('div');
  detail.className = 'upload-detail';

  row.append(top, track, detail);
  return row;
}

/** Reuse a row so a click on its ✕ is never lost to a re-render. */
function rowFor(job) {
  let row = el.uploadBar.querySelector(`[data-job="${job.id}"]`);
  if (!row) {
    row = uploadRow(job);
    el.uploadBar.appendChild(row);
  }
  return row;
}

function fillUploadRow(job, row, queued) {
  const phase = row.querySelector('.upload-phase');
  const fill = row.querySelector('.upload-track > i');
  const detail = row.querySelector('.upload-detail');
  const cancel = row.querySelector('.upload-cancel');

  if (job.phase === 'uploading') {
    const pct = job.total ? Math.min(100, (job.loaded / job.total) * 100) : 0;
    const speed = uploadSpeed(job);
    const remaining = speed > 0 ? (job.total - job.loaded) / speed : NaN;
    phase.textContent = pct >= 99.9 ? 'Finishing' : 'Uploading';
    fill.style.width = `${pct}%`;
    detail.textContent =
      `${fmtBytes(job.loaded)} of ${fmtBytes(job.total)}` +
      (Number.isFinite(speed) && speed > 0 ? ` · ${fmtBytes(speed)}/s` : '') +
      (Number.isFinite(remaining) ? ` · ${fmtEta(remaining)}` : '');
    cancel.classList.remove('hidden');
  } else if (job.phase === 'preparing') {
    phase.textContent = 'Preparing';
    fill.style.width = `${Math.max(1, job.encode || 0)}%`;
    // The server encodes one episode at a time, so a second upload waits its turn.
    detail.textContent = job.startedEncoding
      ? `converting for the browser · ${Math.round(job.encode || 0)}%`
      : 'uploaded · waiting for the encoder';
    cancel.classList.add('hidden');
  } else if (job.phase === 'done') {
    phase.textContent = 'Ready';
    fill.style.width = '100%';
    detail.textContent = job.note || 'ready to play';
    cancel.classList.add('hidden');
  } else if (job.phase === 'cancelled') {
    phase.textContent = 'Cancelled';
    fill.style.width = '0%';
    detail.textContent = 'upload cancelled';
    cancel.classList.add('hidden');
  } else if (job.phase === 'failed') {
    phase.textContent = 'Failed';
    fill.style.width = '0%';
    detail.textContent = job.error || 'upload failed';
    cancel.classList.add('hidden');
  }
}

function renderUpload() {
  if (!UPLOAD.active.length) {
    el.uploadBar.replaceChildren();
    el.uploadBar.classList.add('hidden');
    return;
  }
  el.uploadBar.classList.remove('hidden');

  for (const job of UPLOAD.active) fillUploadRow(job, rowFor(job));

  // Drop rows for transfers that are gone.
  for (const row of [...el.uploadBar.querySelectorAll('.upload-row')]) {
    if (!UPLOAD.active.some((job) => String(job.id) === row.dataset.job)) row.remove();
  }

  const queued = UPLOAD.queue.length;
  let note = el.uploadBar.querySelector('.upload-queue');
  if (queued) {
    if (!note) {
      note = document.createElement('div');
      note.className = 'upload-queue';
      el.uploadBar.appendChild(note);
    }
    note.textContent = `${queued} more waiting`;
  } else if (note) {
    note.remove();
  }
}

function finishJob(job) {
  UPLOAD.active = UPLOAD.active.filter((entry) => entry !== job);
  job.xhr = null;
  renderUpload();
  refreshLibrary();
  pumpUploads();
}

function runUpload(job) {
  const form = new FormData();
  form.append('file', job.file, job.file.name);

  const xhr = new XMLHttpRequest();
  job.xhr = xhr;
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    job.loaded = event.loaded;
    job.total = event.total;
    const now = performance.now();
    job.samples.push({ t: now, b: event.loaded });
    while (job.samples.length > 10) job.samples.shift();
    scheduleUploadRender();
  };
  xhr.onload = () => {
    if (xhr.status >= 400) {
      let message = 'upload failed';
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        /* keep the default */
      }
      toast(message, 'error');
      job.phase = 'failed';
      job.error = message;
      renderUpload();
      setTimeout(() => finishJob(job), 4000);
      return;
    }
    let added = null;
    try {
      added = JSON.parse(xhr.responseText);
    } catch {
      /* ignore */
    }
    if (added?.id) {
      // The server starts the encode as soon as the file lands; follow its
      // progress rather than pretending the upload finished the job.
      job.phase = 'preparing';
      job.mediaId = added.id;
      job.encode = 0;
      job.startedEncoding = false;
      renderUpload();
      pumpUploads();
      return;
    }
    // A subtitle or audio sidecar attaches to whatever it is named after and
    // does not start an encode.
    job.phase = 'done';
    job.note = 'added as a track';
    renderUpload();
    toast(`${job.file.name} added as a track`);
    setTimeout(() => finishJob(job), 1600);
  };
  xhr.onerror = () => {
    job.phase = 'failed';
    job.error = 'upload failed — connection lost';
    renderUpload();
    toast('upload failed', 'error');
    setTimeout(() => finishJob(job), 4000);
  };
  xhr.onabort = () => {
    job.phase = 'cancelled';
    renderUpload();
    setTimeout(() => finishJob(job), 1200);
  };
  xhr.send(form);
}

/** Start as many transfers as the concurrency limit allows. */
function pumpUploads() {
  while (UPLOAD.active.length < UPLOAD.maxConcurrent && UPLOAD.queue.length) {
    const file = UPLOAD.queue.shift();
    const job = {
      id: ++UPLOAD.seq,
      file,
      phase: 'uploading',
      loaded: 0,
      total: file.size || 0,
      samples: [],
      encode: 0,
      startedEncoding: false,
    };
    UPLOAD.active.push(job);
    runUpload(job);
  }
  renderUpload();
}

/** Queue files; the first few start immediately, the rest follow. */
function uploadFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return;
  UPLOAD.queue.push(...list);
  pumpUploads();
}

el.uploadBar.addEventListener('click', (event) => {
  const button = event.target.closest('.upload-cancel');
  if (!button) return;
  const row = button.closest('.upload-row');
  const job = UPLOAD.active.find((entry) => String(entry.id) === row?.dataset.job);
  // Abort the request; the server drops its .part file on a dead socket.
  job?.xhr?.abort();
});

// ---------------------------------------------------------------------------
// Tabs, join modal, wiring
// ---------------------------------------------------------------------------

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

function showJoin(message = '') {
  el.join.classList.remove('hidden');
  el.joinError.textContent = message;
  el.nameInput.value = state.name;
  setTimeout(() => el.nameInput.focus(), 80);
}

el.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = el.nameInput.value.trim();
  if (!name) return;
  state.name = name;
  localStorage.setItem('anisync:name', name);
  el.join.classList.add('hidden');
  connect(name);
});

el.playBtn.addEventListener('click', togglePlay);
el.video.addEventListener('click', togglePlay);

el.seek.addEventListener('pointerdown', () => {
  state.dragging = true;
});
el.seek.addEventListener('input', () => {
  const duration = el.video.duration || 0;
  el.time.textContent = `${fmtTime(el.seek.value)} / ${fmtTime(duration)}`;
  el.seek.style.setProperty('--progress', `${duration ? (el.seek.value / duration) * 100 : 0}%`);
});
el.seek.addEventListener('change', () => {
  state.dragging = false;
  seekTo(Number(el.seek.value));
});

function setVolume(value) {
  const level = Math.max(0, Math.min(1, Number(value)));
  el.video.volume = level;
  el.altAudio.volume = level;
  // The video element stays silent whenever an alternate track is in charge,
  // otherwise a volume change would play both tracks at once.
  el.video.muted = level === 0 || Boolean(state.userMuted) || state.altActive;
  localStorage.setItem('anisync:volume', String(level));
}

function setMuted(muted) {
  state.userMuted = muted;
  // While an alternate audio track plays, the video element stays muted no
  // matter what — otherwise both tracks would sound at once.
  el.video.muted = muted || state.altActive;
  el.altAudio.muted = muted;
  el.muteBtn.classList.toggle('on', muted);
}

el.volume.addEventListener('input', () => setVolume(el.volume.value));
el.muteBtn.addEventListener('click', () => setMuted(!state.userMuted));

el.subsBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleTrackMenu();
});

// Clicking anywhere else, or pressing Escape, closes the track menu.
document.addEventListener('click', (event) => {
  if (el.trackMenu.classList.contains('hidden')) return;
  if (el.trackMenu.contains(event.target) || el.subsBtn.contains(event.target)) return;
  closeTrackMenu();
});

el.fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen?.();
});

el.gate.addEventListener('click', () => {
  showGate(false);
  const roomState = state.room?.state;
  if (roomState) {
    const expected = expectedPosition(roomState, serverNow());
    if (Math.abs(el.video.currentTime - expected) > 0.35) el.video.currentTime = expected;
  }
  requestPlay();
});

el.syncBadge.addEventListener('click', () => {
  const roomState = state.room?.state;
  if (!roomState) return;
  const expected = expectedPosition(roomState, serverNow());
  state.settleUntil = performance.now() + 700;
  el.video.currentTime = expected;
  setRate(1);
  state.nudging = false;
  toast('resynced to the room');
});

el.lockBtn.addEventListener('click', () => {
  send({ t: 'lock', value: !state.room?.locked });
});

el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  el.chatInput.value = '';
});

el.rescanBtn.addEventListener('click', async () => {
  el.rescanBtn.disabled = true;
  await fetch('/api/rescan', { method: 'POST' });
  await refreshLibrary();
  el.rescanBtn.disabled = false;
  toast('Library refreshed');
});

el.placeholderBtn.addEventListener('click', () => selectTab('library'));

el.uploadInput.addEventListener('change', (event) => {
  uploadFiles(event.target.files);
  event.target.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  document.addEventListener(type, (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
});
document.addEventListener('drop', (event) => {
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  event.preventDefault();
  uploadFiles(files);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.trackMenu.classList.contains('hidden')) {
    closeTrackMenu();
    return;
  }
  const typing = ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
  if (typing) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.code === 'Space' || event.key === 'k') {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    seekTo((el.video.currentTime || 0) + 5, { resume: state.room?.state?.playing ?? true });
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    seekTo((el.video.currentTime || 0) - 5, { resume: state.room?.state?.playing ?? true });
  } else if (event.key === 'm') {
    el.muteBtn.click();
  } else if (event.key === 'c') {
    toggleTrackMenu();
  } else if (event.key === 'f') {
    el.fsBtn.click();
  }
});

// A late joiner should never linger at 0:00 waiting for the next tick.
el.video.addEventListener('loadedmetadata', () => {
  const roomState = state.room?.state;
  if (!roomState?.mediaId || !state.media) return;
  const expected = expectedPosition(roomState, serverNow());
  if (Math.abs(el.video.currentTime - expected) > 0.5 && !inPreRoll(roomState, serverNow())) {
    state.settleUntil = performance.now() + 400;
    el.video.currentTime = expected;
  }
  if (roomState.playing) requestPlay();
});

// The credits roll for everyone: the room should pause, not keep counting.
el.video.addEventListener('ended', () => {
  if (state.room?.state?.playing) send({ t: 'ended' });
  setPlayIcon(false);
  el.stage.classList.add('paused');
  setBadge('finished');
});

el.video.addEventListener('waiting', () => send({ t: 'buffering', value: true }, { quiet: true }));
el.video.addEventListener('playing', () => send({ t: 'buffering', value: false }, { quiet: true }));
el.video.addEventListener('canplay', () => {
  state.loadRetries = 0;
  send({ t: 'buffering', value: false }, { quiet: true });
});
el.video.addEventListener('error', () => {
  if (!el.video.error) return;
  // The server only answers 409 while it rebuilds a rendition. Waiting for the
  // library event is the right move: retrying on a timer would spend the whole
  // retry budget before a long encode finishes.
  if (state.media && state.media.prepared === false) {
    setBadge('rebuilding episode…', 'ok');
    return;
  }
  // A 409 that has not been announced yet: ask once, then wait.
  if (state.media && state.loadRetries < 6) {
    retryPlayback();
    return;
  }
  toast(`Playback error: ${el.video.error.message || 'unknown'}`, 'error');
});
el.video.addEventListener('play', () => {
  setPlayIcon(true);
  el.stage.classList.remove('paused');
  showGate(false);
});
el.video.addEventListener('pause', () => {
  setPlayIcon(false);
  el.stage.classList.add('paused');
});

const storedVolume = localStorage.getItem('anisync:volume');
if (storedVolume != null) {
  el.volume.value = storedVolume;
  setVolume(storedVolume);
}

window.__sync = {
  samples: debugSamples,
  snapshot: () => ({
    offset: Math.round(state.offset),
    rtt: state.samples.at(-1)?.rtt != null ? Math.round(state.samples.at(-1).rtt) : null,
    users: state.users.length,
    capacity: state.room?.capacity ?? null,
    mediaId: state.media?.id ?? null,
    playing: state.room?.state?.playing ?? null,
    roomPosition: state.room?.state?.position ?? null,
    expected: state.room?.state ? Number(expectedPosition(state.room.state, serverNow()).toFixed(3)) : null,
    currentTime: Number((el.video.currentTime || 0).toFixed(3)),
    readyState: el.video.readyState,
    nudging: state.nudging,
    rate: el.video.playbackRate,
    subtitles: !state.media
      ? 'none'
      : state.tracks.sub === 'styled'
        ? 'baked'
        : el.video.textTracks?.length
          ? 'soft'
          : 'off',
    audioTrack: state.tracks.audio,
    badge: el.syncBadge.textContent,
  }),
};

setInterval(tick, 200);
setInterval(() => {
  // Keep the library honest while a transcode is running.
  if (state.mediaList.some((m) => m.preparing)) refreshLibrary();
}, 4000);

if (state.name) {
  el.nameInput.value = state.name;
  showJoin();
} else {
  showJoin();
}
