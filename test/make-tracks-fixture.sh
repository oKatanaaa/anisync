#!/usr/bin/env bash
# Builds an episode that exercises track switching:
#   - one muxed audio track (Japanese) plus an English dub as a sidecar .m4a
#   - one muxed ASS track (English) plus a Spanish .srt sidecar
# Everything is 8 seconds long, so preparing it is quick.
set -euo pipefail

DIR="${1:-media}"
NAME="Tracks Episode - 01 [720p]"
OUT="$DIR/$NAME.mkv"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/en.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,22,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,24,1
Style: Sign,DejaVu Sans,30,&H00FFD479,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,8,20,20,12,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:03.50,Default,,0,0,0,,Embedded English line one.
Dialogue: 0,0:00:03.50,0:00:06.00,Sign,,0,0,0,,{\pos(320,60)}TOP SIGN
Dialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,{\i1}Embedded English line two.{\i0}
ASS

cat > "$TMP/es.srt" <<'SRT'
1
00:00:00,500 --> 00:00:03,500
Línea uno en español.

2
00:00:03,500 --> 00:00:06,000
Línea dos en español.

3
00:00:06,000 --> 00:00:08,000
Línea tres en español.
SRT

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=640x360:rate=24,format=yuv420p" \
  -f lavfi -i "sine=frequency=440:duration=8" \
  -i "$TMP/en.ass" \
  -map 0:v -map 1:a -map 2:s \
  -c:v libx264 -preset veryfast -crf 24 -c:a aac -b:a 128k -c:s ass \
  -metadata:s:a:0 language=jpn -metadata:s:a:0 title="Japanese" \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  -t 8 "$OUT"

# The English dub: a separate file next to the episode.
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=880:duration=8" \
  -ac 2 -c:a aac -b:a 128k "$DIR/$NAME.eng.m4a"

# The Spanish subtitles: a separate file next to the episode.
cp "$TMP/es.srt" "$DIR/$NAME.es.srt"

echo "built:"
ls -1 "$DIR" | grep "Tracks Episode" || true
