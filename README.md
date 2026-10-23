# AniSync

A self-hosted watch party for friends. Play, pause and seek stay in sync, with
per-viewer audio, subtitles and quality. Supports MKV, HEVC, ASS subtitles,
embedded fonts and external tracks. Files are prepared once with FFmpeg and cached.

## Deploy with Docker

Requires Docker with the Compose plugin.

Copy `.env.example` to `.env` and set `PASSWORD` to your shared login password.
Set `MEDIA_DIR` and `CACHE_DIR` to existing folders on the Docker host (defaults
`./media` and `./cache`). Keep them separate. On Linux, both must be writable by
UID/GID `1000:1000` and videos readable. For a fresh Linux deployment:

```sh
mkdir -p media cache
sudo chown 1000:1000 media cache
docker compose up -d --build
```

Open **http://localhost:8080** and enter the password. Drag one or more files into
the Library panel or click **Upload**, wait for preparation, then pick an episode.
The room limit is eight viewers.

The image includes Node.js 24, FFmpeg and fonts, runs as a non-root user, and uses
CPU encoding. The deployment includes a health check, automatic restarts and bounded
logs. Videos, uploads, prepared media and saved room state stay in your host
folders. Removing containers, including `docker compose down -v`, keeps both folders.

```sh
docker compose logs -f                  # logs
docker compose ps                      # status and health
docker compose up -d --build            # rebuild after pulling updates
docker compose down                    # stop
```

Change `MEDIA_DIR` and `CACHE_DIR` in `.env` to use other host folders, for example
`/srv/videos` and `/srv/anisync-cache`, or `D:/Videos` and `D:/AniSyncCache` on Windows.
Relative paths resolve from this project for Compose. Copy videos into `MEDIA_DIR`
and click **Rescan folder**. Changing paths does not move existing files; when
upgrading from Docker's media/cache volumes, copy their contents first.
Keep space for the source files, transcodes and HLS packages.

### Let friends connect

AniSync uses one shared password, with no individual accounts. Keep access on a
private network and use HTTPS for remote connections so the password is encrypted.
By default Docker publishes the app only on localhost. For direct LAN access,
set `HOST_BIND=0.0.0.0` in `.env` and use `http://<server-ip>:8080`.

For remote access, install Tailscale on the host and use:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

Friends on your tailnet can open `https://<machine>.<tailnet>.ts.net:8443`.

## Settings

Copy `.env.example` to `.env`, change what you need, then run
`docker compose up -d`. Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_BIND` | `127.0.0.1` | Host interface published by Docker |
| `PORT` | `8080` | Published port (container always uses 8080) |
| `PASSWORD` | required | Shared login password; changing it invalidates existing sessions |
| `MEDIA_DIR` | `./media` | Video folder on the host, mounted into the container |
| `CACHE_DIR` | `./cache` | Prepared media and saved room state folder on the host |
| `MAX_VIEWERS` | `8` | Room capacity |
| `ENCODER` | `x264` | CPU encoding; hardware encoders need GPU access configured separately |
| `SUBTITLES` | `bake` | `bake` preserves ASS styling; `track` uses soft WebVTT; `off` disables subtitles |
| `MAX_HEIGHT` | `1080` | Maximum prepared video height |
| `ALT_HEIGHTS` | `720` | Extra qualities, prepared on demand; e.g. `720,480` |
| `MAX_VIDEO_KBPS` | `3500` | Video bitrate ceiling, scaled down for lower qualities; `0` disables it |
| `CRF` | `21` | Encode quality; lower produces larger files |
| `X264_PRESET` | `medium` | Use `veryfast` for quicker preparation |

Encoding changes apply to future preparations. Existing cached files stay as they are.
Upload limits and playback timing are also configurable in `.env.example`.

## Media and tracks

The player menus select audio, subtitles and quality independently for each
viewer. Turning off burned-in subtitles prepares an extra subtitle-free copy.
Deleting an episode permanently removes its original file, attached tracks and
all prepared copies and cache to reclaim disk space.

External tracks must share the video's full filename stem:

```text
Episode 01.mkv
Episode 01.en.ass
Episode 01.en.forced.srt
Episode 01.ja.m4a
```

## Run locally

Requires Node.js 24+ and FFmpeg/ffprobe on `PATH`, with libx264, libass and zscale
support. Install fonts for subtitle rendering.

```sh
npm ci
npm start
```

Local runs use `./media` and `./cache`; override with `MEDIA_DIR` and `CACHE_DIR`.
`npm start` also reads `.env`; exported environment variables take precedence.
`HOST_BIND` is Compose-only; local runs bind to `0.0.0.0` unless `BIND` is set.
Local runs without `PASSWORD` disable the login check. Compose requires it.
Logins last seven days and survive restarts. The health endpoint reveals only
`{ "ok": true }` without a login.

```sh
npm test                  # server, media and sync checks (requires FFmpeg)
npm run test:ui           # browser checks against a running local server without PASSWORD
npm run test:playback     # isolated playback regression
npm run test:upload-ui    # isolated upload regression
```

Browser checks need Chrome; set `PUPPETEER_EXECUTABLE_PATH` if it is installed
outside the usual location.
