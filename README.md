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
npm test          # 72 unit tests: sync math, rooms, hardening, subtitles, sidecars
npm run test:ui   # 131 checks driving the real UI in real Chrome
```

`npm run test:ui` needs the server running. Scenarios whose name matches an
argument run alone:

```bash
npm run test:ui -- "end of episode"
```

Every check asserts on something a person would see or hear — the seat chip, the
drift badge, the toast text, the frame on screen — rather than on internals. The
suite covers joining (including blank names), the library, picking an episode,
play/pause/seek/resume propagation, late joiners, reloading mid-episode, the
host lock and host handover, end of episode, chat (including markup injection
and 500-character walls), keyboard shortcuts, mute/volume, subtitles, upload
validation, long release filenames, returning from another tab, room reset, the
three-seat cap, and surviving a server restart.

Sync quality is measured with **three separate browser processes**, because
Chrome will not buffer video in a backgrounded tab — three tabs in one browser
measures the backgrounding heuristic, not the sync engine. Current numbers on
loopback: median 2 ms, p95 34 ms between the three players.

`test/rooms.test.js` deliberately passes a *transport-shaped* user object
(`{id, name}`, no `isHost`) to `apply()`, because that is exactly what
`server/index.js` does. A test that only ever handed over the stored record hid
a bug that disabled the host lock completely.

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
  sync.test.js      sync math: clock offset, drift decisions, 60 s simulation
  rooms.test.js     room state machine: host, lock, capacity, end of episode, idle reset
  hardening.test.js stall watchdog, child cleanup, cache GC, cache validation
  subtitles.test.js ASS → WebVTT conversion: alignment, position, styling, escaping
  sidecars.test.js  which external files attach to which episode, and their labels
  ui.mjs            user-facing suite (real Chrome, real clicks, screenshots on failure)
  make-tracks-fixture.sh  builds an episode with an embedded track and sidecars
  make-fixture.sh  builds a nasty test file (10-bit HEVC + ASS + font attachment)
```

## Uploading

Big files are the norm here, so the upload panel reports what is actually
happening rather than a bare percentage: bytes sent of the total, current speed,
time left, and — once the bytes have landed — the encode as a separate
**Preparing** phase, because a 4K episode is not watchable the moment it arrives.
Files are queued and sent one at a time (a slow link split three ways is slower
for everyone), and the ✕ cancels the upload in flight; the server deletes its
`.part` file when the socket dies.

**Deleting** is one click on the ✕ at the right of a card, then one confirmation.
The file is moved to `media/.trash/` rather than unlinked (a misclick on a 20 GB
episode should be recoverable), its cache and sidecar files go with it, and the
episode disappears from every viewer's library immediately. If it was the episode
on screen, the room forgets it instead of pointing everyone at a dead file.
Deleting is refused while that episode is still encoding. Empty `media/.trash/`
whenever you are sure.

The upload path itself is not the bottleneck: measured from the server itself it
takes **330 MB/s** for a 300 MB file. What you get on the wire is the network —
over a Tailscale DERP relay expect **~1 MB/s**, over the LAN tens of MB/s. For
multi-gigabyte episodes, copying the files into `media/` over the LAN and hitting
**Rescan folder** is far faster than uploading.

## 4K and HDR

A 4K file is **never streamed at 4K**. Sources above `MAX_HEIGHT` (default
**1080**) are re-encoded down to that height, so the browser receives 1920×1080
at roughly 3–6 Mbps — decodable in hardware by any phone or laptop from the last
decade. Streams are only remuxed untouched when they are already browser-friendly
*and* within the cap; a 4K H.264 file is re-encoded rather than copied, precisely
so it cannot slip through at 2160p. Set `MAX_HEIGHT=720` if the people watching
are on a weak link (it roughly halves the bitrate).

