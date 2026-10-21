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
  uploadFill: $('uploadFill'),
  uploadLabel: $('uploadLabel'),
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
  mediaList: [],
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

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?name=${encodeURIComponent(name)}`;
  setBadge('connecting…');

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
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
    if (event.code === 4001) {
      showJoin('The room is full — three seats only.');
      return;
    }
    if (state.retries > 8) {
      setBadge('disconnected', 'bad');
      toast('Connection lost. Reload to reconnect.', 'error');
      return;
    }
    state.retries += 1;
    setBadge('reconnecting…', 'ok');
    setTimeout(() => connect(name), Math.min(8000, 600 * 2 ** state.retries));
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Keep a short trail so sync disputes can be settled with evidence.
    (window.__sent ||= []).push({ at: Math.round(performance.now()), ...msg });
    if (window.__sent.length > 200) window.__sent.shift();
    state.ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

function startPings() {
  stopPings();
  const ping = () => {
    send({ t: 'ping', id: Math.random().toString(36).slice(2), cts: performance.now() });
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
  send({ t: 'latency', value: Math.round(sample.rtt) });
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

    case 'users':
      state.users = msg.users;
      state.room && (state.room.users = msg.users);
      renderPeople();
      renderAvatars();
      return;

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
      return;
    }

    case 'library':
      refreshLibrary();
      return;

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
  if (playing) send({ t: 'pause' });
  else send({ t: 'play', position: el.video.currentTime });
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

  const expected = expectedPosition(roomState, now);
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

function destroySubs() {
  const old = el.video.querySelector('track');
  if (old) old.remove();
}

function loadMedia(media) {
  if (!media) return;
  if (state.media?.id === media.id && el.video.src) {
    state.media = media;
    updateMetaUI();
    return;
  }

  state.media = media;
  state.nudging = false;
  destroySubs();
  setRate(1);

  el.video.pause();
  el.video.src = media.playbackUrl;
  el.video.poster = media.poster || '';
  el.video.load();
  state.loadStartedAt = performance.now();
  state.lastReloadAt = 0;
  el.placeholder.classList.add('hidden');
  el.stageTag.textContent = media.title;
  el.stageTag.classList.remove('hidden');
  updateMetaUI();
  initSubs(media);
}

/**
 * Subtitles are normally baked into the video by ffmpeg (`SUBTITLES=bake`),
 * which keeps ASS typesetting, signs and karaoke exactly as the release intends
 * and needs nothing from the browser. When the server is set to soft subtitles
 * we attach a plain WebVTT track instead, which the CC button can toggle.
 */
function initSubs(media) {
  const track = media.subs?.[0];
  const baked = Boolean(media.bakedSubs);
  el.subsBtn.classList.toggle('hidden', baked || !track);
  el.subsBtn.classList.toggle('on', Boolean(track) && !baked);
  if (baked || !track) return;
  attachVttTrack(media, track);
}

/** Soft subtitles: no typesetting, but the viewer can turn them off. */
function attachVttTrack(media, track) {
  destroySubs();
  if (!track.vtt) return;
  const node = document.createElement('track');
  node.kind = 'subtitles';
  node.label = track.label || 'Subtitles';
  node.srclang = track.lang || 'jpn';
  node.src = `/media/${media.id}/subs/${track.vtt}`;
  node.default = true;
  el.video.appendChild(node);
  setTimeout(() => {
    if (el.video.textTracks[0]) el.video.textTracks[0].mode = 'showing';
  }, 200);
}

function toggleSubs() {
  const native = el.video.textTracks?.[0];
  if (!native) return;
  native.mode = native.mode === 'showing' ? 'hidden' : 'showing';
  el.subsBtn.classList.toggle('on', native.mode === 'showing');
}

function updateMetaUI() {
  const media = state.media;
  if (!media) return;
  el.nowTitle.textContent = media.title;

  const bits = [];
  if (media.duration) bits.push(fmtTime(media.duration));
  if (media.height) bits.push(`${media.height}p`);
  if (media.bakedSubs) bits.push('subtitles burned in');
  else if (media.subs?.length) bits.push(`${media.subs.length} soft subtitle track${media.subs.length > 1 ? 's' : ''}`);
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

function appendMessage(entry) {
  if (!entry) return;
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

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.loading = 'lazy';
    thumb.alt = '';
    thumb.src = media.poster;
    thumb.onerror = () => {
      thumb.style.visibility = 'hidden';
    };

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

    if (media.preparing || (!media.prepared && media.progress > 0)) {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const fill = document.createElement('i');
      fill.style.width = `${media.progress || 0}%`;
      progress.appendChild(fill);
      row.appendChild(progress);
    }

    body.append(title, meta, row);
    card.append(thumb, body);
    el.library.appendChild(card);
  }
}

async function uploadFile(file) {
  if (!file) return;
  el.uploadBar.classList.remove('hidden');
  el.uploadLabel.textContent = `uploading ${file.name}…`;
  el.uploadFill.style.width = '0%';

  const form = new FormData();
  form.append('file', file, file.name);

  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = (event.loaded / event.total) * 100;
      el.uploadFill.style.width = `${pct}%`;
      el.uploadLabel.textContent = `${file.name} — ${Math.round(pct)}%`;
    };
    xhr.onload = () => {
      if (xhr.status >= 400) {
        let message = 'upload failed';
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
          /* ignore */
        }
        toast(message, 'error');
      } else {
        toast(`${file.name} added — preparing`);
      }
      resolve();
    };
    xhr.onerror = () => {
      toast('upload failed', 'error');
      resolve();
    };
    xhr.send(form);
  });

  el.uploadBar.classList.add('hidden');
  refreshLibrary();
}

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

el.volume.addEventListener('input', () => {
  el.video.volume = Number(el.volume.value);
  el.video.muted = el.video.volume === 0;
  localStorage.setItem('anisync:volume', el.volume.value);
});
el.muteBtn.addEventListener('click', () => {
  el.video.muted = !el.video.muted;
  el.muteBtn.classList.toggle('on', el.video.muted);
});

el.subsBtn.addEventListener('click', toggleSubs);

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
  uploadFile(event.target.files?.[0]);
  event.target.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  document.addEventListener(type, (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
});
document.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  uploadFile(file);
});

document.addEventListener('keydown', (event) => {
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

el.video.addEventListener('waiting', () => send({ t: 'buffering', value: true }));
el.video.addEventListener('playing', () => send({ t: 'buffering', value: false }));
el.video.addEventListener('canplay', () => send({ t: 'buffering', value: false }));
el.video.addEventListener('error', () => {
  if (el.video.error) toast(`Playback error: ${el.video.error.message || 'unknown'}`, 'error');
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
  el.video.volume = Number(storedVolume);
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
    subtitles: state.media?.bakedSubs ? 'baked' : el.video.textTracks?.length ? 'native' : 'none',
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
