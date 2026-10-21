import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const config = {
  root,
  port: num(process.env.PORT, 8080),
  bind: process.env.BIND || '0.0.0.0',

  mediaDir: process.env.MEDIA_DIR || path.join(root, 'media'),
  cacheDir: process.env.CACHE_DIR || path.join(root, 'cache'),

  /** The brief: three people, no more. */
  maxViewers: num(process.env.MAX_VIEWERS, 3),

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
  crf: num(process.env.CRF, 21),
};