HDR is handled rather than ignored. HDR10, HLG and Dolby Vision releases are
tone-mapped to BT.709 SDR with `zscale` + `tonemap`; without that step a PQ source
displays with lifted blacks and washed-out colour. The stage line says
"HDR tone-mapped" and shows the *streamed* height, e.g. `1080p (from 2160p)`, so
nobody has to guess what the player is actually being fed.

The cost is encode time: a 2160p HDR episode prepares at about **1× realtime**
(≈20 minutes for a 24-minute episode), because software decoding of 4K plus the
tone map plus x264 is all CPU. One encode runs at a time by design. Everything is
cached, so the wait happens once per episode.

## Audio and subtitle tracks

The player has one small control for both (the **CC** button, or `c`). It only
appears when there is something to switch, so a plain single-audio episode has no
extra buttons.

Choices are **per viewer**, never room-wide: one person can watch the dub with
Spanish subtitles while everyone else keeps the original audio. The choice is
remembered per episode (and reused for the next one).

**Subtitles.** Burned-in subtitles are the default because they keep ASS
typesetting, signs and karaoke exactly as the release intends. Burned text cannot
be switched off, so picking "Off" or another track switches the player to a
*subtitle-free* rendition of the same episode, which the server encodes once, on
demand (progress shows in the menu) and keeps. Switching between soft tracks and
off is then instant. Soft tracks are WebVTT generated from the ASS script with
alignment, position, italics and bold preserved — ffmpeg's own WebVTT muxer drops
all of that, which would put a top-of-screen sign at the bottom of the frame.

**Audio.** Chrome has no API for choosing an audio track inside a `<video>`, so
track 0 stays muxed in the video (sample-accurate) and every other track is
extracted to its own AAC file. Selecting one mutes the video element and plays the
second element, kept in step by the same drift controller that syncs the room.

**External tracks.** Releases often ship the dub or subtitles as separate files.
A file attaches to an episode when it shares the episode's full stem and has a
usable extension:

```
Episode 01.mkv
Episode 01.en.ass          -> subtitles: English
Episode 01.en.forced.ass   -> subtitles: English · Forced
Episode 01.es.srt          -> subtitles: Spanish
Episode 01.eng.m4a         -> audio: English
```

Subtitles: `.ass .ssa .srt .vtt`. Audio: `.m4a .aac .opus .flac .mp3 .ogg .wav
.mka .ac3 .eac3 .dts`. The leftovers after the episode name are read for a
language tag (`en`, `eng`, `English`) and known flags (`forced`, `sdh`, `signs`,
`cc`); anything else becomes part of the label. `Episode 011.en.ass` never
attaches to `Episode 01`. A video with no audio inside it but a dub beside it gets
that dub muxed in automatically. Subtitle and audio sidecars can also be uploaded
from the library panel — they attach to whatever they are named after.

## Performance

Measured on this machine (16 threads, software x264, loopback), with the demo
episode at 720p:

| what | number |
|---|---|
| encode throughput | 14.7× realtime (90 s episode in ~6 s) |
| full prepare incl. poster + subtitle burn-in | 10.3× realtime (~9 s for 90 s) |
| seek latency, time to first byte | median 2.5 ms, p95 3.1 ms |
| library scan, 200 episodes, cold | 1.8 s (was ~11 s serial) |
| library scan, 200 episodes, unchanged | 17–40 ms |
| boot to listening (1 episode) | 0.2 s |
| client↔client drift, three browsers | median 2–14 ms, p95 29–51 ms |
| server RSS | ~75 MB idle |

What made the difference:

- **Two-second keyframes** (`-force_key_frames expr:gte(t,n_forced*2)`, fps
  independent) instead of 96-frame GOPs: seeking lands on a nearby keyframe
  instead of up to four seconds back. Costs about 1.5% file size.
- **`immutable` caching with versioned URLs.** `/media/<id>/video.mp4?v=<source
  version>` lets the browser keep the whole rendition and serve seeks from disk
  with no revalidation round trip. A changed source produces a different URL, so
  stale bytes are impossible.
