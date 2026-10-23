/** Self-contained real-browser regression: no production server or media needed. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-playback-'));
const output = process.env.PLAYBACK_TEST_OUT || temp;
await fs.mkdir(output, { recursive: true });
const media = path.join(temp, 'media');
await fs.mkdir(media);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
  throw new Error(`Timed out: ${message}`);
}
const free = http.createServer();
await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
const port = free.address().port;
await new Promise((resolve) => free.close(resolve));
const base = `http://127.0.0.1:${port}`;
const browsers = [];
const errors = [];
let logs = '';
let server;
let proxy;
let bytesPerSecond = 400 * 1024;
let delaySource = false;
let forceFallback = false;
let failVideoOnce = false;
let segmentRequests = 0;

try {
  const captions = path.join(temp, 'captions.srt');
  await fs.writeFile(captions, '1\n00:00:00,000 --> 00:01:29,000\nBuffering regression captions\n');
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880',
    '-i', captions, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:s', 'srt', '-t', '90',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2200k', '-minrate', '2200k',
    '-maxrate', '2200k', '-bufsize', '4400k', '-x264-params', 'nal-hrd=cbr', '-g', '24',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:s:0', 'language=eng',
    path.join(media, 'Buffer Episode - 01.mkv'),
  ], { timeout: 90_000, stdio: 'pipe' });
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', MEDIA_DIR: media,
      CACHE_DIR: path.join(temp, 'cache'), ENCODER: 'x264', SUBTITLES: 'track', MAX_VIDEO_KBPS: '0', X264_PRESET: 'veryfast' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { logs = (logs + data).slice(-20_000); });
  await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'test server');
  const library = async () => (await (await fetch(`${base}/api/library`)).json()).media[0];
  const id = (await library()).id;
  const prepare = async (body) => {
    await fetch(`${base}/api/media/${id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  };
  await prepare({});
  await until(async () => (await library()).prepared, 'main rendition', 120_000);

  // Pace actual HLS bytes independently of WebSocket traffic. Zero pauses delivery.
  proxy = http.createServer(async (req, res) => {
    try {
      const upstream = await fetch(base + req.url);
      const body = new Uint8Array(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type'),
        'Content-Length': body.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      for (let offset = 0; offset < body.length && !res.destroyed;) {
        if (bytesPerSecond === 0) { await sleep(30); continue; }
        const chunk = body.subarray(offset, offset + 8192);
        res.write(chunk); offset += chunk.length;
        await sleep(chunk.length / bytesPerSecond * 1000);
      }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const viewer = async (name, throttled = false) => {
    const browser = await puppeteer.launch({ executablePath, headless: true, args: [
      '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    ] });
    browsers.push(browser);
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    await page.setCacheEnabled(false);
    await page.evaluateOnNewDocument(() => {
      window.seekWrites = [];
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...descriptor, set(to) {
        if (this.id === 'video') window.seekWrites.push({ at: performance.now(), from: descriptor.get.call(this), to });
        descriptor.set.call(this, to);
      } });
    });
    if (throttled) {
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        try {
          if (forceFallback && request.url().includes('/stream?')) return await request.respond({ status: 503, contentType: 'application/json', body: '{}' });
          if (failVideoOnce && /\/video\.mp4\?/.test(request.url())) {
            failVideoOnce = false;
            return await request.respond({ status: 503, body: '' });
          }
          if (delaySource && request.url().includes('/stream?')) { delaySource = false; await sleep(1800); }
          if (/\/hls\/.+\/segment-\d+\.m4s/.test(request.url())) {
            segmentRequests += 1;
            return await request.continue({ url: request.url().replace(`:${port}`, `:${proxyPort}`) });
          }
          await request.continue();
        } catch { /* Rapid source swaps intentionally cancel requests. */ }
      });
    }
    await page.goto(base);
    await page.type('#nameInput', name);
    await page.click('#joinForm button');
    await page.waitForFunction(() => window.__sync?.snapshot().users > 0, { timeout: 10_000 });
    return page;
  };
  const a = await viewer('Ana');
  const b = await viewer('Ben', true);
  const snapshot = (page) => page.evaluate(() => window.__sync.snapshot());
  const click = (page, selector) => page.$eval(selector, (element) => element.click());
  await a.click('[data-tab="library"]');
  await a.waitForSelector('.card-encode:not([disabled])');
  // A failed request must leave a retry, without opening the episode.
  let rejectEncode = true;
  await a.setRequestInterception(true);
  a.on('request', async (request) => {
    try {
      if (rejectEncode && request.url().endsWith(`/api/media/${id}/prepare`)) {
        rejectEncode = false;
        return await request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Encoder unavailable"}' });
      }
      await request.continue();
    } catch { /* Source switches can cancel requests. */ }
  });
  await a.locator('.card-encode').click();
  await a.waitForFunction(() => document.getElementById('toasts').textContent.includes('Encoder unavailable') && !document.querySelector('.card-encode').disabled);
  await a.locator('.card-encode').click();
  assert.equal(await a.$eval('.card-encode', (button) => button.disabled), true);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).room.state.mediaId, null, 'encoding must not select the episode');
  const deletingDuringEncode = await fetch(`${base}/api/media/${id}`, { method: 'DELETE' });
  assert.equal(deletingDuringEncode.status, 409, 'an alternate-quality encode blocks permanent deletion');
  assert.equal(await fs.stat(path.join(media, 'Buffer Episode - 01.mkv')).then(() => true, () => false), true, 'encoding source is preserved');
  await until(async () => (await library()).qualities.find((q) => q.height === 720)?.ready, '720p rendition from the card', 120_000);
  await a.waitForFunction(() => document.querySelector('.card-encode')?.textContent === '720p ready');
  assert.equal(await a.$eval('.card-encode', (button) => button.disabled), true, 'a ready copy cannot be queued again');
  await b.click('[data-tab="library"]');
  await b.waitForFunction(() => document.querySelector('.card-encode')?.textContent === '720p ready');
  assert.equal(await a.$$eval('#library .btn', (buttons) => buttons.some((b) => b.textContent === 'Play')), false);
  // The real pointer hits the card overlay when clicking its title.
  await a.click('#library .card .title');
  assert.equal(await a.$eval('.tab.active', (tab) => tab.dataset.tab), 'chat');
  console.log('PASS card encoding retries, builds 720p without selecting media, and updates both viewers; clicking the card opens playback');
  await until(async () => (await snapshot(a)).readyState >= 3 && (await snapshot(b)).readyState >= 3, 'decoded video');
  await click(a, '#playBtn');
  await until(async () => !(await snapshot(b)).buffering && (await snapshot(b)).currentTime > 0.5, 'coordinated start', 45_000);
  assert.equal((await snapshot(b)).managedBuffer, true);
  console.log('PASS both viewers start with a managed buffer');

  bytesPerSecond = 0;
  const beforeOutage = await snapshot(b);
  await sleep(4000);
  assert.equal((await snapshot(b)).buffering, false, 'the reserve absorbs a short delivery outage');
  await until(async () => (await snapshot(b)).buffering, 'shared pause after buffer exhaustion', 35_000);
  const held = await snapshot(b);
  await sleep(1800);
  const [heldA, heldB] = await Promise.all([snapshot(a), snapshot(b)]);
  assert.ok(Math.abs(heldA.expected - held.expected) < 0.01, 'the room clock freezes');
  assert.ok(Math.abs(heldA.currentTime - heldB.currentTime) < 0.4, 'viewers wait at the same point');
  const writes = await b.evaluate(() => window.seekWrites);
  assert.ok(writes.every((write) => write.to - write.from < 1), 'no repeated jumps to unbuffered future video');
  await b.screenshot({ path: path.join(output, 'buffering-together.png') });
  bytesPerSecond = 16 * 1024 * 1024;
  await until(async () => !(await snapshot(b)).buffering && (await snapshot(b)).currentTime > held.expected + 1, 'refill and shared recovery');
  assert.ok(Math.abs((await snapshot(a)).currentTime - (await snapshot(b)).currentTime) < 0.4);
  console.log('PASS a real delivery outage pauses the room, refills, and resumes without seek chasing');

  await click(a, '#playBtn');
  await a.$eval('#seek', (element) => { element.value = '35'; element.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(async () => Math.abs((await snapshot(b)).currentTime - 35) < 0.3, 'paused midpoint seek');
  const choose = async (height) => b.evaluate((height) => {
    document.getElementById('qualityBtn').click();
    [...document.querySelectorAll('#qualityList button')].find((button) => button.textContent.includes(`${height}p`)).click();
  }, height);
  bytesPerSecond = 400 * 1024;
  await choose(720);
  await until(async () => { const s = await snapshot(b); return s.quality === 720 && !s.sourceLoading && s.readyState >= 3 && Math.abs(s.currentTime - 35) < 0.3; }, '720p preserves paused position');
  assert.ok(Math.abs((await snapshot(a)).currentTime - 35) < 0.3);
  await click(a, '#playBtn');
  await until(async () => !(await snapshot(b)).buffering && (await snapshot(b)).currentTime > 35.5, 'resume at 720p');
  bytesPerSecond = 0;
  await until(async () => (await snapshot(b)).buffering, '720p also coordinates an exhausted buffer', 35_000);
  const held720 = await snapshot(b);
  await sleep(1200);
  assert.ok(Math.abs((await snapshot(a)).expected - held720.expected) < 0.01);
  bytesPerSecond = 16 * 1024 * 1024;
  await until(async () => !(await snapshot(b)).buffering && (await snapshot(b)).currentTime > held720.expected + 0.5, '720p recovery');
  console.log('PASS the same delivery-outage recovery works at 720p');
  delaySource = true;
  await choose(1080);
  await until(async () => { const s = await snapshot(b); return s.quality === 1080 && !s.sourceLoading && !s.buffering && s.readyState >= 3; }, 'delayed return to 1080p');
  assert.ok((await snapshot(b)).currentTime > 35);
  assert.ok((await snapshot(a)).currentTime > 35);
  console.log('PASS 1080p/720p switches and delayed metadata preserve both viewers at mid-episode');

  await click(a, '#playBtn');
  await choose(720); await choose(1080); await choose(720);
  await until(async () => { const s = await snapshot(b); return s.quality === 720 && !s.sourceLoading && s.readyState >= 3; }, 'rapid source swaps');
  assert.ok((await snapshot(b)).currentTime > 35);
  await until(() => b.evaluate(() => {
    const track = document.getElementById('video').textTracks[0];
    return track?.mode === 'showing' && track.cues?.length > 0;
  }), 'soft subtitles survive source swaps');
  const beforeSubtitles = (await snapshot(b)).currentTime;
  await b.evaluate(() => {
    document.getElementById('subsBtn').click();
    [...document.querySelectorAll('#subList button')].find((button) => button.textContent.includes('Off')).click();
  });
  assert.equal(await b.$eval('#video', (video) => video.textTracks.length), 0);
  assert.ok(Math.abs((await snapshot(b)).currentTime - beforeSubtitles) < 0.3);
  await b.evaluate(() => {
    document.getElementById('subsBtn').click();
    [...document.querySelectorAll('#subList button')].find((button) => !button.textContent.includes('Off')).click();
  });
  await until(() => b.evaluate(() => document.getElementById('video').textTracks[0]?.mode === 'showing'), 'subtitles enabled again');
  await b.evaluate(() => {
    document.getElementById('subsBtn').click();
    [...document.querySelectorAll('#audioList button')].find((button) => button.textContent.includes('Japanese')).click();
  });
  const beforeAudio = (await snapshot(b)).currentTime;
  await click(a, '#playBtn');
  await until(async () => { const s = await snapshot(b); return s.playing && !s.buffering && s.audioTrack === 1 && s.managedBuffer && s.currentTime > beforeAudio + 0.5; }, 'alternate audio buffering');
  const audioGap = await b.evaluate(() => Math.abs(document.getElementById('altAudio').currentTime - document.getElementById('video').currentTime));
  assert.ok(audioGap < 0.3, `alternate audio gap ${audioGap}`);
  console.log('PASS rapid swaps, soft subtitles, and managed alternate audio');

  forceFallback = true;
  failVideoOnce = true;
  const beforeFallback = (await snapshot(b)).currentTime;
  await choose(1080);
  await until(async () => { const s = await snapshot(b); return !s.managedBuffer && !s.sourceLoading && !s.buffering && s.currentTime > beforeFallback + 0.5; }, 'MP4 fallback');
  console.log('PASS segmented-playback fallback and a failed MP4 request recover at the current position');

  await a.$eval('#seek', (element) => { element.value = '87'; element.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(async () => {
    const [sa, sb] = await Promise.all([snapshot(a), snapshot(b)]);
    return !sa.playing && !sb.playing && sa.currentTime > 89 && sb.currentTime > 89;
  }, 'the final frame pauses both viewers');
  await click(a, '#playBtn');
  await until(async () => {
    const [sa, sb] = await Promise.all([snapshot(a), snapshot(b)]);
    return sa.playing && sb.playing && !sa.buffering && !sb.buffering && sa.currentTime > 0.5 && sb.currentTime > 0.5;
  }, 'replay starts both viewers');
  // An already queued event can arrive after a seek has cleared video.ended.
  await b.$eval('#video', (video) => video.dispatchEvent(new Event('ended')));
  await sleep(700);
  const replay = await snapshot(b);
  assert.equal(replay.playing, true, 'a delayed end event must not stop the replay');
  assert.ok(replay.currentTime < 10, `replay stays near the start, got ${replay.currentTime}`);
  assert.equal(await b.$eval('#syncBadge', (badge) => badge.textContent.includes('finished')), false);
  console.log('PASS the final frame pauses everyone, replay restarts together, and stale end events are ignored');

  assert.deepEqual(errors, [], 'browser console stays clean');
  await fs.writeFile(path.join(output, 'playback-result.json'), JSON.stringify({ beforeOutage, held, heldA, heldB, held720, writes, segmentRequests, final: await snapshot(b), audioGap }, null, 2));
  console.log(`Playback regression passed. Evidence: ${output}`);
} catch (error) {
  console.error(error.stack);
  console.error(logs);
  throw error;
} finally {
  for (const browser of browsers) await browser.close();
  if (proxy) { proxy.closeAllConnections(); proxy.close(); }
  server?.kill();
}
