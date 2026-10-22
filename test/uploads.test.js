import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

async function startServer(t, { maxUploadBytes = 1024 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-uploads-'));
  const media = path.join(root, 'media');
  await fs.mkdir(media);
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', MEDIA_DIR: media,
      CACHE_DIR: path.join(root, 'cache'), ENCODER: 'x264', MAX_UPLOAD_BYTES: String(maxUploadBytes) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try { if ((await fetch(`${base}/api/library`)).ok) break; } catch { /* booting */ }
    assert.ok(child.exitCode === null && Date.now() < deadline, logs || 'server failed to start');
    await sleep(30);
  }
  const begin = (name) => {
    const req = http.request(`${base}/api/upload`, { method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=upload-test',
    } });
    const response = new Promise((resolve) => {
      req.on('response', async (res) => {
        let body = '';
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode, body });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.setTimeout(5000, () => req.destroy());
    });
    const filename = name === null ? '' : `; filename="${name}"`;
    req.write(`--upload-test\r\nContent-Disposition: form-data; name="file"${filename}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    return { req, response };
  };
  const upload = async (name, bytes, { complete = true } = {}) => {
    const { req, response } = begin(name);
    req.write(bytes);
    req.end(complete ? '\r\n--upload-test--\r\n' : '');
    return response;
  };
  const waitForPart = async () => {
    for (let i = 0; i < 100; i++) {
      if ((await fs.readdir(media)).some((name) => name.endsWith('.part'))) return;
      await sleep(20);
    }
    assert.fail(`upload never started: ${logs}`);
  };
  return { media, cache: path.join(root, 'cache'), base, begin, upload, waitForPart };
}

test('simultaneous uploads with the same name cannot mix or delete each other', async (t) => {
  const s = await startServer(t);
  const first = s.begin('Episode.en.ass');
  first.req.write('first ');
  await s.waitForPart();
  const second = await s.upload('Episode.en.ass', 'second');
  first.req.end('complete\r\n--upload-test--\r\n');
  const result = await first.response;
  assert.equal(second.status, 409, 'a conflicting transfer gets an actionable error');
  assert.equal(result.status, 200, result.body);
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.en.ass'), 'utf8'), 'first complete');
  assert.deepEqual(await fs.readdir(s.media), ['Episode.en.ass']);
});

test('a truncated multipart replacement preserves the previous file and the server stays available', async (t) => {
  const s = await startServer(t);
  const file = path.join(s.media, 'Episode.en.ass');
  await fs.writeFile(file, 'original subtitles');
  const result = await s.upload('Episode.en.ass', 'incomplete replacement', { complete: false });
  assert.equal(result.status, 400, 'malformed uploads are rejected without dropping the connection');
  assert.equal(await fs.readFile(file, 'utf8'), 'original subtitles');
  assert.deepEqual(await fs.readdir(s.media), ['Episode.en.ass']);
  assert.equal((await fetch(`${s.base}/api/library`)).status, 200);
});

test('upload validation and successful replacement leave only complete files', async (t) => {
  const s = await startServer(t);
  await fs.writeFile(path.join(s.media, 'Episode.en.ass'), 'original');
  assert.equal((await s.upload('Episode.en.ass', 'x'.repeat(1025))).status, 413);
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.en.ass'), 'utf8'), 'original');
  assert.equal((await s.upload('bad.exe', 'invalid')).status, 400);
  assert.equal((await s.upload(null, 'missing filename')).status, 400);
  assert.equal((await s.upload('Episode.en.ass', 'complete replacement')).status, 200);
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.en.ass'), 'utf8'), 'complete replacement');
  assert.deepEqual(await fs.readdir(s.media), ['Episode.en.ass']);
});

test('an upload that cannot be saved reports an error and does not leave partial files', async (t) => {
  const s = await startServer(t);
  await fs.mkdir(path.join(s.media, 'Episode.en.ass'));
  assert.equal((await s.upload('Episode.en.ass', 'subtitles')).status, 500);
  assert.deepEqual(await fs.readdir(s.media), ['Episode.en.ass']);
  assert.equal((await s.upload('Other.en.ass', 'valid subtitles')).status, 200);
});

test('finishing the file bytes does not replace an episode before the entire form is valid', async (t) => {
  const s = await startServer(t);
  const file = path.join(s.media, 'Episode.en.ass');
  await fs.writeFile(file, 'original subtitles');
  const transfer = s.begin('Episode.en.ass');
  transfer.req.write('replacement\r\n--upload-test\r\nContent-Disposition: form-data; name="note"\r\n\r\nunfinished field');
  await s.waitForPart();
  await sleep(40);
  assert.equal(await fs.readFile(file, 'utf8'), 'original subtitles');
  transfer.req.end();
  assert.equal((await transfer.response).status, 400);
  assert.equal(await fs.readFile(file, 'utf8'), 'original subtitles');
  assert.deepEqual(await fs.readdir(s.media), ['Episode.en.ass']);
});

test('different uploads finish independently and a rescan does not remove a live transfer', async (t) => {
  const s = await startServer(t);
  const first = s.begin('Episode.en.ass');
  first.req.write('first ');
  await s.waitForPart();
  assert.equal((await s.upload('Episode.ja.ass', 'second complete')).status, 200);
  assert.equal((await fetch(`${s.base}/api/rescan`, { method: 'POST' })).status, 200);
  first.req.end('complete\r\n--upload-test--\r\n');
  assert.equal((await first.response).status, 200);
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.en.ass'), 'utf8'), 'first complete');
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.ja.ass'), 'utf8'), 'second complete');
  assert.deepEqual((await fs.readdir(s.media)).sort(), ['Episode.en.ass', 'Episode.ja.ass']);
});

test('cancelling an upload releases its name for a retry and removes partial bytes', async (t) => {
  const s = await startServer(t);
  const first = s.begin('Episode.en.ass');
  first.req.write('partial subtitles');
  await s.waitForPart();
  first.req.destroy();
  await first.response;
  for (let i = 0; i < 100 && (await fs.readdir(s.media)).length; i++) await sleep(20);
  assert.deepEqual(await fs.readdir(s.media), []);
  assert.equal((await s.upload('Episode.en.ass', 'retry complete')).status, 200);
  assert.equal(await fs.readFile(path.join(s.media, 'Episode.en.ass'), 'utf8'), 'retry complete');
});

test('a video uploaded during a rescan appears in the library and starts preparing', async (t) => {
  const s = await startServer(t, { maxUploadBytes: 1024 * 1024 });
  const seed = path.join(s.media, 'Seed.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', seed], { stdio: 'pipe' });
  // Keep a real library scan busy probing existing episodes while the new one arrives.
  for (let i = 0; i < 80; i++) await fs.copyFile(seed, path.join(s.media, `Existing-${i}.mp4`));
  const rescanning = fetch(`${s.base}/api/rescan`, { method: 'POST' });
  let scanning = false;
  for (let i = 0; i < 200; i++) {
    const probes = (await fs.readdir(s.cache)).filter((name) => /^[a-f0-9]{12}$/.test(name)).length;
    if (probes > 0 && probes < 81) { scanning = true; break; }
    await sleep(10);
  }
  assert.ok(scanning, 'the upload overlaps probing of the existing library');
  const result = await s.upload('New Episode.mp4', await fs.readFile(seed));
  await rescanning;
  assert.equal(result.status, 200, result.body);
  const id = JSON.parse(result.body).id;
  assert.ok(id, 'a video must not be mistaken for a sidecar because a previous scan missed it');
  const { media } = await (await fetch(`${s.base}/api/library`)).json();
  const uploaded = media.find((item) => item.id === id);
  assert.ok(uploaded?.prepared || uploaded?.preparing, 'the episode is visible and preparation has started');
});
