import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './ffmpeg.js';

export const isRendition = (file) => typeof file === 'string' && /^(?:video(?:\.\d+)?(?:\.clean)?\.mp4|audio\/\d+\.m4a)$/.test(file);
export const isHlsAsset = (file) => /^(?:index\.m3u8|init\.mp4|segment-\d{5,}\.m4s)$/.test(file);

/** Package existing MP4s without re-encoding. A changed MP4 gets a new URL. */
export class HlsCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.inflight = new Map();
    this.chain = Promise.resolve();
  }

  async ensure(id, file) {
    if (!/^[0-9a-f]{12}$/.test(id) || !isRendition(file)) throw new Error('Invalid rendition');
    const source = path.join(this.cacheDir, id, file);
    const stat = await fs.stat(source);
    const token = crypto.createHash('sha256').update(`fmp4-v2:${file}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 20);
    const dir = path.join(this.cacheDir, id, 'hls', token);
    const url = `/media/${id}/hls/${token}/index.m3u8`;
    const complete = async () => {
      try {
        const manifest = await fs.readFile(path.join(dir, 'index.m3u8'), 'utf8');
        if (!manifest.includes('#EXT-X-ENDLIST')) return false;
        const assets = ['init.mp4', ...manifest.split(/\r?\n/).filter((line) => isHlsAsset(line))];
        await Promise.all(assets.map((asset) => fs.access(path.join(dir, asset))));
        return true;
      } catch { return false; }
    };
    const key = `${id}:${token}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = this.chain.then(async () => {
      if (await complete()) return { url };
      const space = await fs.statfs(path.dirname(source)).catch(() => null);
      if (space && space.bavail * space.bsize < stat.size * 1.05 + 64 * 1024 ** 2) {
        throw new Error('Not enough free space for segmented playback');
      }
      const temp = `${dir}.partial`;
      await fs.rm(temp, { recursive: true, force: true });
      await fs.mkdir(temp, { recursive: true });
      try {
        const { code, stderr } = await run('ffmpeg', [
          '-hide_banner', '-nostdin', '-y', '-v', 'error', '-copyts', '-start_at_zero', '-i', source,
          '-map', file.startsWith('audio/') ? '0:a:0' : '0:v:0',
          ...(file.startsWith('audio/') ? [] : ['-map', '0:a:0?']), '-c', 'copy', '-sn', '-dn',
          // Preserve presentation time across B-frame video and separate audio.
          // The default negative-DTS shift otherwise moves some renditions ahead.
          '-avoid_negative_ts', 'disabled',
          '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
          '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
          '-hls_segment_filename', 'segment-%05d.m4s', 'index.m3u8',
        ], { cwd: temp, maxRuntimeMs: 120_000 });
        if (code !== 0) throw new Error(`HLS packaging failed: ${stderr.slice(-400)}`);
        const latest = await fs.stat(source);
        if (latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs) throw new Error('Rendition changed while packaging');
        // Replace only this derived, content-versioned directory, never the MP4.
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(temp, dir);
        return { url };
      } finally {
        await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      }
    });
    this.chain = task.catch(() => {});
    const result = task.finally(() => this.inflight.delete(key));
    this.inflight.set(key, result);
    return result;
  }
}
