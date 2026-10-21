/**
 * User-facing behaviour suite: every check drives the real UI in a real browser
 * and asserts on what a person would see. Run with:
 *
 *   node test/ui.mjs                 # everything
 *   node test/ui.mjs end-of-episode  # scenarios whose name matches
 *
 * Each scenario gets its own browser context, so localStorage, cookies and the
 * room are the only state that can leak. Failures save a screenshot to /tmp/qa.
 */
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const OUT = '/tmp/qa';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const filter = process.argv[2] || '';
const DEMO = 'Demo Episode';

const LAUNCH_ARGS = [
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--no-sandbox',
];

/**
 * These scenarios assert on room state (host, lock, seat counts), which is
 * global: a real person with the player open makes them fail in confusing ways.
 * Say so once instead of reporting eleven bogus failures.
 */
if (!filter) {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (health.viewers > 0) {
    console.error(
      `\nThe room has ${health.viewers} viewer(s) connected.\n` +
        `This suite asserts on room state and needs an empty room — close the player tab\n` +
        `(or run a filtered scenario, e.g. npm run test:ui -- upload) and try again.\n`,
    );
    process.exit(2);
  }
}

/**
 * The suite assumes the demo episode is ready to play. A wiped cache is a normal
 * state for this app, so make sure rather than failing 40 checks with a timeout.
 */
{
  const lib = await (await fetch(`${BASE}/api/library`)).json();
  const demo = (lib.media || []).find((m) => m.title.includes(DEMO));
  if (demo && !demo.prepared) {
    await fetch(`${BASE}/api/media/${demo.id}/prepare`, { method: 'POST' });
    for (let i = 0; i < 240; i += 1) {
      const now = await (await fetch(`${BASE}/api/library`)).json();
      if ((now.media || []).find((m) => m.id === demo.id)?.prepared) break;
      await sleep(500);
    }
  }
}

const results = [];
const cleanups = [];
/** Expected failures, e.g. the 409 a scenario provokes on purpose. */
const allowedErrors = [];
let current = 'setup';
let shotN = 0;
let ctx = null;
const pages = [];

function check(name, ok, detail = '', page = null) {
  results.push({ scenario: current, name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && page) {
    const file = `${OUT}/${String(++shotN).padStart(2, '0')}-${current.replace(/[^a-z0-9]+/gi, '-')}.png`;
    page.screenshot({ path: file }).catch(() => {});
    console.log(`        ↳ screenshot ${file}`);
  }
  return ok;
}

const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });

async function newPage({ width = 1280, height = 800 } = {}) {
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.__errors = [];
  page.on('pageerror', (err) => page.__errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') page.__errors.push(`console: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) page.__errors.push(`http ${res.status()}: ${res.url()}`);
  });
  pages.push(page);
  return page;
}

/**
 * A page in its own browser process. Chrome refuses to buffer video in a
 * backgrounded tab, so three viewers sharing one browser would measure the
 * backgrounding heuristic instead of the sync engine.
 */
async function newSoloPage(name, { width = 1280, height = 800 } = {}) {
  const solo = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  const page = await solo.newPage();
  await page.setViewport({ width, height });
  page.__errors = [];
  page.on('pageerror', (err) => page.__errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') page.__errors.push(`console: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) page.__errors.push(`http ${res.status()}: ${res.url()}`);
  });
  page.__browser = solo;
  pages.push(page);
  await join(page, name);
  return page;
}

/** The real join flow: type a name into the modal and submit it. */
async function join(page, name) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nameInput', { polling: 50, timeout: 15000 });
  if (name !== null) {
    await page.evaluate((n) => {
      document.getElementById('nameInput').value = n;
      document.querySelector('#joinForm button[type=submit]').click();
    }, name);
  }
  await page.waitForFunction(
    () => document.getElementById('join').classList.contains('hidden') && window.__sync?.snapshot().users > 0,
    { polling: 50, timeout: 20000 },
  );
  await sleep(350); // let the first clock samples land
  return page;
}

const snap = (page) => page.evaluate(() => window.__sync.snapshot());
const pos = (page) => page.evaluate(() => document.getElementById('video').currentTime);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

/** Visible in the sense a person means it — the fixed modal has no offsetParent. */
const visible = (page, sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n || n.classList.contains('hidden')) return false;
    const style = getComputedStyle(n);
    const box = n.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && box.width > 1 && box.height > 1;
  }, sel);

const tip = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));

