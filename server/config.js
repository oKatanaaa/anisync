import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const config = {
  root,
  port: num(process.env.PORT, 8080),
  bind: process.env.BIND || '0.0.0.0',
  password: process.env.PASSWORD || '',

  mediaDir: path.resolve(process.env.MEDIA_DIR || path.join(root, 'media')),
  cacheDir: path.resolve(process.env.CACHE_DIR || path.join(root, 'cache')),

  maxViewers: num(process.env.MAX_VIEWERS, 8),

  /** Scheduled-start lead time, giving slow buffers a chance to catch up. */
  startDelayMs: num(process.env.START_DELAY_MS, 1200),
  seekDelayMs: num(process.env.SEEK_DELAY_MS, 700),

  /** Upload ceiling for a single file (12 GiB). */
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 12 * 1024 ** 3),

  /** 'auto' probes for a hardware encoder, then falls back to libx264. */
  encoder: process.env.ENCODER || 'auto',

  /**
   * How subtitles reach the viewer.
   *   'bake'  — render ASS into the video with libass at encode time (typesetting
   *             survives, no browser wasm, cannot be switched off).
   *   'track' — serve a WebVTT track the browser can toggle (styling is lost).
   *   'off'   — ignore subtitles entirely (raw viewing).
   */
  subtitles: process.env.SUBTITLES || 'bake',

  /** Cap the stored rendition; 1080p is plenty for a laptop screen. */
  maxHeight: num(process.env.MAX_HEIGHT, 1080),
  /**
   * Node kills any HTTP request whose body takes longer than 5 minutes by
   * default, which silently aborted multi-gigabyte uploads. 0 disables it; set
   * a number of milliseconds only if you want a ceiling.
   */
  uploadTimeoutMs: num(process.env.UPLOAD_REQUEST_TIMEOUT, 0),
  /**
   * Extra renditions a viewer can switch to when the sharp one strains the
   * network. Built on demand, stored beside the main one, never replacing it.
   */
  altHeights: (process.env.ALT_HEIGHTS || '720')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0),
  crf: num(process.env.CRF, 21),
  /** Spend more time preparing once to reduce bandwidth throughout playback. */
  x264Preset: process.env.X264_PRESET || 'medium',
  /** 1080p video ceiling, scaled down for smaller renditions. 0 restores uncapped encoding/remuxing. */
  maxVideoKbps: Math.max(0, num(process.env.MAX_VIDEO_KBPS, 3500)),
};
