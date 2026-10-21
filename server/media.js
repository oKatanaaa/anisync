import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { run, ffprobeJson, detectEncoder, encoderArgs, parseProgress } from './ffmpeg.js';

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.flv']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff2']);

export const isMediaId = (id) => typeof id === 'string' && /^[0-9a-f]{12}$/.test(id);

const idFor = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);

const tidyTitle = (name) =>
  name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

/**
 * Owns the media library: discovery, probing, and the one-at-a-time transcode
 * queue. Everything the browser can play goes through here, because anime
 * arrives as 10-bit HEVC in Matroska and browsers cannot decode that.
 */
export class Library {
  constructor({ onEvent = () => {} } = {}) {
    this.mediaDir = config.mediaDir;
    this.cacheDir = config.cacheDir;
    this.onEvent = onEvent;
    /** @type {Map<string, object>} */
    this.items = new Map();
    this.inflight = new Map();
    this.scanning = null;
    // Serialise heavy work: two concurrent x264 jobs on a laptop is how you
    // make the party stutter.
    this.chain = Promise.resolve();
  }

  async ensureDirs() {
    await fs.mkdir(this.mediaDir, { recursive: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  cacheDirFor(id) {
    return path.join(this.cacheDir, id);
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      await this.ensureDirs();
      const found = [];
      const walk = async (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full);
        }
      };
      await walk(this.mediaDir, 0);

      const next = new Map();
      for (const full of found) {
        const rel = path.relative(this.mediaDir, full);
        const id = idFor(rel);
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        const previous = this.items.get(id);
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          next.set(id, previous);
          continue;
        }
        const item = {
          id,
          rel,
          path: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          title: tidyTitle(path.basename(rel)),
          duration: 0,
          width: 0,
          height: 0,
          videoCodec: null,
          pixFmt: null,
          audioCodec: null,
          subs: [],
          fonts: [],
          prepared: false,
          preparing: false,
          progress: 0,
          error: null,
        };
        try {
          Object.assign(item, await this.#probe(item));
        } catch (err) {
          item.error = `probe failed: ${err.message}`;
        }
        const meta = await this.#preparedMeta(item);
        item.prepared = Boolean(meta);
        item.bakedSubs = Boolean(meta?.bakedSubs);
        next.set(id, item);
      }
      this.items = next;
      return this.list();
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async #probe(item) {
    const cached = await this.#readJson(path.join(this.cacheDirFor(item.id), 'probe.json'));
    if (cached && cached.stamp === `${item.size}:${item.mtimeMs}`) return { ...cached.data, subs: cached.data.subs ?? [], fonts: [] };

    const info = await ffprobeJson(item.path);
    const streams = info.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audio = streams.find((s) => s.codec_type === 'audio');
    const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

    const subs = subStreams.map((s, i) => ({
      index: i,
      codec: s.codec_name,
      lang: s.tags?.language || '',
      label: s.tags?.title || s.tags?.language || `Track ${i + 1}`,
      bitmap: BITMAP_SUBS.has(s.codec_name),
      default: Boolean(s.disposition?.default),
      file: `${i}.ass`,
      vtt: `${i}.vtt`,
    }));

    const duration = Number(info.format?.duration) || Number(video?.duration) || 0;
    const data = {
      duration,
      width: video?.width || 0,
      height: video?.height || 0,
      videoCodec: video?.codec_name || null,
      pixFmt: video?.pix_fmt || null,
      audioCodec: audio?.codec_name || null,
      hasAudio: Boolean(audio),
      subs,
      title: info.format?.tags?.title?.trim() || item.title,
    };
    await fs.mkdir(this.cacheDirFor(item.id), { recursive: true });
    await fs.writeFile(
      path.join(this.cacheDirFor(item.id), 'probe.json'),
      JSON.stringify({ stamp: `${item.size}:${item.mtimeMs}`, data }, null, 2),
    );
    return data;
  }

  /** Returns the transcode metadata when a valid rendition exists, else null. */
  async #preparedMeta(item) {
    const dir = this.cacheDirFor(item.id);
    const meta = await this.#readJson(path.join(dir, 'meta.json'));
    if (!meta) return null;
    if (meta.stamp !== `${item.size}:${item.mtimeMs}`) return null;
    return fss.existsSync(path.join(dir, 'video.mp4')) ? meta : null;
  }