async function waitFor(page, fn, timeout = 12000, label = 'condition', arg) {
  try {
    await page.waitForFunction(fn, { polling: 50, timeout }, arg);
    return true;
  } catch {
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
}

async function viewers() {
  const res = await fetch(`${BASE}/api/health`);
  return (await res.json()).viewers;
}

/** Load the demo episode through the library UI and leave the room paused at 0. */
async function openEpisode(page, titlePart = DEMO) {
  await click(page, '.tab[data-tab=library]');
  const found = await waitFor(
    page,
    (t) => [...document.querySelectorAll('#library .card')].some((c) => c.textContent.includes(t) && c.querySelector('.btn.primary')),
    15000,
    'episode card',
    titlePart,
  );
  if (!found) return false;
  await page.evaluate((t) => {
    const card = [...document.querySelectorAll('#library .card')].find((c) => c.textContent.includes(t));
    card.querySelector('.btn.primary').click();
  }, titlePart);

  const loaded = await waitFor(
    page,
    (t) => {
      const s = window.__sync.snapshot();
      return s.readyState >= 1 && !s.playing && document.getElementById('stageTag').textContent.includes(t);
    },
    25000,
    'media ready',
    titlePart,
  );
  await sleep(300);
  return loaded;
}

async function seekTo(page, seconds) {
  await page.evaluate((s) => {
    const seek = document.getElementById('seek');
    seek.value = String(s);
    seek.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
}

async function closeAll() {
  while (pages.length) {
    const page = pages.pop();
    if (!page.isClosed()) await page.close().catch(() => {});
    if (page.__browser) await page.__browser.close().catch(() => {});
  }
  for (let i = 0; i < 60; i++) {
    try {
      if ((await viewers()) === 0) return;
    } catch { /* server restarting */ }
    await sleep(250);
  }
}

async function scenario(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  current = name;
  // Allowances belong to the scenario that declared them, not to every later one.
  allowedErrors.length = 0;
  console.log(`\n▶ ${name}`);
  ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());

  // Start each scenario from an empty room so seat limits and media never leak.
  try {
    await fn();
  } catch (err) {
    check('scenario completed without throwing', false, err.message, pages.at(-1));
  }

  for (const page of pages) {
    if (page.isClosed()) continue;
    const errs = page.__errors.filter(
      (e) =>
        !/favicon|net::ERR_ABORTED|net::ERR_CONNECTION_REFUSED/.test(e) &&
        // Scenarios that deliberately break a URL declare the failure they expect.
        !allowedErrors.some((pattern) => pattern.test(e)),
    );
    if (errs.length) check('browser console stays clean', false, errs.slice(0, 3).join(' | '), page);
  }

  await closeAll();
  // Tear-down runs with no pages open, so deleting fixtures cannot produce
  // spurious 404s in a client that is still holding the old URL.
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch (err) {
      console.log(`  (cleanup failed: ${err.message})`);
    }
  }
  await ctx.close().catch(() => {});
  ctx = null;
}

// ---------------------------------------------------------------------------

await scenario('join flow and presence', async () => {
  const a = await join(await newPage(), 'Aiko');

  check('room starts when the first person joins', (await snap(a)).users === 1, '', a);
  check('seats chip reads 1 / 3', (await text(a, '#roomChip')) === '1 / 3 seats', await text(a, '#roomChip'), a);
  check(
    'welcome notice appears exactly once',
    (await a.evaluate(
      () => [...document.querySelectorAll('#messages .msg.system')].filter((m) => /Aiko joined/.test(m.textContent)).length,
    )) === 1,
    '',
    a,
  );
  await click(a, '.tab[data-tab=people]');
  await sleep(200);
  const people = await text(a, '#people');
  check('name shows in the People tab', people.includes('Aiko'), people?.slice(0, 60), a);
  check('you are marked as host', people.includes('host'), people?.slice(0, 60), a);
  check(
    'round-trip time reaches the roster',
    await waitFor(a, () => /\d+ ms round trip/.test(document.getElementById('people').textContent), 6000, 'rtt'),
    '',
    a,
  );
  check('lock button is enabled for the host', await a.evaluate(() => !document.getElementById('lockBtn').disabled), '', a);
});

await scenario('name handling', async () => {
  const a = await newPage();
  await a.goto(BASE, { waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#nameInput', { polling: 50 });

  await a.evaluate(() => {
    document.getElementById('nameInput').value = '   ';
    document.querySelector('#joinForm button[type=submit]').click();
  });
  await sleep(400);
  check('blank name stays on the join screen', await visible(a, '#join'), '', a);
  check('blank name is not stored', (await a.evaluate(() => localStorage.getItem('anisync:name'))) === null, '', a);
  check('nothing connected with a blank name', (await viewers()) === 0, '', a);

  await join(a, 'Bela');
  check('join modal disappears', !(await visible(a, '#join')), '', a);
  check('name is remembered for next time', (await a.evaluate(() => localStorage.getItem('anisync:name'))) === 'Bela', '', a);

  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#nameInput', { polling: 50 });
  check('saved name is prefilled after reload', (await a.evaluate(() => document.getElementById('nameInput').value)) === 'Bela', '', a);
});

await scenario('library renders the episode', async () => {
  const a = await join(await newPage(), 'Cyr');
  await click(a, '.tab[data-tab=library]');
  await waitFor(a, () => document.querySelectorAll('#library .card').length > 0, 12000, 'card');

  await waitFor(
    a,
    (t) => {
      const c = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes(t));
      return c?.querySelector('.thumb')?.naturalWidth > 0;
    },
    8000,
    'poster',
    DEMO,
  );
  const card = await a.evaluate((t) => {
    const c = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes(t));
    if (!c) return null;
    return {
      title: c.querySelector('.title')?.textContent,
      meta: c.querySelector('.meta')?.textContent,
      posterLoaded: c.querySelector('.thumb')?.naturalWidth > 0,
      button: c.querySelector('.btn')?.textContent,
    };
  }, DEMO);
  check('card shows the episode title', card && card.title.includes(DEMO), card?.title, a);
  check('card shows duration and resolution', Boolean(card && /1:30/.test(card.meta) && /720p/.test(card.meta)), card?.meta, a);
  check('poster thumbnail loads', Boolean(card?.posterLoaded), '', a);
  check('prepared episode offers Play', card?.button === 'Play', card?.button, a);
});

await scenario('picking an episode', async () => {
  const a = await join(await newPage(), 'Dov');
  check('player loads the media', await openEpisode(a), '', a);
  check('chat tab is shown after picking', await a.evaluate(() => document.querySelector('.tab.active').dataset.tab === 'chat'), '', a);
  check('title appears under the player', (await text(a, '#nowTitle')).includes(DEMO), await text(a, '#nowTitle'), a);
  check('player meta mentions burned-in subs', /subtitle/i.test(await text(a, '#nowSub')), await text(a, '#nowSub'), a);

  await click(a, '.tab[data-tab=library]');
  await sleep(500);
  const label = await a.evaluate((t) => {
    const card = [...document.querySelectorAll('#library .card')].find((c) => c.textContent.includes(t));
    return card?.querySelector('.btn')?.textContent;
  }, DEMO);
  check('library marks the loaded episode as Playing', label === 'Playing', label, a);
});

await scenario('play pause seek resume', async () => {
  const a = await join(await newPage(), 'Emi');
  const b = await join(await newPage(), 'Fumi');
  await openEpisode(a);

  await click(a, '#playBtn');
  check('play reaches the other viewer', await waitFor(b, () => window.__sync.snapshot().playing === true, 8000, 'playing'), '', a);
  await sleep(2500);
  const sa = await snap(a);
  const sb = await snap(b);
  const gap = Math.abs(sa.currentTime - sb.currentTime);
  check('both players stay within 400 ms', gap < 0.4, `gap ${Math.round(gap * 1000)} ms`, a);

  await click(a, '#playBtn');
  check('pause reaches the other viewer', await waitFor(b, () => window.__sync.snapshot().playing === false, 8000, 'paused'), '', a);
  const pa = await pos(a);
  const pb = await pos(b);
  check('both paused near the same frame', Math.abs(pa - pb) < 0.5, `${pa.toFixed(2)} vs ${pb.toFixed(2)}`, a);

  await seekTo(a, 40);
  check('seek lands on both players', await waitFor(b, () => Math.abs(document.getElementById('video').currentTime - 40) < 1.5, 8000, 'seek'), `b at ${(await pos(b)).toFixed(1)}s`, a);
  check('seek keeps the room paused', (await snap(a)).playing === false && (await snap(b)).playing === false, '', a);
  check('time label follows the seek', /0:4\d/.test(await text(a, '#time')), await text(a, '#time'), a);

  await click(a, '#playBtn');
  await sleep(1500);
  check('resume plays for both', Boolean((await snap(a)).playing && (await snap(b)).playing), '', a);
  const ra = await pos(a);
  const rb = await pos(b);
  check('resumed players stay together', Math.abs(ra - rb) < 0.5, `${ra.toFixed(2)} vs ${rb.toFixed(2)}`, a);
});

await scenario('joining a paused room', async () => {
  const a = await join(await newPage(), 'Gia');
  await openEpisode(a);
  const b = await join(await newPage(), 'Haru');

  await sleep(2500);
  check('a joiner does not start playing on their own', await b.evaluate(() => document.getElementById('video').paused), '', b);
  check('no click-to-play overlay is shown', !(await visible(b, '#gate')), '', b);
  check('joiner sits at the room position', (await snap(b)).playing === false, '', b);
});

await scenario('joining mid playback', async () => {
  const a = await join(await newPage(), 'Ivo');
  await openEpisode(a);
  await seekTo(a, 30);
  await waitFor(a, () => Math.abs(document.getElementById('video').currentTime - 30) < 1.5, 8000, 'seek');
  await click(a, '#playBtn');
  await sleep(2000);

  const b = await join(await newPage(), 'Jun');
  check(
    'late joiner starts playing',
    await waitFor(b, () => window.__sync.snapshot().playing === true && window.__sync.snapshot().readyState >= 1, 15000, 'play'),
    '',
    b,
  );
  await sleep(1200);
  const sb = await snap(b);
  check('late joiner lands near the room position', Math.abs(sb.currentTime - sb.expected) < 1.0, `at ${sb.currentTime.toFixed(1)}s, expected ${sb.expected.toFixed(1)}s`, b);
});

await scenario('reload in the middle of an episode', async () => {
  const a = await join(await newPage(), 'Kai');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(2500);
  const before = (await snap(a)).currentTime;

  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#nameInput', { polling: 50 });
  await a.evaluate(() => document.querySelector('#joinForm button[type=submit]').click());
  await a.waitForFunction(() => document.getElementById('join').classList.contains('hidden') && window.__sync.snapshot().users > 0, { polling: 50, timeout: 20000 });

  check('rejoining resumes the same episode', await waitFor(a, () => window.__sync.snapshot().readyState >= 1, 20000, 'ready'), '', a);
  await sleep(2000);
  const s = await snap(a);
  check('rejoining keeps pace with the room', Math.abs(s.currentTime - s.expected) < 1.5, `at ${s.currentTime.toFixed(1)}s, expected ${s.expected.toFixed(1)}s`, a);
  check('rejoining does not restart from the beginning', s.currentTime > before, `before ${before.toFixed(1)}s, now ${s.currentTime.toFixed(1)}s`, a);
});

await scenario('locking controls', async () => {
  const a = await join(await newPage(), 'Lena');
  const b = await join(await newPage(), 'Miro');
  await openEpisode(a);

  await click(a, '#lockBtn');
  await sleep(400);
  check('guest lock button is disabled', await b.evaluate(() => document.getElementById('lockBtn').disabled), '', b);

  const before = (await snap(b)).playing;
  await click(b, '#playBtn');
  await sleep(1200);
  check('guest cannot start playback', (await snap(b)).playing === before, `playing=${(await snap(b)).playing}`, b);
  check('guest is told why', (await tip(b)).some((t) => /host can control/i.test(t)), (await tip(b)).join(' / '), b);

  await click(a, '#playBtn');
  check('host can still start playback', await waitFor(b, () => window.__sync.snapshot().playing === true, 8000, 'playing'), '', b);

  await click(a, '#lockBtn');
  await sleep(400);
  // Unlocking must give the guest their controls back (the lock button stays
  // host-only, so the real test is that their action takes effect).
  await click(b, '#playBtn');
  check('unlocking gives the guest control back', await waitFor(b, () => window.__sync.snapshot().playing === false, 8000, 'pause by guest'), '', b);
});

await scenario('host leaves and hands over', async () => {
  const a = await join(await newPage(), 'Nao');
  const b = await join(await newPage(), 'Oli');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(1500);

  await a.close();
  pages.splice(pages.indexOf(a), 1);

  check('remaining viewer sees the room shrink', await waitFor(b, () => window.__sync.snapshot().users === 1, 8000, 'promotion'), '', b);
  await sleep(600);
  check('promotion unlocks the lock button', await b.evaluate(() => !document.getElementById('lockBtn').disabled), '', b);
  check('playback keeps running for the rest', (await snap(b)).playing === true, '', b);
  check('the room says who is host now', (await b.evaluate(() => document.getElementById('messages').textContent)).includes('now host'), '', b);
});

await scenario('end of episode', async () => {
  const a = await join(await newPage(), 'Pia');
  const b = await join(await newPage(), 'Quin');
  await openEpisode(a);

  const duration = await a.evaluate(() => document.getElementById('video').duration);
  await seekTo(a, duration - 3);
  await waitFor(a, (d) => document.getElementById('video').currentTime > d - 4, 8000, 'near end', duration);
  await click(a, '#playBtn');

  await sleep(6000);
  const statesBefore = await a.evaluate(() => (window.__states || []).length);
  await sleep(3000);
  const statesAfter = await a.evaluate(() => (window.__states || []).length);

  const sa = await snap(a);
  const sb = await snap(b);
  check('room stops playing at the end', sa.playing === false, `playing=${sa.playing}`, a);
  check('both viewers hold the last frame', Math.abs(sa.currentTime - sb.currentTime) < 1.0, `${sa.currentTime.toFixed(1)} vs ${sb.currentTime.toFixed(1)}`, a);
  check('no seek storm after the credits', statesAfter - statesBefore <= 2, `${statesAfter - statesBefore} state changes in 3 s`, a);
  check('drift badge does not scream lagging', !/lagging|behind/i.test(await text(a, '#syncBadge')), await text(a, '#syncBadge'), a);

  await click(a, '#playBtn');
  await sleep(2500);
  const replay = (await snap(a)).currentTime;
  check('pressing play replays from the start', replay < duration / 2, `at ${replay.toFixed(1)}s of ${duration.toFixed(0)}s`, a);
});

await scenario('chat', async () => {
  const a = await join(await newPage(), 'Rin');
  const b = await join(await newPage(), 'Sae');

  await a.evaluate(() => {
    document.getElementById('chatInput').value = 'ready when you are';
    document.getElementById('chatForm').requestSubmit();
  });
  check('message reaches the other viewer', await waitFor(b, () => document.getElementById('messages').textContent.includes('ready when you are'), 5000, 'chat'), '', b);
  check('own message is marked as mine', await a.evaluate(() => Boolean(document.querySelector('#messages .msg.mine'))), '', a);
  check('input clears after sending', (await a.evaluate(() => document.getElementById('chatInput').value)) === '', '', a);

  await a.evaluate(() => {
    document.getElementById('chatInput').value = '<img src=x onerror="window.__xss=1">';
    document.getElementById('chatForm').requestSubmit();
  });
  await waitFor(b, () => document.getElementById('messages').textContent.includes('onerror'), 5000, 'markup message');
  check('chat renders markup as text, not HTML', await b.evaluate(() => window.__xss === undefined && document.querySelectorAll('#messages img').length === 0), '', b);

  const long = `${'A'.repeat(120)} ${'verylongunbrokentoken'.repeat(14)}`;
  await a.evaluate((t) => {
    document.getElementById('chatInput').value = t;
    document.getElementById('chatForm').requestSubmit();
  }, long);
  await sleep(700);
  const overflow = await b.evaluate(() => {
    const box = document.getElementById('messages');
    return box.scrollWidth - box.clientWidth;
  });
  check('long messages do not overflow the panel', overflow <= 2, `${overflow}px horizontal overflow`, b);

  const count = () => b.evaluate(() => document.querySelectorAll('#messages .msg').length);
  const before = await count();
  await a.evaluate(() => {
    document.getElementById('chatInput').value = '   ';
    document.getElementById('chatForm').requestSubmit();
  });
  await sleep(500);
  check('empty message is not sent', (await count()) === before, '', b);
});

await scenario('keyboard shortcuts', async () => {
  const a = await join(await newPage(), 'Tomo');
  await openEpisode(a);
  await seekTo(a, 10);
  await waitFor(a, () => Math.abs(document.getElementById('video').currentTime - 10) < 1.5, 8000);
  await a.evaluate(() => document.getElementById('stage').click());

  await a.keyboard.press('ArrowRight');
  check('right arrow skips forward 5 s', await waitFor(a, () => Math.abs(document.getElementById('video').currentTime - 15) < 2, 6000, 'skip'), `at ${(await pos(a)).toFixed(2)}s`, a);
  await a.keyboard.press('ArrowLeft');
  check('left arrow skips back 5 s', await waitFor(a, () => Math.abs(document.getElementById('video').currentTime - 10) < 2, 6000, 'skip back'), `at ${(await pos(a)).toFixed(2)}s`, a);

  await a.keyboard.press('Space');
  check('space starts playback', await waitFor(a, () => window.__sync.snapshot().playing === true, 6000, 'play'), '', a);
  await a.keyboard.press('Space');
  check('space pauses playback', await waitFor(a, () => window.__sync.snapshot().playing === false, 6000, 'pause'), '', a);

  // Typing needs the chat panel open, exactly like a person would have it.
  await click(a, '.tab[data-tab=chat]');
  await a.evaluate(() => document.getElementById('chatInput').focus());
  await a.keyboard.type('my name is tom');
  await a.keyboard.press('Space');
  await sleep(600);
  check('typing a message does not toggle playback', (await snap(a)).playing === false, `playing=${(await snap(a)).playing}`, a);
  check('the typed text survives', (await a.evaluate(() => document.getElementById('chatInput').value)) === 'my name is tom ', await a.evaluate(() => document.getElementById('chatInput').value), a);
});

await scenario('mute and volume', async () => {
  const a = await join(await newPage(), 'Umi');
  await openEpisode(a);

  await click(a, '#muteBtn');
  check('mute button mutes the player', (await a.evaluate(() => document.getElementById('video').muted)) === true, '', a);
  check('mute button shows its state', await a.evaluate(() => document.getElementById('muteBtn').classList.contains('on')), '', a);
  await click(a, '#muteBtn');
  check('unmute restores sound', (await a.evaluate(() => document.getElementById('video').muted)) === false, '', a);

  await a.evaluate(() => {
    const v = document.getElementById('volume');
    v.value = '0.3';
    v.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('volume slider sets the level', Math.abs((await a.evaluate(() => document.getElementById('video').volume)) - 0.3) < 0.01, '', a);

  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#nameInput', { polling: 50 });
  check('volume is remembered after reload', Math.abs((await a.evaluate(() => document.getElementById('video').volume)) - 0.3) < 0.01, '', a);
});

await scenario('subtitles', async () => {
  const a = await join(await newPage(), 'Vera');
  await openEpisode(a);
  // Burned-in subtitles cannot be removed from the picture, but the viewer can
  // still ask for a subtitle-free rendition, so the control is offered.
  check('the track control is offered for burned-in subtitles', await visible(a, '#subsBtn'), '', a);
  await click(a, '#subsBtn');
  const bakedOptions = await a.evaluate(() => [...document.querySelectorAll('#subList .track-item .track-name')].map((n) => n.textContent));
  check('it offers the styled track and an off switch', bakedOptions.includes('Off') && bakedOptions.length >= 2, JSON.stringify(bakedOptions), a);
  check('meta explains the subtitles are baked', /burned in/i.test(await text(a, '#nowSub')), await text(a, '#nowSub'), a);
});

await scenario('upload validation', async () => {
  const a = await join(await newPage(), 'Wren');
  const form = new FormData();
  form.append('file', new Blob(['not a video']), 'notes.txt');
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  check('non-video upload is refused', res.status === 400, `HTTP ${res.status}`, a);
  check('refusal explains itself', /unsupported/i.test((await res.json()).error || ''), '', a);

  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  check('rescan reports back', await waitFor(a, () => [...document.querySelectorAll('#toasts .toast')].some((t) => /Library refreshed/.test(t.textContent)), 8000, 'toast'), '', a);
});

await scenario('long file names', async () => {
  // Real releases have names like this; build one and clean it up afterwards.
  const LONG = '[SubsPlease] Very Long Anime Title Name Here - 12 (1080p) [ABCD1234].mkv';
  // fileURLToPath, not .pathname: the latter percent-encodes the spaces.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(root, 'media', LONG);
  execSync(
    `ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 4 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "${file}"`,
    { stdio: 'ignore' },
  );

  const a = await join(await newPage(), 'Xia');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await sleep(1200);

  const card = await a.evaluate(() => {
    const c = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Very Long'));
    if (!c) return null;
    const title = c.querySelector('.title');
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || 18;
    return {
      lines: Math.round(title.getBoundingClientRect().height / lineHeight),
      cardOverflow: c.scrollWidth - c.clientWidth,
    };
  });
  check('long title stays inside the card', Boolean(card) && card.cardOverflow <= 2, JSON.stringify(card), a);
  check('long title is clamped, not wrapped into a paragraph', Boolean(card) && card.lines <= 3, `~${card?.lines} lines`, a);

  if (card) {
    // A freshly scanned file needs a transcode before it can play.
    const id = await a.evaluate(async () => {
      const data = await (await fetch('/api/library')).json();
      return data.media.find((m) => m.title.includes('Very Long'))?.id;
    });
    await a.evaluate(async (mediaId) => {
      await fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' });
    }, id);
    await waitFor(
      a,
      () => [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Very Long'))?.querySelector('.btn.primary') != null,
      60000,
      'prepare',
    );
    await a.evaluate(() => {
      const c = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Very Long'));
      c.querySelector('.btn.primary').click();
    });
    await waitFor(a, () => window.__sync.snapshot().readyState >= 1, 20000, 'ready');
    const meta = await a.evaluate(() => {
      const bar = document.querySelector('.stage-meta');
      const h = document.getElementById('nowTitle');
      return { overflow: bar.scrollWidth - bar.clientWidth, height: h.getBoundingClientRect().height };
    });
    check('long title does not push the stage around', meta.overflow <= 2, `${meta.overflow}px overflow`, a);
    check('long title occupies one line under the player', meta.height < 40, `${Math.round(meta.height)}px tall`, a);

    // Leave the library the way we found it (after the pages are gone).
    cleanups.push(async () => {
      execSync(`rm -f ${JSON.stringify(file)} && rm -rf ${JSON.stringify(path.join(root, 'cache', id))}`, { stdio: 'ignore' });
      await fetch(`${BASE}/api/rescan`, { method: 'POST' });
    });
  }
});

await scenario('episode disappears from the library', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(root, 'media', 'Vanishing Episode - 01.mkv');
  execSync(
    `ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=24 -t 3 -c:v libx264 -preset veryfast -pix_fmt yuv420p "${file}"`,
    { stdio: 'ignore' },
  );

  const a = await join(await newPage(), 'Yara');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await waitFor(a, () => [...document.querySelectorAll('#library .card')].some((n) => n.textContent.includes('Vanishing')), 15000, 'fixture');
  const id = await a.evaluate(async () => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.includes('Vanishing'))?.id;
  });
  await a.evaluate((mediaId) => fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' }), id);
  check(
    'fixture becomes playable',
    await waitFor(
      a,
      () => [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Vanishing'))?.querySelector('.btn.primary') != null,
      60000,
      'prepare',
    ),
    '',
    a,
  );
  await a.evaluate(() => {
    [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Vanishing')).querySelector('.btn.primary').click();
  });
  check('episode is loaded', await waitFor(a, () => window.__sync.snapshot().readyState >= 1, 20000, 'ready'), '', a);

  // Pull the file out from under the room, exactly like deleting it by hand.
  execSync(`rm -f ${JSON.stringify(file)} && rm -rf ${JSON.stringify(path.join(root, 'cache', id))}`, { stdio: 'ignore' });
  await fetch(`${BASE}/api/rescan`, { method: 'POST' });

  check(
    'the stage returns to its empty state',
    await waitFor(a, () => !document.getElementById('placeholder').classList.contains('hidden'), 10000, 'placeholder'),
    '',
    a,
  );
  check('the player is not left pointing at a dead URL', await a.evaluate(() => !document.getElementById('video').getAttribute('src')), '', a);
  check('the title is cleared', (await text(a, '#nowTitle')) === 'No episode loaded', await text(a, '#nowTitle'), a);
  check(
    'no request goes to /undefined',
    !pages.some((x) => (x.__errors || []).some((e) => /\/undefined/.test(e))),
    '',
    a,
  );
});

await scenario('a wiped cache rebuilds itself', async () => {
  // The 409 is exactly what this scenario is testing: the player must survive it.
  allowedErrors.push(/409/, /Conflict/i);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const a = await join(await newPage(), 'Nadia');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(2500);

  const id = await a.evaluate(async () => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.includes('Demo'))?.id;
  });
  // Simulate a cache wipe (disk cleanup, failed encode) while the room is live.
  execSync(`rm -f ${JSON.stringify(path.join(root, 'cache', id, 'video.mp4'))}`, { stdio: 'ignore' });
  await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  check('the server stops advertising the missing rendition', (await (await fetch(`${BASE}/api/library`)).json()).media.find((m) => m.id === id)?.prepared === false, '', a);

  // Force the player to need bytes that are no longer there.
  await a.evaluate(() => {
    const v = document.getElementById('video');
    v.currentTime = Math.max(5, v.currentTime + 30);
  });
  await sleep(2500);

  check(
    'playback recovers without a reload',
    await waitFor(a, () => {
      const v = document.getElementById('video');
      return v.readyState >= 2 && !v.error;
    }, 90000, 'rebuild'),
    '',
    a,
  );
  check(
    'the rebuilt rendition is playable again',
    await waitFor(a, () => window.__sync.snapshot().readyState >= 2 && window.__sync.snapshot().playing, 30000, 'resume'),
    '',
    a,
  );
  check('no error toast about a broken file', !(await a.evaluate(() => /Playback error/.test(document.body.textContent))), '', a);
});

await scenario('returning from another tab', async () => {
  const a = await join(await newPage(), 'Yuki');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(2000);

  // Only now open the other tab: a player that never got to load before being
  // backgrounded is a different (and much slower) situation.
  const other = await newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await sleep(9000);
  await a.bringToFront();
  await sleep(2500);

  const s = await snap(a);
  check('playback survived being in the background', s.playing === true, '', a);
  check('the player catches up after coming back', Math.abs(s.currentTime - s.expected) < 1.5, `at ${s.currentTime.toFixed(1)}s, expected ${s.expected.toFixed(1)}s`, a);
});

await scenario('sync quality with three viewers', async () => {
  const a = await newSoloPage('Ana');
  const b = await newSoloPage('Ben');
  const c = await newSoloPage('Cleo');
  await openEpisode(a);
  const buffered = await Promise.all(
    [a, b, c].map((p) => waitFor(p, () => window.__sync.snapshot().readyState >= 1, 25000, 'ready')),
  );
  check('all three players buffer the episode', buffered.every(Boolean), buffered.join(' / '), a);
  await click(a, '#playBtn');
  await sleep(2500);

  const gaps = [];
  for (let i = 0; i < 50; i++) {
    const [pa, pb, pc] = await Promise.all([pos(a), pos(b), pos(c)]);
    gaps.push(Math.abs(pa - pb), Math.abs(pa - pc), Math.abs(pb - pc));
    await sleep(200);
  }
  gaps.sort((x, y) => x - y);
  const at = (q) => gaps[Math.floor(gaps.length * q)] * 1000;
  const median = at(0.5);
  const p95 = at(0.95);

  check('three players stay within 200 ms of each other', median < 200, `median ${median.toFixed(0)} ms`, a);
  check('the worst case stays under half a second', p95 < 500, `p95 ${p95.toFixed(0)} ms, max ${(gaps.at(-1) * 1000).toFixed(0)} ms`, a);

  // A nudge lasts a few hundred milliseconds, so give the controllers time to
  // come back to 1x rather than sampling during a correction.
  let rates = [];
  for (let i = 0; i < 25; i += 1) {
    rates = await Promise.all([a, b, c].map((p) => p.evaluate(() => document.getElementById('video').playbackRate)));
    if (rates.every((r) => Math.abs(r - 1) < 0.001)) break;
    await sleep(200);
  }
  check('corrections settle back to normal speed', rates.every((r) => Math.abs(r - 1) < 0.001), rates.join(' / '), a);
  const badges = await Promise.all([a, b, c].map((p) => text(p, '#syncBadge')));
  check('every player reports a steady state', badges.every((s) => !/lagging|behind|starting/i.test(s)), badges.join(' | '), a);
});

await scenario('three seats', async () => {
  const a = await join(await newPage(), 'Bea');
  await join(await newPage(), 'Cai');
  await join(await newPage(), 'Dee');
  check('three people fit', (await snap(a)).users === 3, '', a);

  const extra = await newPage();
  await extra.goto(BASE, { waitUntil: 'domcontentloaded' });
  await extra.waitForSelector('#nameInput', { polling: 50 });
  await extra.evaluate(() => {
    document.getElementById('nameInput').value = 'Eve';
    document.querySelector('#joinForm button[type=submit]').click();
  });
  check('fourth person is refused', await waitFor(extra, () => /room is full/i.test(document.getElementById('joinError').textContent), 8000, 'refusal'), '', extra);
  check('refusal keeps them on the join screen', await waitFor(extra, () => {
    const n = document.getElementById('join');
    if (!n || n.classList.contains('hidden')) return false;
    const style = getComputedStyle(n);
    return style.display !== 'none' && Number(style.opacity) > 0.9 && n.getBoundingClientRect().height > 1;
  }, 5000, 'join modal'), '', extra);
  check('the three viewers are unaffected', (await snap(a)).users === 3, '', a);
});

await scenario('room empties and resets', async () => {
  const a = await join(await newPage(), 'Zoe');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(2500);
  await a.close();
  pages.splice(pages.indexOf(a), 1);

  // The server freezes an empty room immediately (rewind happens later).
  await sleep(2500);
  const b = await join(await newPage(), 'Abe');
  await sleep(1500);
  const s = await snap(b);
  check('a fresh room does not inherit stale playback', s.playing === false, `playing=${s.playing}`, b);
  check('the new viewer is not dragged forward', Math.abs((s.expected ?? 0) - (s.currentTime ?? 0)) < 2, `at ${s.currentTime}s, expected ${s.expected}s`, b);
});

await scenario('server restart reconnects', async () => {
  const a = await join(await newPage(), 'Fay');
  const b = await join(await newPage(), 'Gus');
  await openEpisode(a);
  await click(a, '#playBtn');
  await sleep(1500);

  execSync('systemctl --user restart anime-sync', { stdio: 'ignore' });
  await sleep(1500);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch { /* still down */ }
    await sleep(500);
  }

  check(
    'first viewer reconnects by itself',
    await waitFor(a, () => window.__sync.snapshot().users >= 1 && !/disconnected/.test(document.getElementById('syncBadge').textContent), 30000, 'reconnect'),
    '',
    a,
  );
  check('second viewer reconnects by itself', await waitFor(b, () => window.__sync.snapshot().users >= 1, 30000, 'reconnect'), '', b);
  check(
    'both are back in the same room',
    await waitFor(a, () => window.__sync.snapshot().users === 2, 10000, 'two viewers'),
    `${(await snap(a)).users} viewers`,
    a,
  );
  check('nobody is stuck on a dead connection', !(await tip(a)).some((t) => /Connection lost/i.test(t)), '', a);
});

await scenario('switchable audio and subtitle tracks', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const TRACKS = 'Tracks Episode';
  execSync(`bash ${path.join(root, 'test', 'make-tracks-fixture.sh')} ${path.join(root, 'media')}`, { stdio: 'ignore' });

  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    const item = list.media.find((m) => m.title.includes(TRACKS));
    for (const name of fs.readdirSync(path.join(root, 'media'))) {
      if (name.startsWith(TRACKS)) fs.rmSync(path.join(root, 'media', name), { force: true });
    }
    if (item) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Nadia');
  const b = await join(await newPage(), 'Omar');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await sleep(1200);

  // A freshly scanned file needs a transcode before it can be opened.
  const id = await a.evaluate(async (title) => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.includes(title))?.id ?? null;
  }, TRACKS);
  check('the episode was scanned with its sidecars', Boolean(id), String(id), a);
  await a.evaluate(async (mediaId) => {
    await fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' });
  }, id);
  await waitFor(
    a,
    (title) => {
      const card = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes(title));
      return Boolean(card?.querySelector('.btn.primary'));
    },
    90000,
    'prepare',
    TRACKS,
  );

  await openEpisode(a, TRACKS); // its own strict wait is covered by the checks below
  check(
    'the episode opens',
    await waitFor(
      a,
      (mediaId) => window.__sync.snapshot().mediaId === mediaId && document.getElementById('stageTag').textContent.includes('Tracks Episode'),
      30000,
      'episode selected',
      id,
    ),
    '',
    a,
  );
  await click(a, '#playBtn');
  await sleep(1200);

  check('the track button appears when there is something to switch', await visible(a, '#subsBtn'), '', a);
  await click(a, '#subsBtn');
  check('the menu opens', await visible(a, '#trackMenu'), '', a);

  const menu = await a.evaluate(() => ({
    subs: [...document.querySelectorAll('#subList .track-item .track-name')].map((n) => n.textContent),
    audio: [...document.querySelectorAll('#audioList .track-item .track-name')].map((n) => n.textContent),
  }));
  check('both subtitle tracks are listed', menu.subs.includes('English') && menu.subs.includes('Spanish'), JSON.stringify(menu.subs), a);
  check('burned-in subtitles offer an off switch', menu.subs.includes('Off'), '', a);
  check('the sidecar dub is listed as audio', menu.audio.includes('English') && menu.audio.includes('Japanese'), JSON.stringify(menu.audio), a);

  // --- alternate audio ------------------------------------------------------
  await a.evaluate(() => {
    [...document.querySelectorAll('#audioList .track-item')]
      .find((b) => b.querySelector('.track-name').textContent === 'English')
      .click();
  });
  check(
    'the alternate audio track starts playing',
    await waitFor(a, () => {
      const alt = document.getElementById('altAudio');
      return Boolean(alt.src) && !alt.paused && document.getElementById('video').muted;
    }, 15000, 'alternate audio'),
    '',
    a,
  );
  check(
    'the muxed track is silenced, not layered on top',
    await a.evaluate(() => document.getElementById('video').muted === true),
    '',
    a,
  );

  // Two media elements only work if they stay locked together.
  const avGap = await a.evaluate(async () => {
    const video = document.getElementById('video');
    const alt = document.getElementById('altAudio');
    let worst = 0;
    for (let i = 0; i < 10; i += 1) {
      worst = Math.max(worst, Math.abs(video.currentTime - alt.currentTime));
      await new Promise((r) => setTimeout(r, 200));
    }
    return worst;
  });
  check('the alternate audio stays in step with the picture', avGap < 0.3, `worst gap ${avGap.toFixed(3)}s`, a);
  check(
    'the other viewer keeps the original audio',
    await b.evaluate(() => !document.getElementById('video').muted && !document.getElementById('altAudio').src),
    '',
    b,
  );

  // --- soft subtitles -------------------------------------------------------
  await click(a, '#subsBtn');
  await a.evaluate(() => {
    [...document.querySelectorAll('#subList .track-item')]
      .find((n) => n.querySelector('.track-name').textContent === 'Spanish')
      .click();
  });
  check(
    'choosing a soft track switches to the subtitle-free rendition',
    await waitFor(a, () => document.getElementById('video').currentSrc.includes('video.clean.mp4'), 90000, 'clean rendition'),
    '',
    a,
  );
  check(
    'the chosen subtitle track is showing',
    await waitFor(a, () => {
      const tracks = document.getElementById('video').textTracks;
      return tracks.length === 1 && tracks[0].mode === 'showing';
    }, 15000, 'text track'),
    '',
    a,
  );
  check(
    'the other viewer still has burned-in subtitles',
    await b.evaluate(() => document.getElementById('video').textTracks.length === 0 && !document.getElementById('video').currentSrc.includes('clean')),
    '',
    b,
  );

  // --- persistence ----------------------------------------------------------
  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.waitForSelector('#nameInput', { polling: 50 });
  await a.evaluate(() => document.querySelector('#joinForm button[type=submit]').click());
  check(
    'a reload gets its seat back immediately',
    await waitFor(a, () => window.__sync?.snapshot().users >= 2, 10000, 'seat back'),
    '',
    a,
  );
  await sleep(2500);
  check('a reload is not mistaken for a fourth viewer', (await snap(a)).users === 2, `${(await snap(a)).users} viewers`, a);
  const remembered = await a.evaluate(() => ({
    src: document.getElementById('video').currentSrc,
    tracks: document.getElementById('video').textTracks.length,
    alt: document.getElementById('altAudio').src,
  }));
  check('the choice survives a reload', remembered.src.includes('video.clean.mp4') && remembered.tracks === 1, JSON.stringify(remembered), a);
  check('the audio choice survives a reload too', remembered.alt.includes('/audio/1.m4a'), remembered.alt, a);

  // --- off ------------------------------------------------------------------
  await click(a, '#subsBtn');
  await a.evaluate(() => {
    [...document.querySelectorAll('#subList .track-item')]
      .find((n) => n.querySelector('.track-name').textContent === 'Off')
      .click();
  });
  check(
    'subtitles can be turned off',
    await waitFor(a, () => document.getElementById('video').textTracks.length === 0, 15000, 'no text tracks'),
    '',
    a,
  );
  const offState = await a.evaluate(() => ({
    sub: window.__sync.snapshot().subtitles,
    empty: document.getElementById('stage').classList.contains('empty'),
    src: document.getElementById('video').currentSrc.split('/').pop(),
    toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' | '),
  }));
  check('the state reports no subtitles', offState.sub === 'off', JSON.stringify(offState), a);
  check('the picture and the stage survive turning subtitles off', !offState.empty && !/error|failed/i.test(offState.toast), JSON.stringify(offState), a);
});

