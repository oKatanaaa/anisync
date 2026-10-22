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
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stallMs: 400 });
  const elapsed = Date.now() - started;

  assert.match(result.stderr, /no output for/);
  assert.notEqual(result.code, 0, 'a killed child must not look successful');
  assert.ok(elapsed < 10_000, `watchdog took ${elapsed} ms`);
  assert.equal(runningChildren(), 0, 'the child is reaped');
});

test('a run-away child is stopped by the time limit', async () => {
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { maxRuntimeMs: 500 });
  assert.match(result.stderr, /time limit/);
  assert.notEqual(result.code, 0);
});

test('shutdown kills whatever is still running', async () => {
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
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

test('sidecar subtitle and audio files become switchable tracks', async () => {
  const name = 'Sidecar Episode - 01.mkv';
  const video = path.join(mediaDir, name);
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=320x240:rate=10 -f lavfi -i sine=frequency=440 -t 2 ` +
      `-c:v libx264 -pix_fmt yuv420p -c:a aac -metadata:s:a:0 language=jpn "${video}"`,
    { stdio: 'ignore' },
  );
  await fs.writeFile(
    path.join(mediaDir, 'Sidecar Episode - 01.en.srt'),
    '1\n00:00:00,200 --> 00:00:01,500\nExternal subtitle line.\n',
  );
  execSync(
    `ffmpeg -y -v error -f lavfi -i sine=frequency=880:duration=2 -c:a aac "${path.join(mediaDir, 'Sidecar Episode - 01.eng.m4a')}"`,
    { stdio: 'ignore' },
  );

  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()].find((i) => i.title.startsWith('Sidecar Episode'));
  assert.ok(item, 'episode scanned');
  assert.equal(item.audios.length, 2, 'muxed audio plus the external dub');
  assert.equal(item.audios[1].origin, 'sidecar');
  assert.equal(item.audios[1].lang, 'eng');
  const sidecarSub = item.subs.find((s) => s.origin === 'sidecar');
  assert.ok(sidecarSub, 'external subtitle track found');
  assert.equal(sidecarSub.lang, 'en');
  assert.equal(sidecarSub.label, 'English');

  await library.prepare(item.id);

  const cache = path.join(cacheDir, item.id);
  assert.ok(fss.existsSync(path.join(cache, 'audio', '1.m4a')), 'external dub was converted');
  const vtt = await fs.readFile(path.join(cache, 'subs', sidecarSub.vtt), 'utf8');
  assert.ok(vtt.startsWith('WEBVTT'), 'external subtitle became WebVTT');
  assert.match(vtt, /External subtitle line\./);
  assert.ok(fss.existsSync(path.join(cache, 'subs', sidecarSub.file)), 'and an ASS copy for burn-in');

  // The library payload offers it without leaking server paths.
  const listed = library.list().find((m) => m.id === item.id);
  const audioPayload = listed.audioTracks.find((a) => a.index === 1);
  assert.ok(audioPayload.url.includes('/audio/1.m4a'));
  assert.equal(JSON.stringify(listed).includes(mediaDir), false, 'no absolute paths in the payload');
});

test('a 4K HDR release is streamed at the 1080p cap, tone-mapped to SDR', async () => {
  const name = 'UHD Episode - 01.mkv';
  const video = path.join(mediaDir, name);
  // 2160p, PQ/BT.2020: the case where "just copy the streams" would both keep
  // 4K (too heavy for a laptop or a phone) and leave the picture wiped out.
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=3840x2160:rate=12 -f lavfi -i sine=frequency=440 -t 2 ` +
      `-vf "zscale=pin=bt709:tin=bt709:min=bt709:p=bt2020:t=smpte2084:m=bt2020nc:r=limited,format=yuv420p10le" ` +
      `-c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p10le ` +
      `-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a aac "${video}"`,
    { stdio: 'ignore' },
  );

  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()].find((i) => i.title.startsWith('UHD Episode'));
  assert.ok(item, 'episode scanned');
  assert.equal(item.hdr, true, 'HDR detected from the transfer function');
  assert.equal(item.height, 2160);

  await library.prepare(item.id);

  const probe = JSON.parse(
    execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,color_transfer,pix_fmt -of json ` +
        `"${path.join(cacheDir, item.id, 'video.mp4')}"`,
      { encoding: 'utf8' },
    ),
  ).streams[0];
  assert.equal(probe.height, 1080, 'downscaled to the cap, never streamed at 2160p');
  assert.equal(probe.width, 1920);
  assert.equal(probe.color_transfer, 'bt709', 'tone-mapped to SDR');
  assert.equal(probe.pix_fmt, 'yuv420p', '8-bit, so any browser can decode it');

  const listed = library.list().find((m) => m.id === item.id);
  assert.equal(listed.streamHeight, 1080, 'the UI is told what is actually streamed');
  assert.equal(listed.height, 2160, 'while still knowing the source size');
});

test('a scan sweeps dead .part files but never a live upload', async () => {
  const live = path.join(mediaDir, 'Live Upload - 01.mkv.part');
  const dead = path.join(mediaDir, 'Abandoned Upload - 01.mkv.part');
  await fs.writeFile(live, 'mid-transfer');
  await fs.writeFile(dead, 'crash debris');

  const library = new Library({});
  // A concurrent upload registers its temp file for the life of the transfer.
  library.activeUploads.add(path.basename(live));
  await library.scan();

  assert.equal(fss.existsSync(live), true, 'the in-flight transfer keeps its file');
  assert.equal(fss.existsSync(dead), false, 'genuine debris is still cleaned up');

  // Once the upload finishes (or dies) the name is released and a later scan
  // can clean it up if it is still lying around.
  library.activeUploads.delete(path.basename(live));
  await library.scan();
  assert.equal(fss.existsSync(live), false, 'released temp files are swept');
});

test('a 720p rendition is built beside the 1080p one, leaving it intact', async () => {
  const name = 'Ladder Episode - 01.mkv';
  const file = path.join(mediaDir, name);
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=size=1920x1080:rate=12 -f lavfi -i sine=frequency=440 -t 2 ` +
      `-c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -c:a aac "${file}"`,
    { stdio: 'ignore' },
  );

  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()].find((i) => i.title.startsWith('Ladder Episode'));
  assert.ok(item, 'episode scanned');
  await library.prepare(item.id);

  const primary = path.join(cacheDir, item.id, 'video.mp4');
  const before = fss.statSync(primary).size;
  const beforeHash = execSync(`sha256sum "${primary}"`).toString().split(' ')[0];

  // Before anyone asks for it, the ladder advertises the option as unbuilt.
  let listed = library.list().find((m) => m.id === item.id);
  assert.equal(listed.qualities.length, 2, '1080p and 720p on the ladder');
  assert.equal(listed.qualities[0].height, 1080);
  assert.equal(listed.qualities[1].height, 720);
  assert.equal(listed.qualities[1].url, null, 'not built yet');
  assert.equal(listed.qualities[1].ready, false);

  await library.prepare(item.id, { height: 720 });

  const light = path.join(cacheDir, item.id, 'video.720.mp4');
  assert.ok(fss.existsSync(light), '720p file exists');
  const probe = (file) =>
    JSON.parse(
      execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${file}"`,
        { encoding: 'utf8' },
      ),
    ).streams[0];
  assert.equal(probe(light).height, 720);
  assert.equal(probe(light).width, 1280);

  // The sharp rendition must be untouched: same bytes, same hash.
  assert.equal(fss.statSync(primary).size, before, '1080p size unchanged');
  assert.equal(execSync(`sha256sum "${primary}"`).toString().split(' ')[0], beforeHash, '1080p bytes unchanged');
  assert.equal(probe(primary).height, 1080);

  listed = library.list().find((m) => m.id === item.id);
  assert.ok(listed.qualities[1].url.includes('/quality/720/video.mp4'), listed.qualities[1].url);
  assert.equal(listed.qualities[1].ready, true);

  // Asking again must not re-encode: the mtime stays put.
  const mtime = fss.statSync(light).mtimeMs;
  await library.prepare(item.id, { height: 720 });
  assert.equal(fss.statSync(light).mtimeMs, mtime, 'second request is a no-op');
});

