import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createAuth } from '../server/auth.js';

test('password gates the app, media, actions and WebSocket connections', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-auth-'));
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const password = 'a shared password with spaces & symbols!';
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', PASSWORD: password,
      MEDIA_DIR: path.join(root, 'media'), CACHE_DIR: path.join(root, 'cache'), ENCODER: 'x264', MAX_VIEWERS: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    assert.equal(child.exitCode, null, logs);
    await sleep(50);
  }
  const login = (value, headers = {}) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password: value }),
  });
  const home = await fetch(base, { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');
  assert.match(await (await fetch(`${base}/login`)).text(), /type="password"/);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  for (const url of ['/api/library', '/api/session', '/media/abc123abc123/video.mp4',
    '/media/abc123abc123/hls/aaaaaaaaaaaaaaaaaaaa/index.m3u8', '/app.js', '/index.html', '/shared/sync.js']) {
    assert.equal((await fetch(base + url)).status, 401, url);
  }
  for (const [url, method] of [['/api/upload', 'POST'], ['/api/rescan', 'POST'], ['/api/media/abc123abc123', 'DELETE']]) {
    assert.equal((await fetch(base + url, { method })).status, 401, url);
  }
  for (const value of ['wrong', '', null, { password }]) assert.equal((await login(value)).status, 401);
  assert.equal((await login(password, { Origin: 'https://another.example' })).status, 403);
  const success = await login(password);
  assert.equal(success.status, 200);
  const setCookie = success.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  const headers = { Cookie: cookie };
  for (const url of ['/', '/api/library', '/api/session', '/vendor/hls.mjs']) {
    const response = await fetch(base + url, { headers });
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('cache-control'), /private/);
  }
  assert.equal((await fetch(`${base}/api/health`, { headers }).then(r => r.json())).capacity, 8);
  const secure = await login(password, { 'X-Forwarded-Proto': 'https' });
  assert.match(secure.headers.get('set-cookie'), /; Secure/i);
  assert.equal((await fetch(`${base}/api/rescan`, { method: 'POST', headers: { ...headers, Origin: 'https://another.example' } })).status, 403);

  const req = { headers: { cookie } };
  assert.ok(createAuth({ password, root }).authenticated(req), 'a restart preserves a valid session');
  assert.equal(createAuth({ password: 'changed', root }).authenticated(req), false, 'password changes invalidate sessions');
  const badCookie = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await fetch(`${base}/api/library`, { headers: { Cookie: badCookie } })).status, 401);
  const expired = `${Date.now() - 1000}.${'a'.repeat(32)}`;
  const key = crypto.createHash('sha256').update(password).digest();
  const signature = crypto.createHmac('sha256', key).update(expired).digest('base64url');
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: `anisync_session=${expired}.${signature}` } })).status, 401);

  async function rejectedSocket(wsHeaders) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: wsHeaders });
    ws.on('error', () => {});
    const status = await new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); });
      ws.once('open', () => { ws.close(); reject(new Error('Unauthenticated WebSocket opened')); });
      ws.once('error', reject);
    });
    assert.equal(status, 401);
  }
  await rejectedSocket({});
  await rejectedSocket({ ...headers, Origin: 'https://another.example' });
  const viewers = [];
  t.after(() => viewers.forEach(ws => ws.terminate()));
  for (let i = 1; i <= 8; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?name=Viewer${i}`, { headers });
    viewers.push(ws);
    const welcome = await new Promise((resolve, reject) => {
      ws.on('message', raw => {
        const message = JSON.parse(raw);
        if (message.t === 'welcome') resolve(message);
      });
      ws.once('error', reject);
    });
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.you.name, `Viewer${i}`);
    assert.equal(welcome.capacity, 8);
    assert.equal(welcome.users.length, i);
  }
  const extra = new WebSocket(`ws://127.0.0.1:${port}/ws?name=Ninth`, { headers });
  const rejected = JSON.parse((await once(extra, 'message'))[0]);
  assert.equal(rejected.code, 'full', 'the ninth viewer is refused');
  assert.equal((await once(extra, 'close'))[0], 4001);
  await Promise.all(viewers.map(ws => {
    const closed = once(ws, 'close');
    ws.close();
    return closed;
  }));

  for (let i = 0; i < 10; i++) assert.equal((await login('wrong')).status, 401);
  const limited = await login(password);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.has('retry-after'));
});