await scenario('no track controls when there is nothing to switch', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const PLAIN = 'Plain Episode - 01.mkv';
  execSync(
    `ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "${path.join(root, 'media', PLAIN)}"`,
    { stdio: 'ignore' },
  );
  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    const item = list.media.find((m) => m.title.startsWith('Plain Episode'));
    fs.rmSync(path.join(root, 'media', PLAIN), { force: true });
    if (item) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Pia');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await sleep(1200);

  const plainId = await a.evaluate(async () => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.startsWith('Plain Episode'))?.id ?? null;
  });
  await a.evaluate(async (mediaId) => {
    await fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' });
  }, plainId);
  await waitFor(
    a,
    () => Boolean([...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Plain Episode'))?.querySelector('.btn.primary')),
    60000,
    'prepare',
  );

  check('a plain episode opens', await openEpisode(a, 'Plain Episode'), '', a);
  await sleep(600);
  check('no track button for an episode with one audio track and no subtitles', !(await visible(a, '#subsBtn')), '', a);
  check('the menu is not rendered either', !(await visible(a, '#trackMenu')), '', a);
});

await scenario('upload progress tells the truth', async () => {
  // Cancelling a transfer mid-body makes the socket drop, which the server
  // answers with 400 — that is the behaviour under test, not a bug.
  allowedErrors.push(/400|Bad Request/);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const names = ['Upload A - 01.mkv', 'Upload B - 02.mkv', 'Upload C - 03.mkv', 'Upload D - 04.mkv'];
  const files = names.map((name) => path.join(root, 'media', name));
  for (const file of files) {
    execSync(
      `ffmpeg -y -v error -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440 -t 6 ` +
        `-c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p -c:a aac "${file}"`,
      { stdio: 'ignore' },
    );
  }
  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    for (const file of files) fs.rmSync(file, { force: true });
    for (const item of list.media) {
      if (item.title.startsWith('Upload ')) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    }
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Quinn');
  await click(a, '.tab[data-tab=library]');
  await sleep(400);

  // Pretend the link is the relayed one that made uploads feel broken.
  const cdp = await a.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: 4 * 1024 * 1024,
    uploadThroughput: 1.4 * 1024 * 1024,
  });

  const rows = () =>
    a.evaluate(() =>
      [...document.querySelectorAll('#uploadBar .upload-row')].map((row) => ({
        name: row.querySelector('.upload-name').textContent,
        phase: row.querySelector('.upload-phase').textContent,
        detail: row.querySelector('.upload-detail').textContent,
        cancel: !row.querySelector('.upload-cancel').classList.contains('hidden'),
      })),
    );
  const queuedNote = () => a.evaluate(() => document.querySelector('.upload-queue')?.textContent || null);

  await (await a.$('#uploadInput')).uploadFile(...files);

  const parallel = await waitFor(a, () => document.querySelectorAll('#uploadBar .upload-row').length >= 3, 20000, 'parallel rows');
  const live = await rows();
  check('several uploads run at the same time', parallel && live.length === 3, `${live.length} rows`, a);
  check('each transfer has its own row and name', live.length === 3 && new Set(live.map((r) => r.name)).size === 3, JSON.stringify(live.map((r) => r.name)), a);
  check('the rest wait their turn', /1 more waiting/.test((await queuedNote()) || ''), String(await queuedNote()), a);
  check('each row can be cancelled on its own', live.every((r) => r.cancel), '', a);

  const measured = await waitFor(
    a,
    () => {
      const detail = document.querySelector('#uploadBar .upload-row .upload-detail')?.textContent || '';
      return /\/s/.test(detail) && /left/.test(detail);
    },
    20000,
    'speed and eta',
  );
  const withSpeed = (await rows())[0];
  check('a row reports bytes sent', /[\d.]+ (KB|MB) of [\d.]+ (MB|GB)/.test(withSpeed.detail), withSpeed.detail, a);
  check('a row reports its own speed', measured && /\/s/.test(withSpeed.detail), withSpeed.detail, a);
  check('a row reports its own time left', measured && /left/.test(withSpeed.detail), withSpeed.detail, a);

  // Cancelling one must not touch the others.
  await a.evaluate(() => document.querySelector('#uploadBar .upload-row .upload-cancel').click());
  const cancelled = await waitFor(
    a,
    () => [...document.querySelectorAll('#uploadBar .upload-row')].some((row) => row.querySelector('.upload-phase').textContent === 'Cancelled'),
    10000,
    'cancelled row',
  );
  const after = await rows();
  check('cancelling one transfer leaves the others running', cancelled && after.some((r) => r.phase === 'Uploading' || r.phase === 'Finishing'), JSON.stringify(after.map((r) => r.phase)), a);

  // Rows disappear once they are done, so record every phase the UI showed
  // instead of sampling at one arbitrary moment.
  await a.evaluate(() => {
    window.__uploadPhases = [];
    const record = () => {
      for (const node of document.querySelectorAll('#uploadBar .upload-row .upload-phase')) {
        if (!window.__uploadPhases.includes(node.textContent)) window.__uploadPhases.push(node.textContent);
      }
    };
    record();
    new MutationObserver(record).observe(document.getElementById('uploadBar'), { childList: true, subtree: true, characterData: true });
    setInterval(record, 200);
  });

  const ready = await waitFor(
    a,
    () => (window.__uploadPhases || []).includes('Ready'),
    120000,
    'ready',
  );
  check('the survivors end up preparing and ready', ready, JSON.stringify(await a.evaluate(() => window.__uploadPhases)), a);
});