test('deleting an episode takes its file, sidecars and cache with it', async () => {
  makeEpisode('Delete Me - 01.mkv');
  await fs.writeFile(
    path.join(mediaDir, 'Delete Me - 01.en.srt'),
    '1\n00:00:00,200 --> 00:00:01,500\nBye.\n',
  );

  const library = new Library({});
  await library.scan();
  const item = [...library.items.values()].find((i) => i.title.startsWith('Delete Me'));
  assert.ok(item, 'episode scanned');
  assert.equal(item.subs.filter((s) => s.origin === 'sidecar').length, 1, 'sidecar attached');
  await library.prepare(item.id);
  assert.ok(fss.existsSync(path.join(cacheDir, item.id, 'video.mp4')));

  const removed = await library.remove(item.id);
  assert.equal(removed.trashed, true);
  assert.equal(fss.existsSync(path.join(mediaDir, 'Delete Me - 01.mkv')), false, 'source gone from the library');
  assert.equal(fss.existsSync(path.join(mediaDir, 'Delete Me - 01.en.srt')), false, 'sidecar gone too');
  assert.equal(fss.existsSync(path.join(cacheDir, item.id)), false, 'rendition and cache gone');
  assert.equal(library.get(item.id), null, 'no longer listed');
  assert.ok(fss.existsSync(removed.dest), 'kept in media/.trash so a misclick is recoverable');

  // A rescan must not resurrect it from the trash directory.
  const after = new Library({});
  await after.scan();
  assert.equal(
    [...after.items.values()].some((i) => i.title.startsWith('Delete Me')),
    false,
    'the trash folder is not part of the library',
  );
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
