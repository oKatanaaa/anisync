import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import busboy from 'busboy';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { Library, isMediaId } from './media.js';
import { Room } from './rooms.js';
import { detectEncoder, killAll, runningChildren } from './ffmpeg.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------
// Transport: one shared WebSocket hub, JSON messages.
// ---------------------------------------------------------------------------

const clients = new Map(); // ws -> { user, alive }

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(payload);
}

/**
 * Roster updates are the noisiest thing on the wire: every clock ping and every
 * buffer event changes a latency or a badge. Three clients pinging every three
 * seconds plus a seek storm should not become a broadcast storm, so send at most
 * one roster per 200 ms and always flush the final state.
 */
let usersTimer = null;
let usersPending = null;
function broadcastUsers(users) {
  usersPending = users;
  if (usersTimer) return;
  usersTimer = setTimeout(() => {
    usersTimer = null;
    const payload = usersPending;
    usersPending = null;
    if (payload) broadcast({ t: 'users', users: payload });
  }, 200);
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

const library = new Library({
  onEvent: (evt) => {
    if (evt.type === 'progress') broadcast({ t: 'progress', id: evt.id, progress: evt.progress, stage: evt.stage });
    if (evt.type === 'prepared') broadcast({ t: 'library' });
    if (evt.type === 'variant') broadcast({ t: 'library' });
    if (evt.type === 'failed') broadcast({ t: 'notice', level: 'error', text: `Prepare failed: ${evt.message}` });
  },
});

const room = new Room({
  maxViewers: config.maxViewers,
  startDelayMs: config.startDelayMs,
  seekDelayMs: config.seekDelayMs,
  onEvent: (type, payload) => {
    if (type === 'state') broadcast({ t: 'state', ...payload });
    if (type === 'users') broadcastUsers(payload);
    if (type === 'chat') broadcast({ t: 'chat', entry: payload });
    if (type === 'lock') broadcast({ t: 'lock', locked: payload.locked });
  },
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use('/shared', express.static(path.join(config.root, 'shared'), { maxAge: '1h' }));
app.use(express.static(path.join(config.root, 'public'), { maxAge: '5m', index: 'index.html' }));

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    encoder: await detectEncoder(config.encoder),
    viewers: room.users.size,
    capacity: room.maxViewers,
    media: library.items.size,
    prepared: library.list().filter((m) => m.prepared).length,
    queue: library.inflight.size,
    encoders: runningChildren(),
    rss: Math.round(process.memoryUsage.rss() / 1024 ** 2),
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/library', (_req, res) => {
  res.json({ media: library.list(), room: room.snapshot() });
});

/** Drop a room's episode once its file is gone, so clients are not left with a dead URL. */
function pruneRoomMedia() {
  if (room.state.mediaId && !library.get(room.state.mediaId)) {
    if (room.forgetMedia()) broadcast({ t: 'library' });
  }
}

app.post('/api/rescan', async (_req, res, next) => {
  try {
    await library.scan();
    pruneRoomMedia();
    broadcast({ t: 'library' });
    res.json({ ok: true, media: library.list() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/media/:id/prepare', async (req, res, next) => {
  try {
    const item = library.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'unknown media' });
    // Build the main rendition by default; `{ height: 720, clean: true }` asks
    // for a lighter copy or a subtitle-free one without touching what exists.
    const height = Number(req.body?.height) || null;
    const clean = Boolean(req.body?.clean) || req.body?.variant === 'clean';
    library.prepare(item.id, { height, clean }).catch((err) => log('prepare failed:', err.message));
    res.status(202).json({ ok: true, id: item.id, height, clean });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/media/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isMediaId(id)) return res.status(400).json({ error: 'bad media id' });
    const item = library.get(id);
    if (!item) return res.status(404).json({ error: 'not in the library' });
    // Deleting mid-encode would pull the cache directory out from under ffmpeg.
    if (item.preparing) return res.status(409).json({ error: 'still preparing — try again when it finishes' });

    const removed = await library.remove(id);
    if (!removed) return res.status(404).json({ error: 'not in the library' });
    // If that episode was on screen, the room forgets it instead of pointing
    // every client at a file that no longer exists.
    if (room.state.mediaId === id) room.forgetMedia();
    pruneRoomMedia();
    broadcast({ t: 'library' });
    log(`removed ${removed.title}${removed.trashed ? ' (moved to media/.trash)' : ''}`);
    return res.json({ ok: true, trashed: Boolean(removed.trashed) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', (req, res) => {
  let bus;
  try {
    bus = busboy({ headers: req.headers, limits: { files: 1, fileSize: config.maxUploadBytes } });
  } catch {
    return res.status(400).json({ error: 'expected multipart upload' });
  }

  let savedPath = null;
  let tooBig = false;
  let failure = null;
  let writeDone = null; // resolves when the temp file is flushed and renamed
  let tempPath = null;
  // A socket that dies mid-upload leaves a temp file behind; drop it at once
  // rather than waiting for the next scan to sweep it.
  const dropTemp = () => {
    if (!tempPath) return;
    library.activeUploads.delete(path.basename(tempPath));
    fs.rm(tempPath, { force: true }, () => {});
    tempPath = null;
  };

  const startedAt = Date.now();
  let received = 0;
  bus.on('file', (_field, file, info) => {
    const safe = path.basename(info.filename).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
    // Videos become library items; subtitle and audio sidecars are accepted so
    // an episode's tracks can be uploaded next to it and picked up by the scan.
    if (!/\.(mkv|mp4|webm|avi|mov|m4v|ts|m2ts|m4a|aac|opus|flac|mp3|ogg|wav|ass|ssa|srt|vtt)$/i.test(safe)) {
      failure = 'unsupported file type';
      file.resume();
      return;
    }
    // Write beside the target and rename when the upload completes: a dropped
    // connection must never leave a truncated file that looks like an episode.
    const dest = path.join(config.mediaDir, safe);
    const temp = `${dest}.part`;
    tempPath = temp;
    savedPath = dest;
    // Tell the scanner this .part file is a live transfer, not crash debris.
    library.activeUploads.add(path.basename(temp));
    const out = fs.createWriteStream(temp);
    file.on('data', (chunk) => {
      received += chunk.length;
    });
    file.pipe(out);
    out.on('error', (err) => {
      failure = failure || `write failed: ${err.message}`;
    });
    file.on('limit', () => {
      tooBig = true;
      out.destroy();
      fs.rm(temp, { force: true }, () => {});
    });
    file.on('error', () => {
      out.destroy();
      fs.rm(temp, { force: true }, () => {});
    });
    writeDone = new Promise((resolve) => {
      out.on('close', () => {
        // Whether it succeeded or not, this transfer no longer owns the file.
        library.activeUploads.delete(path.basename(temp));
        if (tooBig || failure) return resolve();
        try {
          fs.renameSync(temp, dest);
        } catch (err) {
          failure = `could not save upload: ${err.message}`;
          fs.rm(temp, { force: true }, () => {});
        }
        resolve();
      });
    });
  });

  req.on('aborted', () => {
    tooBig = false;
    failure = failure || 'upload aborted';
    dropTemp();
  });
  // Node 22 reports a dead upload as 'close' with an incomplete request rather
  // than 'aborted'; both paths have to be covered.
  req.on('close', () => {
    if (req.complete) return;
    failure = failure || 'upload aborted';
    dropTemp();
  });

  bus.on('close', async () => {
    // busboy finishes parsing before the last chunk is flushed to disk.
    if (writeDone) await writeDone.catch(() => {});
    if (failure) {
      const seconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
      log(
        `upload rejected after ${seconds.toFixed(0)}s: ${failure} ` +
          `(${(received / 1024 / 1024).toFixed(1)} MB, ${(received / 1024 / 1024 / seconds).toFixed(1)} MB/s)`,
      );
      return res.status(400).json({ error: failure });
    }
    if (tooBig) {
      log('upload rejected: file too large');
      return res.status(413).json({ error: 'file too large' });
    }
    if (!savedPath || !fs.existsSync(savedPath)) {
      return res.status(400).json({ error: 'no file received' });
    }
    await library.scan();
    pruneRoomMedia();
    const item = [...library.items.values()].find((i) => i.path === savedPath);
    const seconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
    log(
      `upload received: ${path.basename(savedPath)} ` +
        `(${(received / 1024 / 1024).toFixed(1)} MB in ${seconds.toFixed(0)}s, ${(received / 1024 / 1024 / seconds).toFixed(1)} MB/s)`,
    );
    if (item) library.prepare(item.id).catch(() => {});
    broadcast({ t: 'library' });
    res.json({ ok: true, id: item?.id ?? null });
  });

  req.pipe(bus);
});

// --- media byte ranges ------------------------------------------------------
// res.sendFile implements conditional GET and Range requests, which is what
// makes instant seeking work without any streaming server.

const sendIfExists = (res, file, headers = {}) => {
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not ready' });
  // acceptRanges + conditional GET are what make scrubbing feel instant: the
  // browser keeps what it already has and asks only for the missing bytes.
  res.sendFile(file, { headers, acceptRanges: true, cacheControl: false });
};

app.get('/media/:id/video.mp4', (req, res) => {
  const { id } = req.params;
  if (!isMediaId(id)) return res.status(400).end();
  const file = path.join(config.cacheDir, id, 'video.mp4');
  if (!fs.existsSync(file)) {
    // The cache was wiped or the encode never finished. Say so honestly and
    // start again instead of handing the player a 404 it reports as a codec
    // error. The URL carries the source version, so caching stays safe.
    const item = library.get(id);
    if (item) {
      item.prepared = false;
      // Let the clients know, so they wait for the rebuild instead of burning
      // their retry budget on a file that is still being encoded.
      broadcast({ t: 'library' });
      library.prepare(id).catch(() => {});
    }
    return res.status(409).json({ error: 'not ready', repreparing: Boolean(item) });
  }
  res.sendFile(file, {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    acceptRanges: true,
    cacheControl: false,
  });
});

/** The same episode without burned-in subtitles; built on first request. */
app.get('/media/:id/video.clean.mp4', (req, res) => {
  const { id } = req.params;
  if (!isMediaId(id)) return res.status(400).end();
  const file = path.join(config.cacheDir, id, 'video.clean.mp4');
  if (!fs.existsSync(file)) {
    const item = library.get(id);
    if (item) {
      item.hasClean = false;
      broadcast({ t: 'library' });
      library.prepare(id, { variant: 'clean' }).catch(() => {});
    }
    return res.status(409).json({ error: 'not ready', repreparing: Boolean(item) });
  }
  res.sendFile(file, {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    acceptRanges: true,
    cacheControl: false,
  });
});

/**
 * A lighter rendition of the same episode (720p next to 1080p). Built on first
 * request so a weak link has something to fall back to without re-uploading
 * anything; the sharper rendition stays on disk.
 */
app.get('/media/:id/quality/:height/:kind', (req, res) => {
  const { id, kind } = req.params;
  const height = Number(req.params.height);
  if (!isMediaId(id) || !Number.isFinite(height) || !['video.mp4', 'clean.mp4'].includes(kind)) {
    return res.status(400).end();
  }
  const clean = kind === 'clean.mp4';
  const file = path.join(config.cacheDir, id, clean ? `video.${height}.clean.mp4` : `video.${height}.mp4`);
  if (!fs.existsSync(file)) {
    const item = library.get(id);
    if (item) {
      if (item.altHeights?.[height]) {
        item.altHeights[height] = item.altHeights[height].filter((k) => k !== (clean ? 'clean' : 'styled'));
      }
      broadcast({ t: 'library' });
      library.prepare(id, { height, clean }).catch(() => {});
    }
    return res.status(409).json({ error: 'not ready', repreparing: Boolean(item) });
  }
  // Same immutable policy as the main rendition: the URL carries the source
  // version, so a rebuilt file can never be served from a stale cache entry.
  res.sendFile(file, {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    acceptRanges: true,
    cacheControl: false,
  });
});

/** Alternate audio tracks, one AAC file each. */
app.get('/media/:id/audio/:file', (req, res) => {
  const { id, file } = req.params;
  if (!isMediaId(id) || !/^\d+\.m4a$/.test(file)) return res.status(400).end();
  sendIfExists(res, path.join(config.cacheDir, id, 'audio', file), { 'Cache-Control': 'public, max-age=31536000, immutable' });
});

app.get('/media/:id/poster.jpg', (req, res) => {
  if (!isMediaId(req.params.id)) return res.status(400).end();
  sendIfExists(res, path.join(config.cacheDir, req.params.id, 'poster.jpg'), { 'Cache-Control': 'public, max-age=86400' });
});

app.get('/media/:id/subs/:file', (req, res) => {
  const { id, file } = req.params;
  if (!isMediaId(id) || !/^\d+\.(ass|vtt)$/.test(file)) return res.status(400).end();
  sendIfExists(res, path.join(config.cacheDir, id, 'subs', file), { 'Cache-Control': 'public, max-age=86400' });
});

app.get('/media/:id/fonts/:file', (req, res) => {
  const { id, file } = req.params;
  const safe = path.basename(file);
  if (!isMediaId(id) || safe !== file || !/\.(ttf|otf|ttc|woff2)$/i.test(safe)) return res.status(400).end();
  sendIfExists(res, path.join(config.cacheDir, id, 'fonts', safe), { 'Cache-Control': 'public, max-age=86400' });
});

app.use((err, _req, res, _next) => {
  log('error:', err.message);
  res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);
// Uploads are measured in gigabytes, so the default 5-minute request timeout
// has to go: it aborts the connection mid-file and the client only sees a
// vanished upload. Headers still get a normal timeout.
server.requestTimeout = config.uploadTimeoutMs;
server.headersTimeout = 60_000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Guest';

wss.on('connection', (ws, url) => {
  // A reload reuses its session id: hand the seat over before the capacity
  // check, otherwise the ghost we just left blocks the reconnect for 30 s.
  const sessionKey = (url.searchParams.get('s') || '').slice(0, 32);
  if (sessionKey) {
    for (const [other, entry] of clients) {
      if (entry.sessionKey !== sessionKey || other === ws) continue;
      clients.delete(other);
      room.leave(entry.user.id);
      try {
        other.close(4002, 'session replaced');
      } catch {
        /* already gone */
      }
    }
  }

  if (room.full) {
    send(ws, { t: 'rejected', code: 'full', message: `Room is full (${room.maxViewers} people).` });
    return ws.close(4001, 'room full');
  }

  const user = { id: crypto.randomUUID().slice(0, 8), name: cleanName(url.searchParams.get('name')) };
  clients.set(ws, { user, alive: true, sessionKey });

  const joined = room.join(user);
  if (!joined.ok) {
    send(ws, { t: 'rejected', code: 'full', message: 'Room is full.' });
    return ws.close(4001, 'room full');
  }

  send(ws, {
    t: 'welcome',
    you: { id: user.id, name: user.name, isHost: joined.user.isHost },
    ...room.snapshot(),
    // Resolve through the library so the payload always carries playbackUrl and
    // poster. `room.media` is only an {id,title,duration} note.
    media: room.media ? library.list().find((m) => m.id === room.media.id) ?? null : null,
  });

  ws.on('pong', () => {
    const entry = clients.get(ws);
    if (entry) entry.alive = true;
  });

  // One malformed or unexpected message must never take the room down with it:
  // a crash here disconnects everyone mid-episode.
  let budget = 60; // messages per second, per connection
  const refill = setInterval(() => {
    budget = 60;
  }, 1000);
  refill.unref();
  ws.on('close', () => clearInterval(refill));

  ws.on('message', (raw) => {
    if (--budget < 0) {
      // A runaway client (or a script) must not be able to melt the room.
      send(ws, { t: 'error', message: 'Slow down — too many messages' });
      return;
    }
    try {
      handleMessage(ws, user, raw);
    } catch (err) {
      log('message handler error:', err.stack || err.message);
      send(ws, { t: 'error', message: 'Something went wrong handling that action' });
    }
  });

  function handleMessage(ws, user, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    // Clock sync: echo the client's send time back with the server stamp.
    if (msg.t === 'ping') {
      return send(ws, { t: 'pong', id: msg.id, cts: msg.cts, sts: Date.now() });
    }

    if (msg.t === 'chat') {
      room.chat(user, msg.text);
      return;
    }

    // Any viewer can ask for the subtitle-free rendition; the library dedupes it.
    if (msg.t === 'variant') {
      const item = library.get(msg.id);
      if (!item) return send(ws, { t: 'error', message: 'Unknown media' });
      library.prepare(item.id, { variant: msg.variant === 'clean' ? 'clean' : 'styled' }).catch(() => {});
      return undefined;
    }

    if (msg.t === 'select') {
      const item = library.get(msg.mediaId);
      if (!item) return send(ws, { t: 'error', message: 'Unknown media' });
      if (!item.prepared) return send(ws, { t: 'error', message: 'Still preparing — give it a moment' });
      const res = room.apply(user, { t: 'select', mediaId: item.id, title: item.title, duration: item.duration });
      if (!res.ok) return send(ws, { t: 'error', message: res.error });
      const media = library.list().find((m) => m.id === item.id);
      return broadcast({ t: 'media', media });
    }

    const result = room.apply(user, msg);
    if (!result.ok) send(ws, { t: 'error', message: result.error });
  }

  ws.on('close', () => {
    clients.delete(ws);
    room.leave(user.id);
  });

  ws.on('error', () => {});
});

// Drop dead sockets so a sleeping laptop does not stay in the room forever.
const heartbeat = setInterval(() => {
  for (const [ws, entry] of clients) {
    if (!entry.alive) {
      ws.terminate();
      continue;
    }
    entry.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);

// An empty room is frozen the moment the last person leaves; this rewinds it
// once it has been quiet for a while, so nobody rejoins a stale timeline.
const sweeper = setInterval(() => {
  if (room.sweep()) log('room rewound after being empty');
}, 15_000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await library.ensureDirs();
await library.scan();
log(`library: ${library.items.size} file(s) in ${config.mediaDir}`);

server.listen(config.port, config.bind, async () => {
  log(`anime-sync listening on http://${config.bind}:${config.port}`);
  log(`encoder: ${await detectEncoder(config.encoder)} · capacity: ${config.maxViewers}`);
  log(
    config.uploadTimeoutMs
      ? `uploads: request timeout ${Math.round(config.uploadTimeoutMs / 1000)}s`
      : 'uploads: no request timeout (gigabyte uploads are expected)',
  );
});

const shutdown = (why = 'signal') => {
  log(`shutting down (${why})`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  if (usersTimer) clearTimeout(usersTimer);
  killAll();
  for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A bug in one request must not silently kill the whole party: log it, tell
// systemd it was a crash, and let Restart=always bring us back in a second.
process.on('uncaughtException', (err) => {
  log('FATAL uncaught:', err.stack || err.message);
  shutdown('uncaughtException');
  setTimeout(() => process.exit(1), 1500).unref();
});
process.on('unhandledRejection', (reason) => {
  log('FATAL unhandled rejection:', reason?.stack || String(reason));
  shutdown('unhandledRejection');
  setTimeout(() => process.exit(1), 1500).unref();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') log(`port ${config.port} is already in use — another instance running?`);
  else log('server error:', err.message);
  process.exit(1);
});