await scenario('a reload reports the files it cut short', async () => {
  const a = await newPage();
  await a.goto(BASE, { waitUntil: 'domcontentloaded' });
  // Stand in for a batch that was in flight when the tab was reloaded.
  await a.evaluate(() =>
    localStorage.setItem('anisync:uploads-in-flight', JSON.stringify(['Episode 04.mkv', 'Episode 05.mkv'])),
  );
  await join(a, 'Vic');
  const toasts = await tip(a);
  check(
    'the interrupted files are named',
    toasts.some((t) => /interrupted/.test(t) && /Episode 04/.test(t) && /Episode 05/.test(t)),
    toasts.join(' | '),
    a,
  );
  check(
    'the notice is cleared once it has been shown',
    await a.evaluate(() => !localStorage.getItem('anisync:uploads-in-flight')),
    '',
    a,
  );
});

await scenario('a batch uploads without waiting for the encoder', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const names = Array.from({ length: 6 }, (_, i) => `Batch ${i + 1} - 0${i + 1}.mkv`);
  const files = names.map((name) => path.join(root, 'media', name));
  for (const file of files) {
    // 30-second 1080p clips: the encode takes a few seconds each, plenty of
    // time for the next file's bytes to land if the queue is not blocked on it.
    execSync(
      `ffmpeg -y -v error -f lavfi -i testsrc2=size=1920x1080:rate=24 -f lavfi -i sine=frequency=440 -t 30 ` +
        `-c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p -c:a aac "${file}"`,
      { stdio: 'ignore' },
    );
  }
  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    for (const file of files) fs.rmSync(file, { force: true });
    for (const item of list.media) {
      if (item.title.startsWith('Batch ')) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    }
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Uma');
  await click(a, '.tab[data-tab=library]');
  await sleep(400);
  await (await a.$('#uploadInput')).uploadFile(...files);

  // Every file must reach the server while earlier ones are still encoding.
  const allLanded = await waitFor(
    a,
    () => fetch('/api/library').then((r) => r.json()).then((d) => d.media.filter((m) => /^Batch /.test(m.title)).length >= 6),
    90000,
    'six files uploaded',
  );
  const state = await a.evaluate(() =>
    fetch('/api/library')
      .then((r) => r.json())
      .then((d) => ({
        uploaded: d.media.filter((m) => /^Batch /.test(m.title)).length,
        prepared: d.media.filter((m) => /^Batch /.test(m.title) && m.prepared).length,
      })),
  );
  check('all six files reach the server', allLanded && state.uploaded === 6, JSON.stringify(state), a);
  check(
    'they do not wait for the encoder to catch up',
    state.prepared < state.uploaded,
    `${state.prepared} of ${state.uploaded} encoded at that moment`,
    a,
  );
  check('nothing is left in the upload queue', (await a.evaluate(() => document.querySelector('.upload-queue')?.textContent || '')) === '', '', a);
});

