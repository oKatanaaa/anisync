/** Real upload controls against an isolated server, with deterministic HTTP failures. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-upload-ui-'));
const free = http.createServer();
free.listen(0, '127.0.0.1');
await once(free, 'listening');
const port = free.address().port;
await new Promise((resolve) => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', MEDIA_DIR: path.join(root, 'media'),
    CACHE_DIR: path.join(root, 'cache'), ENCODER: 'x264' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { logs += data; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/library`)).ok) break; } catch { /* booting */ }
    assert.ok(i < 100 && server.exitCode === null, logs);
    await sleep(50);
  }
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.setRequestInterception(true);
  let requests = 0;
  let held = [];
  let hold = false;
  let networkFailure = false;
  let realUploads = false;
  page.on('request', async (request) => {
    try {
      if (request.url() !== `${base}/api/upload`) return await request.continue();
      requests += 1;
      if (realUploads) return await request.continue();
      if (networkFailure) return await request.abort('failed');
      if (hold) { held.push(request); return; }
      await request.respond({ status: requests <= 4 ? 400 : 200, contentType: 'application/json',
        body: JSON.stringify(requests <= 4 ? { error: 'unsupported file type' } : { ok: true, id: null }) });
    } catch { /* Closing the browser cancels pending requests. */ }
  });
  await page.goto(base);
  await page.type('#nameInput', 'Upload tester');
  await page.click('#joinForm button');
  await page.waitForFunction(() => document.getElementById('join').classList.contains('hidden'));
  await page.click('[data-tab="library"]');
  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = path.join(root, `Episode-${i}.ass`);
    await fs.writeFile(file, 'subtitle fixture');
    files.push(file);
  }
  await (await page.$('#uploadInput')).uploadFile(...files);
  await page.waitForFunction(() => [...document.querySelectorAll('.upload-phase')].filter((e) => e.textContent === 'Ready').length === 2,
    { timeout: 5000 });
  assert.equal(requests, 6, 'later files upload even when earlier files are rejected');
  assert.equal(await page.$$eval('.upload-phase', (phases) => phases.filter((e) => e.textContent === 'Failed').length), 4,
    'failed files remain visible for retry');
  console.log('PASS rejected uploads leave visible errors and the remaining batch continues');

  hold = true;
  // Retry four failed rows; only three may transfer at once.
  await page.$$eval('.upload-retry:not(.hidden)', (buttons) => buttons.forEach((b) => b.click()));
  await page.waitForFunction(() => [...document.querySelectorAll('.upload-phase')].filter((e) => e.textContent === 'Uploading').length === 3);
  assert.equal(await page.$$eval('.upload-phase', (phases) => phases.filter((e) => e.textContent === 'Queued').length), 1);
  // New files also wait while retries fill the transfer slots.
  const extra = path.join(root, 'Extra.ass');
  await fs.writeFile(extra, 'extra subtitles');
  await (await page.$('#uploadInput')).uploadFile(extra);
  await sleep(200);
  assert.equal(requests, 9, 'retries obey the three-transfer limit');
  hold = false;
  for (const request of held.splice(0)) await request.respond({ status: 200, contentType: 'application/json', body: '{"ok":true,"id":null}' });
  await page.waitForFunction(() => !document.querySelector('.upload-queue'), { timeout: 5000 });
  for (let i = 0; i < 100 && requests < 11; i++) await sleep(20);
  assert.equal(requests, 11, 'the queued retry and new file start after a retry finishes');
  console.log('PASS retry controls and subsequent uploads respect the concurrency limit');

  networkFailure = true;
  const cancelled = path.join(root, 'Cancelled.ass');
  await fs.writeFile(cancelled, 'cancelled subtitles');
  await (await page.$('#uploadInput')).uploadFile(cancelled);
  await page.waitForFunction(() => [...document.querySelectorAll('.upload-phase')].some((e) => e.textContent === 'Retrying'));
  await page.$$eval('.upload-row', (rows) => rows.find((row) => row.querySelector('.upload-name').textContent === 'Cancelled.ass').querySelector('.upload-cancel').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.upload-phase')].some((e) => e.textContent === 'Cancelled'));
  const afterCancel = requests;
  await sleep(1800);
  assert.equal(requests, afterCancel, 'cancelling during retry backoff prevents the scheduled retry');
  console.log('PASS cancellation during a connection retry takes effect immediately');

  realUploads = true;
  const video = path.join(root, 'Upload Demo.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { stdio: 'pipe' });
  await (await page.$('#uploadInput')).uploadFile(video);
  await page.waitForSelector('#library .card .btn.primary', { timeout: 15_000 });
  await page.$eval('#library .card .btn.primary', (button) => button.click());
  await page.waitForFunction(() => document.getElementById('video').readyState >= 3, { timeout: 15_000 });
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('video').currentTime > 0.5, { timeout: 15_000 });
  assert.deepEqual(await fs.readFile(path.join(root, 'media', 'Upload Demo.mp4')), await fs.readFile(video), 'uploaded video bytes stay intact');
  assert.deepEqual(errors, []);
  console.log('PASS a real video uploads, prepares, appears in the library, and plays through the controls');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  await fs.rm(root, { recursive: true, force: true });
}