  async #readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  list() {
    return [...this.items.values()]
      .map((item) => ({
        id: item.id,
        title: item.title,
        rel: item.rel,
        size: item.size,
        duration: item.duration,
        height: item.height,
        videoCodec: item.videoCodec,
        audioCodec: item.audioCodec,
        subs: item.subs
          .filter((s) => !s.bitmap && s.file)
          .map((s) => ({ index: s.index, label: s.label, lang: s.lang, default: s.default, file: s.file, vtt: s.vtt })),
        hasBitmapSubs: item.subs.some((s) => s.bitmap),
        bakedSubs: Boolean(item.bakedSubs),
        fonts: item.fonts,
        prepared: item.prepared,
        preparing: item.preparing,
        progress: item.progress,
        poster: `/media/${item.id}/poster.jpg`,
        playbackUrl: `/media/${item.id}/video.mp4`,
        error: item.error,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /**
   * Make a source file playable in a browser. Idempotent, serialised, and
   * safe to call from several clients at once.
   */
  prepare(id) {
    const item = this.items.get(id);
    if (!item) return Promise.reject(new Error('unknown media'));
    if (item.prepared && !item.preparing) return Promise.resolve(this.list().find((m) => m.id === id));
    if (this.inflight.has(id)) return this.inflight.get(id);

    const task = this.chain.then(() => this.#prepare(item));
    this.chain = task.catch(() => {}); // keep the queue alive after a failure
    this.inflight.set(id, task);
    const done = task.finally(() => this.inflight.delete(id));
    this.inflight.set(id, done);
    return done;
  }

  #progress(item, pct, stage) {
    item.progress = Math.max(0, Math.min(100, Math.round(pct)));
    this.onEvent({ type: 'progress', id: item.id, progress: item.progress, stage });
  }

  async #prepare(item) {
    const dir = this.cacheDirFor(item.id);
    const subsDir = path.join(dir, 'subs');
    const fontsDir = path.join(dir, 'fonts');
    await fs.mkdir(subsDir, { recursive: true });
    await fs.mkdir(fontsDir, { recursive: true });

    item.preparing = true;
    item.error = null;
    item.progress = 0;
    this.#progress(item, 1, 'probing');

    try {
      // Subtitles and artwork first: they are fast and they make the UI feel
      // alive while the long encode runs.
      const subs = await this.#extractSubs(item, subsDir);
      const fonts = await this.#extractFonts(item, fontsDir);
      await this.#extractPoster(item, dir);
      this.#progress(item, 4, 'encoding');

      const out = path.join(dir, 'video.mp4');
      const tmp = path.join(dir, 'video.partial.mp4');
      const encoder = await detectEncoder(config.encoder);
      const bakeSub = config.subtitles === 'bake' ? (subs.find((s) => !s.bitmap) ?? null) : null;
      const args = await this.#transcodeArgs(item, tmp, encoder, { bakeSub });

      const { code, stderr } = await run('ffmpeg', args, {
        cwd: dir, // keeps the subtitles filter path short and quoting-free
        onStdout: (chunk) => {
          const p = parseProgress(chunk);
          if (p.seconds && item.duration) this.#progress(item, 4 + 95 * Math.min(1, p.seconds / item.duration), 'encoding');
        },
      });
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`);

      await fs.rename(tmp, out);
      // Keep the original stream list (including bitmap tracks) and merge in
      // whatever we managed to extract, so the UI can explain what is missing.
      item.subs = item.subs.map((s) => subs.find((x) => x.index === s.index) ?? s);
      item.fonts = fonts;
      await fs.writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify(
          {
            stamp: `${item.size}:${item.mtimeMs}`,
            preparedAt: new Date().toISOString(),
            encoder,
            bakedSubs: Boolean(bakeSub),
            duration: item.duration,
            subs: subs.map((s) => ({ index: s.index, file: s.file, vtt: s.vtt, label: s.label })),
            fonts,
          },
          null,
          2,
        ),
      );
      item.bakedSubs = Boolean(bakeSub);
      item.prepared = true;
      item.progress = 100;
      this.onEvent({ type: 'prepared', id: item.id });
      return this.list().find((m) => m.id === item.id);
    } catch (err) {
      item.error = err.message;
      item.progress = 0;
      this.onEvent({ type: 'failed', id: item.id, message: err.message });
      throw err;
    } finally {
      item.preparing = false;
      await fs.rm(path.join(dir, 'video.partial.mp4'), { force: true }).catch(() => {});
    }
  }

  async #transcodeArgs(item, out, encoder, { bakeSub = null } = {}) {
    const args = ['-hide_banner', '-nostdin', '-y', '-i', item.path];

    // Remux when the streams are already browser-safe: MKV -> MP4 copy is
    // seconds instead of minutes and loses nothing. Burning subtitles rules
    // that out, since it means re-encoding the picture.
    const copyable =
      !bakeSub &&
      item.videoCodec === 'h264' &&
      item.pixFmt === 'yuv420p' &&
      (!item.audioCodec || item.audioCodec === 'aac' || item.audioCodec === 'mp3');

    args.push('-map', '0:v:0');
    if (copyable) {
      args.push('-c:v', 'copy');
    } else {
      const filters = [];
      // Scale first so libass renders at the final resolution.
      if (item.height > config.maxHeight) filters.push(`scale=-2:${config.maxHeight}`);
      // Typesetting, signs and karaoke only survive if libass draws them.
      // Paths are relative to the cache dir (see .cwd) so no filter escaping.
      if (bakeSub) filters.push(`subtitles=filename=subs/${bakeSub.file}:fontsdir=fonts`);
      args.push(...encoderArgs(encoder, { crf: config.crf }));
      args.push('-pix_fmt', 'yuv420p', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0');
      if (filters.length) args.push('-vf', filters.join(','));
    }

    if (item.hasAudio) {
      args.push('-map', '0:a:0', '-ac', '2');
      if (copyable && item.audioCodec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }

    args.push('-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', out);
    return args;
  }

  async #extractSubs(item, subsDir) {
    const out = [];
    for (const sub of item.subs) {
      if (sub.bitmap) continue; // PGS/DVD bitmap subs cannot become text
      const assPath = path.join(subsDir, sub.file);
      const vttPath = path.join(subsDir, sub.vtt);
      const ass = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', item.path, '-map', `0:s:${sub.index}`, '-c:s', 'ass', '-f', 'ass', assPath]);
      if (ass.code !== 0) continue;
      const vtt = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', item.path, '-map', `0:s:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', vttPath]);
      out.push({ ...sub, hasVtt: vtt.code === 0 });
    }
    return out;
  }

  /**
   * Typesetting fonts live inside the MKV as attachments. Without them libass
   * falls back to Arial and anime signs look wrong, so pull them out.
   */
  async #extractFonts(item, fontsDir) {
    const { code } = await run(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-dump_attachment:t', '', '-i', item.path, '-f', 'null', '-'],
      { cwd: fontsDir },
    );
    if (code !== 0) return [];
    let names = [];
    try {
      names = await fs.readdir(fontsDir);
    } catch {
      return [];
    }
    return names.filter((n) => FONT_EXT.has(path.extname(n).toLowerCase())).sort();
  }

  async #extractPoster(item, dir) {
    const at = Math.min(45, Math.max(1, (item.duration || 60) * 0.15));
    await run('ffmpeg', [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      '-ss', String(at), '-i', item.path,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4',
      path.join(dir, 'poster.jpg'),
    ]).catch(() => null);
  }
}
