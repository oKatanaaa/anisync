import { BUFFER } from '/shared/playback.js?v=buffering-1';

function rendition(url) {
  const path = new URL(url, location.origin).pathname;
  let match = /^\/media\/([a-f0-9]{12})\/(video(?:\.clean)?\.mp4)$/.exec(path);
  if (match) return { id: match[1], file: match[2] };
  match = /^\/media\/([a-f0-9]{12})\/quality\/(\d+)\/(video|clean)\.mp4$/.exec(path);
  if (match) return { id: match[1], file: `video.${match[2]}${match[3] === 'clean' ? '.clean' : ''}.mp4` };
  match = /^\/media\/([a-f0-9]{12})\/audio\/(\d+\.m4a)$/.exec(path);
  return match ? { id: match[1], file: `audio/${match[2]}` } : null;
}

/** Own source lifetime so delayed manifests and metadata cannot restore an old source. */
export class StreamPlayer {
  constructor(video, { onMetadata }) {
    this.video = video;
    this.onMetadata = onMetadata;
    this.hls = null;
    this.abort = null;
    this.loading = false;
    this.managed = false;
    this.generation = 0;
  }

  destroy() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.hls?.destroy();
    this.hls = null;
    this.loading = false;
    this.managed = false;
  }

  async load(url, { position = 0 } = {}) {
    this.destroy();
    const generation = this.generation;
    const abort = this.abort = new AbortController();
    this.loading = true;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    const current = () => generation === this.generation && !abort.signal.aborted;
    const metadata = () => {
      if (!current() || this.video.readyState < 1) return;
      this.video.removeEventListener('loadedmetadata', metadata);
      this.loading = false;
      this.onMetadata();
    };
    this.video.addEventListener('loadedmetadata', metadata, { signal: abort.signal });
    const native = () => {
      if (!current()) return;
      this.hls?.destroy();
      this.hls = null;
      this.managed = false;
      this.loading = true;
      // A fatal HLS error can occur after initial metadata; restore again on fallback.
      this.video.addEventListener('loadedmetadata', metadata, { signal: abort.signal });
      this.video.src = url;
      this.video.load();
    };
    const source = rendition(url);
    if (!source) return native();
    let timeout;
    try {
      // The player library is large; nickname entry must not wait for it.
      const { default: Hls } = await import('/vendor/hls.mjs?v=1.7.3');
      if (!current()) return;
      const mse = Hls.isSupported();
      if (!mse && !this.video.canPlayType('application/vnd.apple.mpegurl')) return native();
      const requestAbort = new AbortController();
      abort.signal.addEventListener('abort', () => requestAbort.abort(), { once: true });
      timeout = setTimeout(() => requestAbort.abort(), 45_000);
      const response = await fetch(`/api/media/${source.id}/stream?file=${encodeURIComponent(source.file)}`, { signal: requestAbort.signal });
      if (!response.ok) throw new Error(`Stream preparation: HTTP ${response.status}`);
      const { url: manifest } = await response.json();
      if (!current()) return;
      clearTimeout(timeout);
      if (!mse) {
        // Native HLS remains supported, with conservative readiness thresholds.
        this.video.src = manifest;
        this.video.load();
        return;
      }
      this.managed = true;
      const hls = this.hls = new Hls({
        startPosition: Math.max(0, position),
        maxBufferLength: BUFFER.FORWARD,
        maxMaxBufferLength: BUFFER.FORWARD,
        maxBufferSize: 64 * 1024 * 1024,
        backBufferLength: 30,
        // This is stored VOD; chasing a live edge would fight room synchronization.
        lowLatencyMode: false,
        enableWebVTT: false,
      });
      let recoveredMedia = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!current() || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
          recoveredMedia = true;
          hls.recoverMediaError();
        } else {
          console.warn('Segmented playback failed; falling back to MP4', data.details);
          native();
        }
      });
      hls.loadSource(manifest);
      hls.attachMedia(this.video);
    } catch (err) {
      // Replaced sources are cancelled; a timed-out preparation uses the MP4.
      if (!current()) return;
      console.warn('Segmented playback unavailable; using MP4', err.message);
      native();
    } finally {
      clearTimeout(timeout);
    }
  }
}
