/** Password-to-room flow, including name entry before the app finishes loading. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-auth-ui-'));
const free = http.createServer();
free.listen(0, '127.0.0.1');
await once(free, 'listening');
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = 'browser test password';
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', PASSWORD: password,
    MEDIA_DIR: path.join(root, 'media'), CACHE_DIR: path.join(root, 'cache'), ENCODER: 'x264', MAX_VIEWERS: '8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs += data; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ }
    assert.ok(i < 100 && server.exitCode === null, logs);
    await sleep(50);
  }
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  let documents = 0;
  let delayApp = true;
  let playerRequests = 0;
  const held = [];
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && new URL(request.url()).pathname === '/') documents++;
    if (new URL(request.url()).pathname === '/vendor/hls.mjs') playerRequests++;
    if (delayApp && new URL(request.url()).pathname === '/app.js') held.push(request);
    else request.continue().catch(() => {});
  });
  await page.goto(`${base}/login`);
  await page.type('#password', password);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#nameInput', { visible: true });
  for (let i = 0; !held.length; i++) {
    assert.ok(i < 100, 'app download was intercepted');
    await sleep(20);
  }
  assert.equal(await page.evaluate(() => Boolean(window.__sync)), false, 'the app is still loading');
  assert.equal(await page.$eval('#nameInput', input => input.disabled), false, 'name entry is available immediately');
  // This used to submit a native GET and reload the nickname screen.
  await page.focus('#nameInput');
  await page.keyboard.type('First viewer');
  await page.keyboard.press('Enter');
  await sleep(300);
  assert.equal(documents, 1, 'Enter during startup must not reload the page');
  await page.click('#joinForm button');
  await sleep(300);
  assert.equal(documents, 1, 'clicking during startup must not reload the page');
  assert.equal(await page.$eval('#joinForm button', button => button.disabled), true);
  assert.match(await page.$eval('#joinForm button', button => button.textContent), /Loading/);

  delayApp = false;
  await Promise.all(held.splice(0).map(request => request.continue()));
  await page.waitForFunction(() => window.__sync && !document.getElementById('nameInput').disabled);
  assert.equal(await page.$eval('#nameInput', input => input.value), 'First viewer', 'app startup preserves the name already typed');
  assert.equal(playerRequests, 0, 'the player library does not delay nickname entry');
  await page.focus('#nameInput');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('join').classList.contains('hidden') && window.__sync.snapshot().users === 1);
  assert.equal(documents, 1, 'one nickname submission joins without navigation');
  assert.equal(await page.evaluate(() => localStorage.getItem('anisync:name')), 'First viewer');
  assert.match(await page.$eval('#people', people => people.textContent), /First viewer/);
  assert.equal(await page.$eval('#roomChip', chip => chip.textContent), '1 / 8 seats');
  assert.equal(playerRequests, 0, 'an empty room does not download the player library');
  console.log('PASS immediate name entry survives delayed startup and joins without waiting for the player library');

  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.$eval('#nameInput', input => input.value), 'First viewer', 'reload prefills the remembered name');
  await page.focus('#nameInput');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('join').classList.contains('hidden') && window.__sync.snapshot().users === 1);
  assert.deepEqual(errors, []);
  console.log('PASS returning viewers keep their nickname and rejoin with Enter');
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  await fs.rm(root, { recursive: true, force: true });
}
