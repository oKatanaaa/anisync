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
import { detectEncoder } from './ffmpeg.js';

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

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

const library = new Library({
  onEvent: (evt) => {
    if (evt.type === 'progress') broadcast({ t: 'progress', id: evt.id, progress: evt.progress, stage: evt.stage });
    if (evt.type === 'prepared') broadcast({ t: 'library' });
    if (evt.type === 'failed') broadcast({ t: 'notice', level: 'error', text: `Prepare failed: ${evt.message}` });
  },
});

const room = new Room({
  maxViewers: config.maxViewers,
  startDelayMs: config.startDelayMs,
  seekDelayMs: config.seekDelayMs,
  onEvent: (type, payload) => {
    if (type === 'state') broadcast({ t: 'state', ...payload });
    if (type === 'users') broadcast({ t: 'users', users: payload });
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
    uptime: Math.round(process.uptime()),
  });
});

app.get('/api/library', (_req, res) => {
  res.json({ media: library.list(), room: room.snapshot() });
});

app.post('/api/rescan', async (_req, res, next) => {
  try {
    await library.scan();
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
    library.prepare(item.id).catch((err) => log('prepare failed:', err.message));
    res.status(202).json({ ok: true, id: item.id });
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

  bus.on('file', (_field, file, info) => {
    const safe = path.basename(info.filename).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180);
    if (!/\.(mkv|mp4|webm|avi|mov|m4v|ts)$/i.test(safe)) {
      failure = 'unsupported file type';
      file.resume();
      return;
    }
    const dest = path.join(config.mediaDir, safe);
    savedPath = dest;
    const out = fs.createWriteStream(dest);
    file.pipe(out);
    file.on('limit', () => {
      tooBig = true;
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
    });
    file.on('error', () => out.destroy());
  });

  bus.on('close', async () => {
    if (failure) return res.status(400).json({ error: failure });
    if (tooBig) return res.status(413).json({ error: 'file too large' });
    if (!savedPath) return res.status(400).json({ error: 'no file received' });
    await library.scan();
    const item = [...library.items.values()].find((i) => i.path === savedPath);
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
  res.sendFile(file, { headers, acceptRanges: true, cacheControl: false });
};

app.get('/media/:id/video.mp4', (req, res) => {
  if (!isMediaId(req.params.id)) return res.status(400).end();
  sendIfExists(res, path.join(config.cacheDir, req.params.id, 'video.mp4'), { 'Cache-Control': 'public, max-age=0' });
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
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Guest';

wss.on('connection', (ws, url) => {
  if (room.full) {
    send(ws, { t: 'rejected', code: 'full', message: `Room is full (${room.maxViewers} people).` });
    return ws.close(4001, 'room full');
  }

  const user = { id: crypto.randomUUID().slice(0, 8), name: cleanName(url.searchParams.get('name')) };
  clients.set(ws, { user, alive: true });

  const joined = room.join(user);
  if (!joined.ok) {
    send(ws, { t: 'rejected', code: 'full', message: 'Room is full.' });
    return ws.close(4001, 'room full');
  }

  send(ws, {
    t: 'welcome',
    you: { id: user.id, name: user.name, isHost: joined.user.isHost },
    ...room.snapshot(),
    media: room.media ? library.list().find((m) => m.id === room.media.id) ?? room.media : null,
  });

  ws.on('pong', () => {
    const entry = clients.get(ws);
    if (entry) entry.alive = true;
  });

  // One malformed or unexpected message must never take the room down with it:
  // a crash here disconnects everyone mid-episode.
  ws.on('message', (raw) => {
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await library.ensureDirs();
await library.scan();
log(`library: ${library.items.size} file(s) in ${config.mediaDir}`);

server.listen(config.port, config.bind, async () => {
  log(`anime-sync listening on http://${config.bind}:${config.port}`);
  log(`encoder: ${await detectEncoder(config.encoder)} · capacity: ${config.maxViewers}`);
});

const shutdown = () => {
  log('shutting down');
  clearInterval(heartbeat);
  for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
