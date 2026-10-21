import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { run, ffprobeJson, detectEncoder, encoderArgs, parseProgress } from './ffmpeg.js';
import { assToVtt } from './assToVtt.js';
import { findSidecars } from './sidecars.js';

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.flv']);
const PROBE_VERSION = 3;
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff2']);

export const isMediaId = (id) => typeof id === 'string' && /^[0-9a-f]{12}$/.test(id);

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Free bytes on the filesystem holding `dir`, or Infinity when unknown. */
export async function freeBytes(dir) {
  try {
    const st = await fs.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

/** Enough ISO-639 codes to label a menu; anything else shows the raw tag. */
const LANGUAGES = {
  jpn: 'Japanese',
  ja: 'Japanese',
  eng: 'English',
  en: 'English',
  spa: 'Spanish',
  es: 'Spanish',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  ger: 'German',
  deu: 'German',
  de: 'German',
  ita: 'Italian',
  it: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  rus: 'Russian',
  ru: 'Russian',
  kor: 'Korean',
  ko: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  und: '',
};

const languageName = (code) => {
  if (!code) return '';
  const key = String(code).toLowerCase();
  return LANGUAGES[key] ?? key.toUpperCase();
};

const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

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
    this.preparingIds = new Set();
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
      // Kept per directory so sidecar tracks can be matched without another
      // readdir for every episode.
      const dirNames = new Map();
      const walk = async (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        dirNames.set(dir, entries.filter((e) => e.isFile()).map((e) => e.name));
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full);
        }
      };
      await walk(this.mediaDir, 0);

      const next = new Map();
      const pending = [];
      const stats = await mapLimit(found, 8, async (full) => {
        try {
          return { full, stat: await fs.stat(full) };
        } catch {
          return null;
        }
      });

      for (const entry of stats) {
        if (!entry) continue;
        const { full, stat } = entry;
        const rel = path.relative(this.mediaDir, full);
        const id = idFor(rel);
        const previous = this.items.get(id);
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          // Unchanged file — but the cache behind it may not be. Without this
          // check a wiped or half-written cache keeps claiming to be prepared
          // and every viewer gets a 404 on a URL the UI said was ready.
          if (previous.prepared && !(await this.#preparedMeta(previous))) {
            previous.prepared = false;
            previous.bakedSubs = false;
            previous.hasClean = false;
            previous.progress = 0;
          }
          // Sidecars can appear or disappear without the episode changing.
          this.#applySidecars(previous, findSidecars(path.basename(full), dirNames.get(path.dirname(full)) ?? []));
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
          hasClean: false,
          progress: 0,
          error: null,
        };
        next.set(id, item);
        pending.push(item);
      }

      // Probing is one ffprobe per new file; a few in parallel turns a
      // 200-episode library from ~11 s of serial work into ~2 s.
      await mapLimit(pending, 8, async (item) => {
        try {
          Object.assign(item, await this.#probe(item));
        } catch (err) {
          item.error = `probe failed: ${err.message}`;
        }
        this.#applySidecars(item, findSidecars(path.basename(item.rel), dirNames.get(path.dirname(item.path)) ?? []));
        const meta = await this.#preparedMeta(item);
        item.prepared = Boolean(meta);
        item.bakedSubs = Boolean(meta?.bakedSubs);
        item.hasClean = Boolean(meta?.variants?.clean) && fss.existsSync(path.join(this.cacheDirFor(item.id), 'video.clean.mp4'));
        item.altHeights = {};
        for (const [height, kinds] of Object.entries(meta?.variants?.heights || {})) {
          const present = (kinds || []).filter((kind) => fss.existsSync(this.#heightPath(item.id, Number(height), kind === 'clean')));
          if (present.length) item.altHeights[height] = present;
        }
      });

      this.items = next;
      await this.#collectGarbage(next);
      return this.list();
    })().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async #probe(item) {
    const cached = await this.#readJson(path.join(this.cacheDirFor(item.id), 'probe.json'));
    // Bump PROBE_VERSION whenever the shape of `data` changes, or existing
    // installs keep serving stale metadata (this is how audio tracks went
    // missing after sidecar support landed).
    if (cached && cached.version === PROBE_VERSION && cached.stamp === `${item.size}:${item.mtimeMs}`) {
      return { ...cached.data, subs: cached.data.subs ?? [], audios: cached.data.audios ?? [], fonts: [] };
    }

    const info = await ffprobeJson(item.path);
    const streams = info.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const audio = audioStreams[0];
    const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

    const subs = subStreams.map((s, i) => ({
      index: i,
      stream: i,
      codec: s.codec_name,
      lang: s.tags?.language || '',
      label: s.tags?.title || s.tags?.language || `Track ${i + 1}`,
      bitmap: BITMAP_SUBS.has(s.codec_name),
      default: Boolean(s.disposition?.default),
      file: `${i}.ass`,
      vtt: `${i}.vtt`,
    }));

    const audios = audioStreams.map((s, i) => ({
      index: i,
      stream: i,
      codec: s.codec_name,
      lang: (s.tags?.language || '').toLowerCase(),
      label: s.tags?.title || languageName(s.tags?.language) || `Audio track ${i + 1}`,
      channels: s.channels || 0,
      muxed: i === 0,
    }));

    // HDR cannot be handed to a browser untouched: without a tone map every
    // frame comes out washed out and grey. Dolby Vision rides on top of the
    // HDR10 base layer, so the same tone map covers it.
    const dovi = (video?.side_data_list || []).find((sd) => /dovi/i.test(sd.side_data_type || ''));
    const transfer = video?.color_transfer || '';
    const hdr = ['smpte2084', 'arib-std-b67'].includes(transfer) || Boolean(dovi);

    const duration = Number(info.format?.duration) || Number(video?.duration) || 0;
    const data = {
      duration,
      width: video?.width || 0,
      height: video?.height || 0,
      videoCodec: video?.codec_name || null,
      pixFmt: video?.pix_fmt || null,
      hdr,
      doviProfile: dovi?.dv_profile ?? null,
      colorTransfer: transfer || null,
      audioCodec: audio?.codec_name || null,
      hasAudio: Boolean(audio),
      audios,
      subs,
      title: info.format?.tags?.title?.trim() || item.title,
    };
    await fs.mkdir(this.cacheDirFor(item.id), { recursive: true });
    await fs.writeFile(
      path.join(this.cacheDirFor(item.id), 'probe.json'),
      JSON.stringify({ version: PROBE_VERSION, stamp: `${item.size}:${item.mtimeMs}`, data }, null, 2),
    );
    return data;
  }

  /**
   * Attach external subtitle/audio files that sit beside the episode.
   *
   * Embedded tracks keep their indexes; sidecars are numbered after them. If the
   * container carries no audio at all but a dub sits next to it, that dub
   * becomes the default track so the episode is not silent.
   */
  #applySidecars(item, { subs: subFiles, audios: audioFiles }) {
    const embeddedSubs = (item.embeddedSubs ?? item.subs ?? []).filter((s) => s.origin !== 'sidecar');
    const embeddedAudios = (item.embeddedAudios ?? item.audios ?? []).filter((a) => a.origin !== 'sidecar');
    item.embeddedSubs = embeddedSubs;
    item.embeddedAudios = embeddedAudios;

    const dir = path.dirname(item.path);
    const subs = embeddedSubs.map((s, i) => ({ ...s, origin: s.origin ?? 'embedded', index: i, file: `${i}.ass`, vtt: `${i}.vtt` }));
    for (const file of subFiles) {
      const index = subs.length;
      subs.push({
        index,
        origin: 'sidecar',
        path: path.join(dir, file.name),
        codec: file.ext.slice(1),
        lang: file.lang,
        label: file.label,
        forced: file.forced,
        bitmap: false,
        default: false,
        file: `${index}.ass`,
        vtt: `${index}.vtt`,
      });
    }

    const audios = embeddedAudios.map((a, i) => ({ ...a, origin: a.origin ?? 'embedded', index: i }));
    for (const file of audioFiles) {
      audios.push({
        index: audios.length,
        origin: 'sidecar',
        path: path.join(dir, file.name),
        codec: file.ext.slice(1),
        lang: file.lang,
        label: file.label,
        channels: 0,
        muxed: false,
      });
    }
    // A silent video with a separate dub: the dub has to be muxed in.
    if (audios.length && !audios.some((a) => a.muxed)) audios[0].muxed = true;

    item.subs = subs;
    item.audios = audios;
    item.hasAudio = audios.length > 0;
  }

  /**
   * Delete what a crash or an aborted upload leaves behind: cache directories
   * for files that no longer exist, half-written renditions, and upload temp
   * files. Runs after every scan, so a restart cleans up by itself.
   */
  async #collectGarbage(items) {
    let cacheEntries = [];
    try {
      cacheEntries = await fs.readdir(this.cacheDir, { withFileTypes: true });
    } catch {
      cacheEntries = [];
    }
    for (const entry of cacheEntries) {
      if (!entry.isDirectory()) continue;
      if (items.has(entry.name) || this.preparingIds.has(entry.name)) continue;
      await fs.rm(path.join(this.cacheDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }

    for (const id of items.keys()) {
      const dir = path.join(this.cacheDir, id);
      let files;
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith('.partial.mp4') && !this.preparingIds.has(id)) {
          await fs.rm(path.join(dir, file), { force: true }).catch(() => {});
        }
      }
    }

    try {
      const libFiles = await fs.readdir(this.mediaDir);
      for (const file of libFiles) {
        if (file.endsWith('.part')) await fs.rm(path.join(this.mediaDir, file), { force: true }).catch(() => {});
      }
    } catch {
      /* media dir may not exist yet */
    }
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
      .map((item) => {
        const version = `${item.size.toString(36)}${Math.round(item.mtimeMs).toString(36)}`;
        return {
          id: item.id,
          title: item.title,
          rel: item.rel,
          size: item.size,
          duration: item.duration,
          height: item.height,
          // What the browser actually receives: a 4K source is streamed at the
          // 1080p cap, never at 2160p.
          streamHeight: Math.min(item.height || 0, config.maxHeight),
          // Surfaced so the library can say "HDR, tone-mapped" instead of
          // leaving people wondering why a 4K release looks different.
          hdr: Boolean(item.hdr),
          doviProfile: item.doviProfile ?? null,
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
          // Only advertise a poster once the prepare step has actually written
          // one, otherwise every unprepared card fetches a 404 and flashes a
          // broken image.
          poster: item.prepared ? `/media/${item.id}/poster.jpg?v=${version}` : null,
          // The version string is what makes `immutable` caching safe: a changed
          // source produces a different URL, so a browser never keeps a stale
          // rendition. Seeks then come out of the local cache with no round trip.
          playbackUrl: `/media/${item.id}/video.mp4?v=${version}`,
          // The same episode without burned-in subtitles, built on demand when
          // someone asks for "off" or for a soft track. Null until then.
          cleanUrl: item.prepared && !item.bakedSubs
            ? `/media/${item.id}/video.mp4?v=${version}`
            : item.hasClean
              ? `/media/${item.id}/video.clean.mp4?v=${version}`
              : null,
          // What the viewer can pick from: the main rendition and any lighter
          // ones that were built (or can be built) for a weaker connection.
          qualities: this.#qualities(item, version),
          audioTracks: (item.audios || []).map((a) => ({
            index: a.index,
            label: a.label,
            lang: a.lang,
            channels: a.channels,
            // Track 0 is inside the video file; the client must not mute it and
            // start a second element for it.
            muxed: Boolean(a.muxed),
            external: a.origin === 'sidecar',
            // Track 0 is muxed into the video, so it needs no separate file.
            url: a.index === 0 ? null : `/media/${item.id}/audio/${a.index}.m4a?v=${version}`,
            missing: Boolean(a.missing),
          })),
          error: item.error,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /** The rendition ladder for one episode: sharpest first. */
  #qualities(item, version) {
    if (!item.prepared) return [];
    const primary = Math.min(item.height || 0, config.maxHeight) || 0;
    const ladder = [
      {
        height: primary,
        url: `/media/${item.id}/video.mp4?v=${version}`,
        cleanUrl: item.bakedSubs
          ? item.hasClean
            ? `/media/${item.id}/video.clean.mp4?v=${version}`
            : null
          : `/media/${item.id}/video.mp4?v=${version}`,
        ready: true,
      },
    ];
    for (const height of config.altHeights) {
      if (!(primary > height)) continue;
      const kinds = item.altHeights?.[height] || [];
      ladder.push({
        height,
        url: kinds.includes('styled') ? `/media/${item.id}/quality/${height}/video.mp4?v=${version}` : null,
        cleanUrl: kinds.includes('clean') ? `/media/${item.id}/quality/${height}/clean.mp4?v=${version}` : null,
        // The styled copy is what the menu checks before switching.
        ready: kinds.includes('styled'),
      });
    }
    return ladder;
  }

  /**
   * Take an episode out of the library: drop its cache and move the file into
   * media/.trash (which the scan ignores). Unlinking outright would make one
   * stray click on a 20 GB episode unrecoverable.
   */
  async remove(id) {
    const item = this.items.get(id);
    if (!item) return null;

    const trashDir = path.join(config.mediaDir, '.trash');
    await fs.mkdir(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(trashDir, `${stamp}__${path.basename(item.path)}`);

    // Sidecars belong to the episode; leaving them behind is exactly the junk
    // this is meant to clear up.
    const attachments = [...(item.subs || []), ...(item.audios || [])]
      .filter((track) => track.origin === 'sidecar' && track.path)
      .map((track) => track.path);

    let trashed = false;
    try {
      await fs.rename(item.path, dest);
      trashed = true;
    } catch (err) {
      // A file on another filesystem (or already gone) cannot be renamed.
      if (err.code !== 'EXDEV' && err.code !== 'ENOENT') throw err;
      await fs.rm(item.path, { force: true });
    }
    for (const file of attachments) await fs.rm(file, { force: true }).catch(() => {});
    await fs.rm(this.cacheDirFor(id), { recursive: true, force: true });

    this.items.delete(id);
    return { trashed, dest, title: item.title };
  }

  /**
   * Make a source file playable in a browser. Idempotent, serialised, and
   * safe to call from several clients at once.
   */
  prepare(id, opts = {}) {
    const item = this.items.get(id);
    if (!item) return Promise.reject(new Error('unknown media'));

    // `variant: 'clean'` is the old spelling of `clean: true`.
    const clean = Boolean(opts.clean ?? opts.variant === 'clean');
    const height = opts.height ? Number(opts.height) : null;

    // A lower-resolution copy (e.g. 720p) sits beside the main rendition; the
    // source file is never touched, so switching back to the sharper one costs
    // nothing.
    if (height) {
      const key = `${id}:h${height}${clean ? 'c' : ''}`;
      if (this.#hasHeight(item, height, clean)) return Promise.resolve(this.list().find((m) => m.id === id));
      // The subtitle/font extraction a variant bakes from comes from the primary
      // prepare, so make sure that exists first.
      const ready = item.prepared ? Promise.resolve() : this.prepare(id);
      return ready.then(() => this.#enqueue(key, () => this.#prepareHeight(item, height, clean)));
    }

    // The subtitle-free rendition only makes sense for an episode that already
    // plays, so build the primary one first.
    if (clean) {
      if (!item.prepared) return this.prepare(id).then(() => this.prepare(id, { clean: true }));
      if (item.hasClean && !item.preparingClean) return Promise.resolve(this.list().find((m) => m.id === id));
      return this.#enqueue(`${id}:clean`, () => this.#prepareClean(item));
    }

    if (item.prepared && !item.preparing) return Promise.resolve(this.list().find((m) => m.id === id));
    return this.#enqueue(id, () => this.#prepare(item));
  }

  /** Is this height already built (and still on disk)? */
  #hasHeight(item, height, clean) {
    const heights = item.altHeights || {};
    if (!heights[height]?.includes(clean ? 'clean' : 'styled')) return false;
    return fss.existsSync(this.#heightPath(item.id, height, clean));
  }

  #heightPath(id, height, clean) {
    return path.join(this.cacheDirFor(id), clean ? `video.${height}.clean.mp4` : `video.${height}.mp4`);
  }

  /** Serialise heavy work; one encode at a time, deduplicated by key. */
  #enqueue(key, work) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = this.chain.then(work);
    this.chain = task.catch(() => {}); // keep the queue alive after a failure
    const done = task.finally(() => this.inflight.delete(key));
    this.inflight.set(key, done);
    return done;
  }

  /**
   * The same episode with no burned-in subtitles. Burned text cannot be turned
   * off or swapped, so soft subtitle tracks need a subtitle-free picture; it is
   * only ever built when someone actually asks for one.
   */
  async #prepareClean(item) {
    const dir = this.cacheDirFor(item.id);
    const out = path.join(dir, 'video.clean.mp4');
    const tmp = path.join(dir, 'video.clean.partial.mp4');
    item.preparingClean = true;
    this.preparingIds.add(item.id);

    try {
      this.#progress(item, 1, 'clean');
      const encoder = await detectEncoder(config.encoder);
      const args = await this.#transcodeArgs(item, tmp, encoder, { bakeSub: null });
      const { code, stderr } = await run('ffmpeg', args, {
        cwd: dir,
        stallMs: 120_000,
        maxRuntimeMs: 6 * 3600_000,
        onStdout: (chunk) => {
          const p = parseProgress(chunk);
          if (p.seconds && item.duration) this.#progress(item, 1 + 97 * Math.min(1, p.seconds / item.duration), 'clean');
        },
      });
      if (code !== 0) throw new Error(`subtitle-free encode failed: ${stderr.slice(-400)}`);

      await fs.rename(tmp, out);
      await this.#markClean(item);
      item.hasClean = true;
      this.#progress(item, 100, 'ready');
      this.onEvent({ type: 'variant', id: item.id, variant: 'clean' });
      return this.list().find((m) => m.id === item.id);
    } catch (err) {
      item.error = err.message;
      this.onEvent({ type: 'failed', id: item.id, message: err.message });
      throw err;
    } finally {
      item.preparingClean = false;
      this.preparingIds.delete(item.id);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async #markClean(item) {
    const file = path.join(this.cacheDirFor(item.id), 'meta.json');
    const meta = (await this.#readJson(file)) || {};
    meta.variants = { ...(meta.variants || {}), clean: true };
    await fs.writeFile(file, JSON.stringify(meta, null, 2));
  }

  /**
   * A second rendition at a lower resolution (720p next to 1080p), built on
   * demand so a weak link has something lighter to fall back to. The source
   * file is untouched and the sharper rendition stays on disk, so switching
   * back is instant.
   */
  async #prepareHeight(item, height, clean) {
    const dir = this.cacheDirFor(item.id);
    const out = this.#heightPath(item.id, height, clean);
    const tmp = `${out}.partial.mp4`;
    item.preparingHeight = height;
    this.preparingIds.add(item.id);

    try {
      this.#progress(item, 1, 'quality');
      const encoder = await detectEncoder(config.encoder);
      // Match the main rendition's subtitle choice, so "720p" looks like
      // "1080p", just softer.
      const bakeSub =
        !clean && config.subtitles === 'bake'
          ? ((item.subs || []).find((s) => !s.bitmap && s.file) ?? null)
          : null;
      const args = await this.#transcodeArgs(item, tmp, encoder, { bakeSub, height });
      const { code, stderr } = await run('ffmpeg', args, {
        cwd: dir,
        stallMs: 120_000,
        maxRuntimeMs: 6 * 3600_000,
        onStdout: (chunk) => {
          const p = parseProgress(chunk);
          if (p.seconds && item.duration) this.#progress(item, 1 + 97 * Math.min(1, p.seconds / item.duration), 'quality');
        },
      });
      if (code !== 0) throw new Error(`${height}p encode failed: ${stderr.slice(-400)}`);

      await fs.rename(tmp, out);
      await this.#markHeight(item, height, clean);
      item.altHeights = { ...(item.altHeights || {}), [height]: [...new Set([...(item.altHeights?.[height] || []), clean ? 'clean' : 'styled'])] };
      this.#progress(item, 100, 'ready');
      this.onEvent({ type: 'variant', id: item.id, variant: 'height', height, clean });
      return this.list().find((m) => m.id === item.id);
    } catch (err) {
      item.error = err.message;
      this.onEvent({ type: 'failed', id: item.id, message: err.message });
      throw err;
    } finally {
      item.preparingHeight = null;
      this.preparingIds.delete(item.id);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async #markHeight(item, height, clean) {
    const file = path.join(this.cacheDirFor(item.id), 'meta.json');
    const meta = (await this.#readJson(file)) || {};
    const variants = meta.variants || {};
    const heights = variants.heights || {};
    heights[height] = [...new Set([...(heights[height] || []), clean ? 'clean' : 'styled'])];
    meta.variants = { ...variants, heights };
    await fs.writeFile(file, JSON.stringify(meta, null, 2));
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
    this.preparingIds.add(item.id);
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

      // Running out of space halfway through a two-hour encode costs the whole
      // encode, so refuse to start when the room is obviously not there.
      const need = Math.max(item.size * 2, 1.5 * 1024 ** 3);
      const free = await freeBytes(this.cacheDir);
      if (free < need) {
        throw new Error(`not enough disk space: ${fmtBytes(free)} free, about ${fmtBytes(need)} needed`);
      }

      const encoder = await detectEncoder(config.encoder);
      const bakeSub = config.subtitles === 'bake' ? (subs.find((s) => !s.bitmap) ?? null) : null;
      const args = await this.#transcodeArgs(item, tmp, encoder, { bakeSub });

      const { code, stderr } = await run('ffmpeg', args, {
        cwd: dir, // keeps the subtitles filter path short and quoting-free
        // A wedged encode (bad file, NFS hiccup, OOM pressure) would otherwise
        // occupy the single-slot queue forever.
        stallMs: 120_000,
        maxRuntimeMs: 6 * 3600_000,
        onStdout: (chunk) => {
          const p = parseProgress(chunk);
          if (p.seconds && item.duration) this.#progress(item, 4 + 95 * Math.min(1, p.seconds / item.duration), 'encoding');
        },
      });
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`);

      await fs.rename(tmp, out);

      // Alternate audio tracks become their own AAC files: Chrome has no API for
      // selecting an audio track inside a <video>, so the player swaps a second
      // media element instead. Track 0 stays muxed for sample-accurate sound.
      const extraAudio = (item.audios || []).filter((a) => a.index > 0 && a.codec !== '');
      if (extraAudio.length) {
        await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
        this.#progress(item, 96, 'audio');
        await mapLimit(extraAudio, 2, async (track) => {
          const target = path.join(dir, 'audio', `${track.index}.m4a`);
          const input = track.origin === 'sidecar' ? track.path : item.path;
          const map = track.origin === 'sidecar' ? '0:a:0' : `0:a:${track.stream ?? track.index}`;
          const { code } = await run('ffmpeg', [
            '-hide_banner', '-nostdin', '-y', '-v', 'error',
            '-i', input,
            '-map', map,
            '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart', '-f', 'mp4', target,
          ], { stallMs: 120_000 });
          if (code !== 0) track.missing = true;
        });
      }

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
            variants: { clean: false },
            audios: (item.audios || []).map(({ index, label, lang, channels, missing }) => ({ index, label, lang, channels, missing: Boolean(missing) })),
            duration: item.duration,
            subs: subs.map((s) => ({ index: s.index, file: s.file, vtt: s.vtt, label: s.label })),
            fonts,
          },
          null,
          2,
        ),
      );
      item.bakedSubs = Boolean(bakeSub);
      item.hasClean = false;
      item.prepared = true;
      // Say 100% out loud: the encode's last progress tick lands around 97%,
      // and a client that only hears progress would sit there looking stalled.
      this.#progress(item, 100, 'ready');
      this.onEvent({ type: 'prepared', id: item.id });
      return this.list().find((m) => m.id === item.id);
    } catch (err) {
      item.error = err.message;
      item.progress = 0;
      this.onEvent({ type: 'failed', id: item.id, message: err.message });
      throw err;
    } finally {
      item.preparing = false;
      this.preparingIds.delete(item.id);
      await fs.rm(path.join(dir, 'video.partial.mp4'), { force: true }).catch(() => {});
    }
  }

  async #transcodeArgs(item, out, encoder, { bakeSub = null, height = null } = {}) {
    // A lower-resolution variant scales to that height; the main rendition caps
    // at config.maxHeight.
    const targetHeight = height || config.maxHeight;
    const args = ['-hide_banner', '-nostdin', '-y', '-i', item.path];

    // The default audio track is normally inside the container, but a silent
    // video with a separate dub needs that file as a second input.
    const muxed = (item.audios || []).find((a) => a.muxed) || null;
    const muxedFromSidecar = muxed?.origin === 'sidecar';
    if (muxedFromSidecar) args.push('-i', muxed.path);

    const muxedCodec = muxedFromSidecar ? muxed.codec : item.audioCodec;

    // Remux when the streams are already browser-safe: MKV -> MP4 copy is
    // seconds instead of minutes and loses nothing. Burning subtitles rules
    // that out, since it means re-encoding the picture.
    // Copying is only safe when the streams are browser-friendly *and* the
    // frame size is something we are willing to stream: a 4K H.264 file would
    // otherwise be remuxed untouched and choke a weak client.
    const copyable =
      !bakeSub &&
      !item.hdr &&
      item.videoCodec === 'h264' &&
      item.pixFmt === 'yuv420p' &&
      (!item.height || item.height <= targetHeight) &&
      (!muxedCodec || muxedCodec === 'aac' || muxedCodec === 'mp3');

    args.push('-map', '0:v:0');
    if (copyable) {
      args.push('-c:v', 'copy');
    } else {
      const filters = [];
      // Scale first so libass renders at the final resolution (and so the tone
      // map runs on the smaller frame, which is much cheaper).
      if (item.height > targetHeight) filters.push(`scale=-2:${targetHeight}`);
      // HDR10 / HLG / Dolby Vision -> BT.709 SDR. zscale does the linearisation
      // and primaries conversion, tonemap does the curve; doing this at all is
      // the difference between "washed out grey" and a normal-looking episode.
      if (item.hdr) {
        filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709');
        filters.push('tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
      }
      // Typesetting, signs and karaoke only survive if libass draws them.
      // Paths are relative to the cache dir (see .cwd) so no filter escaping.
      if (bakeSub) filters.push(`subtitles=filename=subs/${bakeSub.file}:fontsdir=fonts`);
      args.push(...encoderArgs(encoder, { crf: config.crf }));
      // A keyframe every two seconds (time-based, so it does not depend on the
      // source fps) is what makes clicking the scrub bar feel instant.
      args.push('-pix_fmt', 'yuv420p', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*2)');
      if (filters.length) args.push('-vf', filters.join(','));
      if (item.hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    }

    if (item.hasAudio && muxed) {
      args.push('-map', muxedFromSidecar ? '1:a:0' : `0:a:${muxed.stream ?? 0}`, '-ac', '2');
      if (copyable && muxedCodec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }

    // Real progress on stdout, so a long encode shows a moving percentage
    // instead of sitting at "1%".
    args.push('-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', out);
    return args;
  }

  async #extractSubs(item, subsDir) {
    const out = [];
    for (const sub of item.subs) {
      if (sub.bitmap) continue; // PGS/DVD bitmap subs cannot become text
      const assPath = path.join(subsDir, sub.file);
      const vttPath = path.join(subsDir, sub.vtt);
      const input = sub.origin === 'sidecar' ? sub.path : item.path;
      const map = sub.origin === 'sidecar' ? ['-map', '0:s:0'] : ['-map', `0:s:${sub.stream ?? sub.index}`];
      const ass = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', input, ...map, '-c:s', 'ass', '-f', 'ass', assPath]);
      if (ass.code !== 0) continue;
      // Convert from the extracted ASS rather than asking ffmpeg for WebVTT:
      // ffmpeg's muxer drops alignment, so a top-of-screen sign would render as
      // bottom-centred dialogue in the soft track.
      const script = await fs.readFile(assPath, 'utf8').catch(() => null);
      if (script) {
        await fs
          .writeFile(vttPath, assToVtt(script, { width: item.width || 1280, height: item.height || 720 }))
          .catch(() => {});
      }
      out.push({ ...sub, hasVtt: Boolean(script) });
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