await scenario('switching to a lighter rendition', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const NAME = 'Ladder Episode - 01.mkv';
  const file = path.join(root, 'media', NAME);
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=1920x1080:rate=12 -f lavfi -i sine=frequency=440 -t 8 ` +
      `-c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p -c:a aac "${file}"`,
    { stdio: 'ignore' },
  );
  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    const item = list.media.find((m) => m.title.startsWith('Ladder Episode'));
    fs.rmSync(file, { force: true });
    if (item) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Sol');
  const b = await join(await newPage(), 'Tam');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await sleep(1200);

  const id = await a.evaluate(async () => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.startsWith('Ladder Episode'))?.id ?? null;
  });
  check('the episode is scanned', Boolean(id), String(id), a);
  await a.evaluate(async (mediaId) => {
    await fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' });
  }, id);
  await waitFor(
    a,
    () => Boolean([...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Ladder Episode'))?.querySelector('.btn.primary')),
    60000,
    'prepare',
  );
  // Pre-build the lighter copy so the click below is a switch, not a wait.
  await a.evaluate(async (mediaId) => {
    await fetch(`/api/media/${mediaId}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ height: 720 }),
    });
  }, id);
  await waitFor(
    a,
    (mediaId) =>
      fetch('/api/library')
        .then((response) => response.json())
        .then((data) => Boolean(data.media.find((m) => m.id === mediaId)?.qualities?.[1]?.ready)),
    120000,
    '720 build',
    id,
  );

  await openEpisode(a, 'Ladder Episode');
  await click(a, '#playBtn');
  await sleep(2000);

  const pill = await a.evaluate(() => ({
    hidden: document.getElementById('qualityBtn').classList.contains('hidden'),
    label: document.getElementById('qualityLabel').textContent,
  }));
  check('the player offers a quality switch', !pill.hidden, JSON.stringify(pill), a);
  check('it names the rendition in use', pill.label === '1080p', pill.label, a);

  await click(a, '#qualityBtn');
  const menu = await a.evaluate(() => ({
    visible: !document.getElementById('qualityMenu').classList.contains('hidden'),
    items: [...document.querySelectorAll('#qualityList .track-item')].map((n) => ({
      name: n.querySelector('.track-name').textContent,
      active: n.classList.contains('active'),
    })),
  }));
  check('the menu lists both renditions of the same episode', menu.visible && menu.items.length === 2, JSON.stringify(menu.items), a);
  check('the sharp one is active to begin with', menu.items[0]?.active && menu.items[0]?.name === '1080p', JSON.stringify(menu.items), a);

  const before = await a.evaluate(() => ({
    src: document.getElementById('video').currentSrc,
    at: document.getElementById('video').currentTime,
  }));
  await a.evaluate(() => {
    [...document.querySelectorAll('#qualityList .track-item')].find((n) => n.querySelector('.track-name').textContent === '720p').click();
  });
  const switched = await waitFor(a, () => document.getElementById('video').currentSrc.includes('/quality/720/'), 20000, '720p source');
  const after = await a.evaluate(() => ({
    src: document.getElementById('video').currentSrc,
    at: document.getElementById('video').currentTime,
    quality: window.__sync.snapshot().quality,
    label: document.getElementById('qualityLabel').textContent,
    meta: document.getElementById('nowSub').textContent,
  }));
  check('picking 720p switches the stream without a reload', switched, after.src.split('/').slice(-2).join('/'), a);
  check('the position survives the switch', Math.abs(after.at - before.at) < 6, `${before.at.toFixed(1)}s → ${after.at.toFixed(1)}s`, a);
  check('the control shows the chosen quality', after.quality === 720 && after.label === '720p', `${after.quality} / ${after.label}`, a);
  check('the stage says what is being streamed', /720p/.test(after.meta), after.meta, a);
  check('another viewer keeps the sharp stream', await b.evaluate(() => !document.getElementById('video').currentSrc.includes('/quality/720/')), '', b);

  await click(a, '#qualityBtn');
  await a.evaluate(() => {
    [...document.querySelectorAll('#qualityList .track-item')].find((n) => n.querySelector('.track-name').textContent === '1080p').click();
  });
  check(
    'switching back to 1080p is instant',
    await waitFor(a, () => !document.getElementById('video').currentSrc.includes('/quality/720/'), 15000, 'back to 1080p'),
    '',
    a,
  );

  // One card, not two: the copy must never appear as a separate library entry.
  const cards = await a.evaluate(() => [...document.querySelectorAll('#library .card')].filter((n) => n.textContent.includes('Ladder Episode')).length);
  check('the lighter rendition is not a separate library item', cards === 1, `${cards} cards`, a);
  const light = fs.statSync(path.join(root, 'cache', id, 'video.720.mp4'));
  const sharp = fs.statSync(path.join(root, 'cache', id, 'video.mp4'));
  check('the original rendition was kept, not replaced', sharp.size > light.size, `${(sharp.size / 1024 / 1024).toFixed(1)} MB vs ${(light.size / 1024 / 1024).toFixed(1)} MB`);
});

