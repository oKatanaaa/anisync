# AniSync

A tiny self-hosted watch party for three people. One machine holds the media, everyone else opens a browser, and play/pause/seek follow the room — because the server is authoritative about a single `(position, timestamp, rate)` anchor and every client chases it.

Built for anime files specifically: 10-bit HEVC in Matroska, ASS subtitles with typesetting, embedded fonts.

```
┌──────────────┐   WebSocket (tiny JSON)   ┌────────────────────────────┐
│  browser A   │ ◀───────────────────────▶ │  sync server (Node)        │
└──────────────┘                           │  · room state = one anchor │
┌──────────────┐                           │  · media library + cache   │
│  browser B   │ ◀───────────────────────▶ │  · ffmpeg transcode queue  │
└──────────────┘                           └────────────────────────────┘
      │                                                  │
      └──────────── HTTP Range (video.mp4) ──────────────┘
```

## How the sync works

The server never streams frames. It stores:

```js
{ playing, position, anchor /* server ms */, rate }
```

Clients reconstruct the expected position — `position + (serverNow - anchor) * rate` — and run a correction loop four times a second:

| drift | action |
| --- | --- |
| < 80 ms | nothing (chasing noise is worse) |
| 80–600 ms | nudge `playbackRate` by up to ±5 %, pitch preserved |
| > 600 ms | hard seek |

Clock offset comes from NTP-style pings over the WebSocket (`offset = sts - (t0 + t3) / 2`), keeping the lowest-RTT sample from a sliding window. Play and seek are scheduled with a short lead time so everyone starts together instead of drifting in from different buffer states.

Measured on two clients in the same browser, 12 s of continuous playback: **median gap 15–63 ms, p95 ≤ 186 ms**, and it settles back to exactly 1.0× rather than hunting.

## Media pipeline

Browsers cannot decode what anime ships in, so each file is prepared once, in the background, on demand:

1. `ffprobe` → duration, resolution, codecs, subtitle tracks.
2. Text subtitle tracks are extracted to `.ass` (and `.vtt`), embedded font attachments dumped out of the MKV.
3. Video is re-encoded to H.264 8-bit + AAC stereo, `+faststart`, 2 s keyframe interval, capped at 1080p. Already-safe sources are remuxed with `-c copy` instead.
4. Subtitles are **burned in** with libass (`SUBTITLES=bake`), which preserves ASS typesetting, signs and karaoke exactly, and needs no browser-side WASM.
5. A poster frame is grabbed for the library grid.

Everything lands in `cache/<id>/` keyed by the source's size+mtime, so restarts and re-scans never re-encode.

## Running it

```bash
npm install
npm start          # http://0.0.0.0:8080
```

Put video files in `media/` (or upload them from the Library panel) and press **Prepare**.

### Over Tailscale (recommended)

Tailscale gives you a private network and a real TLS certificate, with no port forwarding and no exposure to the internet:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

Friends join your tailnet (free plan covers 6 users), open `https://<machine>.<tailnet>.ts.net:8443`, and type a name. That is the entire login flow — the network is the auth boundary.

## Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WS port |
| `BIND` | `0.0.0.0` | interface to bind |
| `MEDIA_DIR` | `./media` | where source files live |
| `CACHE_DIR` | `./cache` | transcodes, posters, subtitles |
| `MAX_VIEWERS` | `3` | hard seat limit, enforced server-side |
| `SUBTITLES` | `bake` | `bake` \| `track` (soft WebVTT) \| `off` |
| `ENCODER` | `auto` | `auto` \| `nvenc` \| `vaapi` \| `x264` |
| `MAX_HEIGHT` | `1080` | cap for the stored rendition |
| `CRF` | `21` | x264 quality (lower = bigger/better) |
| `START_DELAY_MS` | `1200` | lead time on a scheduled start |
| `SEEK_DELAY_MS` | `700` | lead time after a seek |

## Testing

```bash
npm test               # sync math: clock offset, drift decisions, 60 s simulation
npm run test:e2e       # two real Chrome clients against a running server
```

The end-to-end test joins two clients, starts an episode, lets it play for 12 s, then asserts:

- both clients stay within the p95 window of each other (aligned on the server clock, not wall clock)
- a late joiner lands on the room position
- pause, seek and resume propagate
- the fourth client is refused
- chat arrives
- no uncaught browser errors

## Layout

```
server/
  index.js    HTTP routes, WebSocket transport, upload
  rooms.js    authoritative room state machine (no sockets inside)
  media.js    library scan, probe, transcode queue, subtitle/font extraction
  ffmpeg.js   process helpers, encoder probing, progress parsing
shared/
  sync.js     pure sync math — imported by the browser *and* the tests
public/
  index.html  app shell
  app.js      player, drift loop, chat, library UI
  style.css   dark glass UI
test/
  sync.test.js  unit tests
  e2e.mjs       two-client Chrome test
  make-fixture.sh  builds a nasty test file (10-bit HEVC + ASS + font attachment)
```

## Deliberate limits

- **Three seats.** It is a room for friends, not a platform; capacity is enforced on the server.
- **One room.** No accounts, no rooms list. The network (Tailscale) is the auth boundary.
- **Subtitles are baked in by default.** Toggle-free, but nothing to switch off. Set `SUBTITLES=track` to serve soft WebVTT (toggleable, styling lost). Bitmap subtitles (PGS/DVD) are skipped in track mode and are not burned.
- **No voice chat.** Use Discord; it is better at that than this will ever be.
- **You are the redistributor.** Keep the room to people who already have the files.
