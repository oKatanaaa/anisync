import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { HlsCache, isRendition, isHlsAsset } from '../server/hls.js';
import { run, ffprobeJson, encoderArgs, videoRateLimit } from '../server/ffmpeg.js';

test('packaging is reusable, complete, timestamp-aligned, and leaves the MP4 intact', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-hls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'abc123abc123';
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  const file = path.join(dir, 'video.mp4');
  const encoded = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-preset', 'fast', '-g', '48',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  assert.equal(encoded.code, 0, encoded.stderr);
  const hash = async () => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = await hash();
  const cache = new HlsCache(root);
  const [a, b] = await Promise.all([cache.ensure(id, 'video.mp4'), cache.ensure(id, 'video.mp4')]);
  assert.deepEqual(a, b, 'concurrent viewers use one published package');
  const manifestPath = path.join(root, a.url.replace(`/media/${id}/`, `${id}/`));
  const manifest = await fs.readFile(manifestPath, 'utf8');
  assert.match(manifest, /#EXT-X-ENDLIST/);
  const mp4 = await ffprobeJson(file);
  const hls = await ffprobeJson(manifestPath);
  const firstVideo = (probe) => probe.streams.find((s) => s.codec_type === 'video');
  assert.ok(Math.abs(Number(firstVideo(mp4).start_time) - Number(firstVideo(hls).start_time)) < 0.01,
    'B-frame timestamp offsets must not move the episode timeline');
  const decode = await run('ffmpeg', ['-v', 'error', '-i', manifestPath, '-f', 'null', '-']);
  assert.equal(decode.code, 0, decode.stderr);
  assert.equal(await hash(), before);
  assert.deepEqual(await cache.ensure(id, 'video.mp4'), a);
  const segment = manifest.split(/\r?\n/).find((line) => line.endsWith('.m4s'));
  await fs.rm(path.join(path.dirname(manifestPath), segment));
  await cache.ensure(id, 'video.mp4');
  assert.ok((await fs.stat(path.join(path.dirname(manifestPath), segment))).size > 0, 'a missing fragment is repaired');

  const audio = path.join(dir, 'audio', '1.m4a');
  const extracted = await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vn', '-c:a', 'copy', audio]);
  assert.equal(extracted.code, 0, extracted.stderr);
  const audioPackage = await cache.ensure(id, 'audio/1.m4a');
  const audioProbe = await ffprobeJson(path.join(root, audioPackage.url.replace(`/media/${id}/`, `${id}/`)));
  assert.equal(audioProbe.streams.length, 1);
  assert.equal(audioProbe.streams[0].codec_type, 'audio');
  assert.ok(Math.abs(Number(audioProbe.streams[0].start_time)) < 0.05);

  const stat = await fs.stat(file);
  await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000));
  const changed = await cache.ensure(id, 'video.mp4');
  assert.notEqual(changed.url, a.url, 'changed media gets a fresh immutable URL');
});

test('streaming asset names cannot escape the episode cache', () => {
  for (const name of ['video.mp4', 'video.clean.mp4', 'video.720.mp4', 'video.720.clean.mp4', 'audio/1.m4a']) assert.ok(isRendition(name));
  for (const name of ['../video.mp4', 'audio/../video.mp4', 'audio\\1.m4a', 'meta.json', undefined, ['video.mp4']]) assert.equal(isRendition(name), false);
  assert.ok(isHlsAsset('segment-00001.m4s'));
  assert.equal(isHlsAsset('../init.mp4'), false);
});

test('bounded quality encoding keeps the selected resolution and limits video bitrate', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anisync-rate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.ok(videoRateLimit(720, 3500) < videoRateLimit(1080, 3500));
  assert.equal(videoRateLimit(720, 0), 0);
  const file = path.join(dir, 'bounded.mp4');
  const result = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-t', '8', ...encoderArgs('x264', { crf: 10, maxrateKbps: 300 }), '-pix_fmt', 'yuv420p', file]);
  assert.equal(result.code, 0, result.stderr);
  const probe = await ffprobeJson(file);
  assert.equal(probe.streams[0].width, 640);
  assert.equal(probe.streams[0].height, 360);
  assert.equal(probe.streams[0].pix_fmt, 'yuv420p');
  assert.ok(Number(probe.streams[0].bit_rate) < 400_000, `video bitrate ${probe.streams[0].bit_rate}`);
});
