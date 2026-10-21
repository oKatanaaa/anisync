/**
 * End-to-end proof that the room actually stays in sync.
 *
 * Two independent Chrome pages join the same room, play the same episode, and
 * every 200ms each page records its own position stamped with the *server*
 * clock. Those two logs are then aligned by server time and compared, which is
 * exactly the question a user cares about: "are my friends seeing the same
 * frame I am?"
 *
 * Run with the server already listening:  node test/e2e.mjs
 */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function pass(name, detail = '') {
  results.push({ name, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  return fn();
}

const browserErrors = [];

/**
 * Click through the DOM instead of Puppeteer's trusted input events: with more
 * than one page open, the headless Chrome here hangs on Input.dispatchMouseEvent.
 * Synthetic clicks are fine because autoplay is already permitted by a flag.
 */
const clickSel = (page, selector) =>
  page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`missing element: ${sel}`);
    node.click();
  }, selector);

async function newClient(browser, name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (err) => browserErrors.push(`${name}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') browserErrors.push(`${name} console: ${msg.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#nameInput', { polling: 50, timeout: 15000 });
  await page.evaluate((n) => {
    document.getElementById('nameInput').value = n;
  }, name);
  await clickSel(page, '#joinForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('join').classList.contains('hidden'), { polling: 50, timeout: 10000 });
  await page.waitForFunction(() => window.__sync && window.__sync.snapshot().users > 0, { polling: 50, timeout: 10000 });
  return page;
}

async function startEpisode(page) {
  await clickSel(page, '[data-tab="library"]');
  await page.waitForSelector('#library .card .btn.primary', { polling: 50, timeout: 20000 });
  await clickSel(page, '#library .card .btn.primary');
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.src && v.readyState >= 2;
      },
      { polling: 50, timeout: 25000 },
    );
  } catch (err) {
    const dump = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        snap: window.__sync?.snapshot?.(),
        video: { src: v?.src, ready: v?.readyState, net: v?.networkState, err: v?.error?.message ?? null, dur: v?.duration },
        sent: (window.__sent || []).filter((m) => m.t !== 'ping' && m.t !== 'latency').slice(-8),
        states: (window.__states || []).slice(-5),
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
        cards: document.querySelectorAll('#library .card').length,
      };
    });
    console.log('  START-EPISODE DUMP:', JSON.stringify(dump, null, 1));
    throw err;
  }
}

async function pressPlay(page) {
  const gateOpen = await page.evaluate(() => !document.getElementById('gate').classList.contains('hidden'));
  if (gateOpen) await clickSel(page, '#gate');
  await clickSel(page, '#playBtn');
}

const togglePlay = (page) => clickSel(page, '#playBtn');

const snapshot = (page) => page.evaluate(() => window.__sync.snapshot());
const samples = (page) => page.evaluate(() => window.__sync.samples.slice(-400));

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1440,900',
    // Without these, Chrome defers media loading in the *backgrounded* of the
    // two tabs and the video sits at readyState 0 forever. That is a headless
    // harness artefact (a real viewer's tab is foregrounded), not app behaviour.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

let a;
let b;
let c;

