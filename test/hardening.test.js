import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// The library reads its directories from config at import time, so the temp
// dirs have to exist before the module loads.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-hardening-'));
const mediaDir = path.join(root, 'media');
const cacheDir = path.join(root, 'cache');
await fs.mkdir(mediaDir, { recursive: true });
process.env.MEDIA_DIR = mediaDir;
process.env.CACHE_DIR = cacheDir;

const { Library, freeBytes } = await import('../server/media.js');
const { run, killAll, runningChildren } = await import('../server/ffmpeg.js');

process.on('exit', () => fss.rmSync(root, { recursive: true, force: true }));

const makeEpisode = (name) => {
  const file = path.join(mediaDir, name);
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=160x120:rate=10 -t 1 -c:v libx264 -pix_fmt yuv420p "${file}"`,
    { stdio: 'ignore' },
  );
  return file;
};

test('a silent child is killed by the stall watchdog', async () => {
  const started = Date.now();
  const result = await run('sleep', ['30'], { stallMs: 400 });
  const elapsed = Date.now() - started;

  assert.match(result.stderr, /no output for/);
  assert.notEqual(result.code, 0, 'a killed child must not look successful');
  assert.ok(elapsed < 10_000, `watchdog took ${elapsed} ms`);
  assert.equal(runningChildren(), 0, 'the child is reaped');
});

test('a run-away child is stopped by the time limit', async () => {
  const result = await run('sleep', ['30'], { maxRuntimeMs: 500 });
  assert.match(result.stderr, /time limit/);
  assert.notEqual(result.code, 0);
});

test('shutdown kills whatever is still running', async () => {
  const pending = run('sleep', ['30']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runningChildren(), 1);

  killAll();
  const result = await pending;

  assert.notEqual(result.code, 0);
  assert.equal(runningChildren(), 0);
});

test('free space is readable, so the disk guard can refuse early', async () => {
  const free = await freeBytes(root);
  assert.ok(free === Infinity || free > 0, `free=${free}`);
});

test('a rendition that was deleted stops claiming to be prepared', async () => {
  makeEpisode('Episode 01.mkv');
  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()].find((i) => i.title.startsWith('Episode 01'));
  assert.ok(item, 'episode was scanned');
  assert.ok(item.duration > 0, 'duration probed');

  await library.prepare(item.id);
  assert.equal(library.get(item.id).prepared, true);
  assert.ok(fss.existsSync(path.join(cacheDir, item.id, 'video.mp4')));

  // Same file, same mtime — but the cache behind it is gone.
  await fs.rm(path.join(cacheDir, item.id, 'video.mp4'));
  await library.scan();
  assert.equal(library.get(item.id).prepared, false, 'must not advertise a missing file');
  assert.equal(library.list().find((m) => m.id === item.id).poster, null, 'no poster URL either');

  // And preparing again puts it back.
  await library.prepare(item.id);
  await library.scan();
  assert.equal(library.get(item.id).prepared, true);
});

test('cache garbage from a crash is swept on the next scan', async () => {
  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()][0];

  const orphanDir = path.join(cacheDir, 'deadbeefcafe');
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.writeFile(path.join(orphanDir, 'video.mp4'), 'stale');

  const partial = path.join(cacheDir, item.id, 'video.partial.mp4');
  await fs.writeFile(partial, 'half an encode');

  const abortedUpload = path.join(mediaDir, 'Half Uploaded.mkv.part');
  await fs.writeFile(abortedUpload, 'half an upload');

  await library.scan();

  assert.equal(fss.existsSync(orphanDir), false, 'cache for a deleted file is removed');
  assert.equal(fss.existsSync(partial), false, 'interrupted encode is removed');
  assert.equal(fss.existsSync(abortedUpload), false, 'aborted upload is removed');
  assert.ok(fss.existsSync(path.join(cacheDir, item.id, 'video.mp4')), 'the real rendition survives');
});

test('a probe cache makes the second scan cheap and still correct', async () => {
  makeEpisode('Episode 02.mkv');
  const first = new Library({});
  await first.scan();
  const second = new Library({});
  await second.scan();

  const a = [...first.items.values()].find((i) => i.title.startsWith('Episode 02'));
  const b = [...second.items.values()].find((i) => i.title.startsWith('Episode 02'));
  assert.equal(b.duration, a.duration);
  assert.equal(b.height, a.height);
  assert.ok(fss.existsSync(path.join(cacheDir, b.id, 'probe.json')));
});