await scenario('deleting an episode', async () => {
  // Requests for the deleted file's poster and rendition 404 by definition.
  allowedErrors.push(/404/);
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const NAME = 'Delete Me - 01.mkv';
  const file = path.join(root, 'media', NAME);
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=320x240:rate=24 -f lavfi -i sine=frequency=440 -t 3 ` +
      `-c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "${file}"`,
    { stdio: 'ignore' },
  );
  cleanups.push(async () => {
    const list = await (await fetch(`${BASE}/api/library`)).json();
    const item = list.media.find((m) => m.title.startsWith('Delete Me'));
    fs.rmSync(file, { force: true });
    if (item) fs.rmSync(path.join(root, 'cache', item.id), { recursive: true, force: true });
    await fetch(`${BASE}/api/rescan`, { method: 'POST' });
  });

  const a = await join(await newPage(), 'Rae');
  await click(a, '.tab[data-tab=library]');
  await click(a, '#rescanBtn');
  await sleep(1200);

  const id = await a.evaluate(async () => {
    const data = await (await fetch('/api/library')).json();
    return data.media.find((m) => m.title.startsWith('Delete Me'))?.id ?? null;
  });
  check('the episode is in the library', Boolean(id), String(id), a);
  await a.evaluate(async (mediaId) => {
    await fetch(`/api/media/${mediaId}/prepare`, { method: 'POST' });
  }, id);
  const ready = await waitFor(
    a,
    () => Boolean([...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Delete Me'))?.querySelector('.card-delete:not([disabled])')),
    60000,
    'delete button',
  );
  check('the episode offers Play and a delete button', ready, '', a);

  const cardText = () =>
    a.evaluate(() => {
      const card = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Delete Me'));
      return card ? card.textContent : null;
    });
  const clickIn = (selector) =>
    a.evaluate((sel) => {
      const card = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Delete Me'));
      card?.querySelector(sel)?.click();
    }, selector);

  // Cancel first: nothing may disappear without a confirmation.
  await clickIn('.card-delete');
  const asked = await waitFor(a, () => Boolean(document.querySelector('.confirm-text')), 5000, 'confirm question');
  check('deleting asks first', asked, (await cardText()) || '', a);
  await a.screenshot({ path: '/tmp/delete-confirm.png' });
  await a.evaluate(() => {
    const card = [...document.querySelectorAll('#library .card')].find((n) => n.textContent.includes('Delete Me'));
    [...card.querySelectorAll('.btn')].find((b) => b.textContent === 'Cancel').click();
  });
  await sleep(600);
  check('cancelling keeps the file', fs.existsSync(file) && (await cardText())?.includes('Delete Me'), '', a);

  // Now confirm.
  await clickIn('.card-delete');
  await sleep(300);
  await clickIn('.btn.danger');
  check(
    'the card disappears',
    await waitFor(a, () => ![...document.querySelectorAll('#library .card')].some((n) => n.textContent.includes('Delete Me')), 15000, 'card gone'),
    '',
    a,
  );
  check('the file is gone from the server', !fs.existsSync(file), file);
  check('the deletion is confirmed to the user', (await tip(a)).some((t) => /removed/i.test(t)), (await tip(a)).join(' | '), a);
});

// ---------------------------------------------------------------------------
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ✗ [${f.scenario}] ${f.name} — ${f.detail}`);
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`\nresults → ${OUT}/results.json`);
process.exit(failed.length ? 1 : 0);