try {
  await step('1. Two clients join the room', async () => {
    a = await newClient(browser, 'Kaleina');
    b = await newClient(browser, 'Rin');
    const users = (await snapshot(a)).users;
    assert.equal(users, 2, 'both clients should be in the room');
    pass('both clients connected', `${users} viewers`);
  });

  await step('2. First client loads an episode and starts it', async () => {
    await startEpisode(a);
    if (process.env.DEBUG_E2E) console.log('  after startEpisode:', await a.evaluate(() => ({
      snap: window.__sync.snapshot(),
      video: (() => { const v = document.querySelector('video'); return { ready: v.readyState, paused: v.paused, src: v.src.slice(-12) }; })(),
      gate: !document.getElementById('gate').classList.contains('hidden'),
    })));
    await pressPlay(a);
    if (process.env.DEBUG_E2E) {
      await sleep(2500);
      console.log('  after pressPlay:', await a.evaluate(() => ({
        snap: window.__sync.snapshot(),
        video: (() => { const v = document.querySelector('video'); return { ready: v.readyState, paused: v.paused, t: v.currentTime }; })(),
        sent: (window.__sent || []).filter((m) => m.t !== 'ping' && m.t !== 'latency').slice(-6),
        states: (window.__states || []).slice(-4),
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      })));
      console.log('  B:', await b.evaluate(() => ({ snap: window.__sync.snapshot(), sent: (window.__sent || []).filter((m) => m.t !== 'ping').slice(-4) })));
    }
    await a.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && !v.paused && v.readyState >= 3;
      },
      { polling: 50, timeout: 20000 },
    );
    const snap = await snapshot(a);
    assert.equal(snap.playing, true);
    pass('playback started', `t=${snap.currentTime.toFixed(2)}s, rtt ${snap.rtt}ms, clock offset ${snap.offset}ms`);
  });

  await step('3. Second client follows the room automatically', async () => {
    await b.waitForFunction(
      () => {
        const v = document.querySelector('video');
        const s = window.__sync?.snapshot?.();
        if (!v || !v.src || !s || v.readyState < 3) return false;
        return Math.abs(v.currentTime - s.expected) < 1.0 || v.currentTime > 1;
      },
      { polling: 50, timeout: 25000 },
    );
    await sleep(800);
    const [sa, sb] = [await snapshot(a), await snapshot(b)];
    const gap = Math.abs(sa.currentTime - sb.currentTime);
    assert.ok(gap < 1.5, `late joiner should land near the room position, gap was ${gap.toFixed(2)}s`);
    pass('late joiner joined mid-playback', `gap ${(gap * 1000).toFixed(0)}ms`);
  });

  await step('4. Sustained drift over ~12 seconds', async () => {
    await sleep(12000);
    const [sa, sb] = [await samples(a), await samples(b)];

    // Align the two logs on the server clock.
    const byTime = new Map(sa.map((s) => [s.t, s.pos]));
    const pairs = [];
    for (const sample of sb) {
      let best = null;
      for (const [t, pos] of byTime) {
        const delta = Math.abs(t - sample.t);
        if (delta <= 150 && (!best || delta < best.delta)) best = { delta, pos };
      }
      if (best) pairs.push({ t: sample.t, a: best.pos, b: sample.pos });
    }

    assert.ok(pairs.length >= 25, `not enough aligned samples (${pairs.length})`);
    const gaps = pairs.map((p) => Math.abs(p.a - p.b)).sort((x, y) => x - y);
    const median = gaps[Math.floor(gaps.length / 2)];
    const max = gaps[gaps.length - 1];
    const p95 = gaps[Math.floor(gaps.length * 0.95)];

    // Drift of each client against the room's own anchor.
    const errA = sa.map((s) => Math.abs(s.pos - s.exp)).sort((x, y) => x - y);
    const errB = sb.map((s) => Math.abs(s.pos - s.exp)).sort((x, y) => x - y);

    console.log(
      `  client-to-client gap: median ${(median * 1000).toFixed(0)}ms · p95 ${(p95 * 1000).toFixed(0)}ms · max ${(max * 1000).toFixed(0)}ms`,
    );
    console.log(
      `  vs room anchor:      A median ${(errA[Math.floor(errA.length / 2)] * 1000).toFixed(0)}ms, B median ${(errB[Math.floor(errB.length / 2)] * 1000).toFixed(0)}ms`,
    );

    assert.ok(median < 0.15, `median client gap ${median}s is too high`);
    assert.ok(p95 < 0.35, `p95 client gap ${p95}s is too high`);
    pass('clients stayed aligned', `${pairs.length} aligned samples, median ${(median * 1000).toFixed(0)}ms`);

    const snapA = await snapshot(a);
    assert.equal(snapA.rate, 1, 'player should have settled back to 1.0x');
    pass('no lingering rate nudge', `rate ${snapA.rate}`);
  });

  await step('5. Pause propagates', async () => {
    await togglePlay(a);
    await sleep(1500);
    const [snapA, snapB, pausedB] = [
      await snapshot(a),
      await snapshot(b),
      await b.evaluate(() => document.querySelector('video').paused),
    ];
    assert.equal(snapA.playing, false);
    assert.equal(snapB.playing, false);
    assert.equal(pausedB, true, 'second client should be paused too');
    const gap = Math.abs(snapA.currentTime - snapB.currentTime);
    assert.ok(gap < 0.4, `paused positions differ by ${gap.toFixed(3)}s`);
    pass('pause mirrored', `both paused at ~${snapA.currentTime.toFixed(2)}s (gap ${(gap * 1000).toFixed(0)}ms)`);
  });

  await step('6. Seek propagates while paused, then resume', async () => {
    await a.evaluate(() => {
      const seek = document.getElementById('seek');
      seek.value = '60';
      seek.dispatchEvent(new Event('change'));
    });
    await sleep(1200);
    const [snapA, snapB] = [await snapshot(a), await snapshot(b)];
    assert.ok(Math.abs(snapA.currentTime - 60) < 1.5, `A landed at ${snapA.currentTime}`);
    assert.ok(Math.abs(snapB.currentTime - 60) < 1.5, `B landed at ${snapB.currentTime}`);
    pass('seek mirrored', `A ${snapA.currentTime.toFixed(2)}s · B ${snapB.currentTime.toFixed(2)}s`);

    await togglePlay(a);
    await sleep(4000);
    const [resumedA, resumedB] = [await snapshot(a), await snapshot(b)];
    assert.equal(resumedA.playing, true);
    assert.equal(resumedB.playing, true);
    const gap = Math.abs(resumedA.currentTime - resumedB.currentTime);
    assert.ok(gap < 0.4, `resumed gap ${gap}s`);
    pass('resume mirrored', `both playing, gap ${(gap * 1000).toFixed(0)}ms`);
  });

  await step('7. Room capacity is enforced at three', async () => {
    await newClient(browser, 'Third');
    const thirdUsers = (await snapshot(a)).users;
    assert.equal(thirdUsers, 3);
    pass('third seat accepted', `${thirdUsers} viewers`);

    const fourth = await browser.newPage();
    await fourth.goto(BASE, { waitUntil: 'domcontentloaded' });
    await fourth.waitForSelector('#nameInput');
    await fourth.evaluate(() => {
      document.getElementById('nameInput').value = 'Gatecrasher';
    });
    await clickSel(fourth, '#joinForm button[type=submit]');
    await fourth.waitForFunction(
      () => {
        const modal = document.getElementById('join');
        return !modal.classList.contains('hidden') && /full/i.test(document.getElementById('joinError').textContent);
      },
      { polling: 50, timeout: 8000 },
    );
    pass('fourth client rejected', 'room full message shown');
    await fourth.close();
  });

  await step('8. Chat reaches everyone', async () => {
    await clickSel(a, '[data-tab="chat"]');
    await a.evaluate(() => {
      document.getElementById('chatInput').value = 'synced and ready';
    });
    await clickSel(a, '#chatForm button[type=submit]');
    await b.waitForFunction(
      () => [...document.querySelectorAll('#messages .bubble')].some((n) => n.textContent.includes('synced and ready')),
      { polling: 50, timeout: 6000 },
    );
    pass('chat delivered');
  });

  await step('9. Screenshots for a human to judge', async () => {
    await a.screenshot({ path: '/tmp/anisync-a.png' });
    await b.screenshot({ path: '/tmp/anisync-b.png' });
    pass('screenshots saved', '/tmp/anisync-a.png, /tmp/anisync-b.png');
  });

  await step('10. No uncaught browser errors', async () => {
    assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(' | ')}`);
    pass('console is clean');
  });

  console.log(`\n✅ ${results.length} checks passed\n`);
} catch (err) {
  console.error(`\n❌ FAILED: ${err.message}\n`);
  if (a) await a.screenshot({ path: '/tmp/anisync-fail-a.png' }).catch(() => {});
  if (b) await b.screenshot({ path: '/tmp/anisync-fail-b.png' }).catch(() => {});
  console.error('browser errors:', browserErrors.join('\n') || 'none');
  await browser.close();
  process.exit(1);
}

await browser.close();
process.exit(0);