- **Bounded-parallel probing.** One `ffprobe` per file is the slow part of a
  scan; eight at a time turns a 200-episode library from ~11 s into ~1.8 s.
  Probe results are cached in `cache/<id>/probe.json` keyed by size+mtime, so
  rescans of an unchanged library are tens of milliseconds.
- **Coalesced roster broadcasts.** Latency and buffering updates are the noisiest
  thing on the wire (every clock ping changes one); they are batched into at most
  one roster message per 200 ms.
- **One encode at a time**, deliberately. Two x264 jobs on a laptop is how you
  make the party stutter.

## When things go wrong

The failure modes that matter for a three-hour session are blackouts, not
crashes: a laptop sleeping, Wi-Fi dropping, an encode wedging, a disk filling.

- **A hung encode is killed.** `run()` has a stall watchdog (no output for 120 s)
  and a 6-hour ceiling, so a wedged ffmpeg cannot occupy the single-slot queue
  forever. Children are tracked and killed on shutdown, so a restart never leaves
  an orphan encoder eating CPU.
- **Disk space is checked before a long encode** (needs ~2× the source, minimum
  1.5 GB) so it fails in a second with a clear message instead of dying halfway.
- **Interrupted work is cleaned up on the next scan:** cache directories for
  files that no longer exist, `video.partial.mp4` from a killed encode, and
  `.part` files from aborted uploads.
- **Uploads are atomic.** The bytes land in `<name>.part` and are renamed on
  completion; a dropped connection never leaves a truncated file that looks like
  an episode.
- **A disappeared file is not served as a lie.** If a rendition is missing the
  server answers 409 (not 404), marks it unprepared and re-encodes; the client
  notices, retries with a cache-busting URL and resumes on its own — no reload.
- **The room never plays to an empty house.** Last viewer out freezes the
  timeline; a long-empty room is rewound for the next person.
- **Reconnects are forever.** The client backs off with jitter (max 15 s) and
  resets on a successful open; it never gives up on a long session.
- **A bad request cannot kill the party.** Every socket message is wrapped, each
  connection has a 60 msg/s budget, and `uncaughtException` /
  `unhandledRejection` log, kill encoders and exit non-zero so systemd restarts a
  working process in ~2 s.
- **The unit bounds the blast radius:** `Restart=always`, `RestartSec=2`, restart
  burst limit, `MemoryHigh=2G`/`MemoryMax=4G` so a leak throttles and dies inside
  its own cgroup instead of the kernel OOM killer picking another victim on the
  host, `KillMode=mixed` so ffmpeg children go too.

One thing deliberately *not* done: no `WatchdogSec`/`sd_notify`. systemd's notify
socket is a `SOCK_DGRAM` unix socket and Node's `net` can only open `SOCK_STREAM`
to a path, so `READY=1` never arrives and `Type=notify` fails the start. Doing it
properly needs a native dependency or spawning `systemd-notify` on a timer; the
failure modes above are covered without it.

## Deliberate limits

- **Three seats.** It is a room for friends, not a platform; capacity is enforced on the server.
- **Image-based subtitles (PGS/VOBSUB) cannot be switched.** They are pictures, not text, so there is nothing to render soft or to convert; the baked-in default is all a browser can show.
- **A subtitle-free rendition costs one extra encode.** It is built the first time anyone asks for "off" or a soft track, then cached; until it is ready the burned-in picture keeps playing.
- **One room.** No accounts, no rooms list. The network (Tailscale) is the auth boundary.
- **Subtitles are styled by default.** Burned-in keeps typesetting, and turning them off or switching track means one extra encode of that episode (cached afterwards). Set `SUBTITLES=track` to skip the burned rendition entirely and always serve soft WebVTT.
- **No voice chat.** Use Discord; it is better at that than this will ever be.
- **You are the redistributor.** Keep the room to people who already have the files.
