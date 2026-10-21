#!/usr/bin/env bash
# Builds a deliberately awkward test file: 10-bit HEVC, FLAC audio, ASS subs,
# and an embedded font attachment. If the pipeline handles this, it handles
# what a fansub release throws at it.
set -euo pipefail

OUT="${1:-media/Demo Episode - 01 [720p].mkv}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/demo.ass" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,44,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,56,1
Style: Sign,DejaVu Sans,64,&H00FFD479,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,2,0,1,4,0,8,40,40,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,{\fad(300,300)}This is a synchronized playback test.
Dialogue: 0,0:00:05.00,0:00:09.00,Default,,0,0,0,,If your friends see this line at the same second, the room is working.
Dialogue: 0,0:00:09.00,0:00:13.00,Sign,,0,0,0,,{\pos(640,120)\fad(400,400)}Episode 01 — The Drift Test
Dialogue: 0,0:00:13.00,0:00:18.00,Default,,0,0,0,,Pause, seek, and skip should follow instantly for everyone.
Dialogue: 0,0:00:18.00,0:00:23.00,Default,,0,0,0,,{\i1}Typesetting italic check{\i0} and a curly quote: “like this”.
Dialogue: 0,0:00:23.00,0:00:30.00,Default,,0,0,0,,Slower players get nudged by a few percent instead of seeking.
Dialogue: 0,0:00:30.00,0:00:36.00,Sign,,0,0,0,,{\pos(640,640)\fad(300,300)\b1}SIGN TEXT / 字幕テスト
Dialogue: 0,0:00:36.00,0:00:45.00,Default,,0,0,0,,Late joiners jump straight to the room position.
Dialogue: 0,0:00:45.00,0:00:55.00,Default,,0,0,0,,The badge in the corner shows live drift in milliseconds.
Dialogue: 0,0:00:55.00,0:01:10.00,Default,,0,0,0,,Everything here ran through ffmpeg once and is now plain H.264.
Dialogue: 0,0:01:10.00,0:01:30.00,Sign,,0,0,0,,{\pos(640,360)\fad(300,300)\fs72}END OF TEST
ASS

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
[ -f "$FONT" ] || FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=24:duration=90" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=90" \
  -i "$TMP/demo.ass" \
  -attach "$FONT" -metadata:s:t:0 mimetype=application/x-truetype-font \
  -map 0:v:0 -map 1:a:0 -map 2:s:0 \
  -c:v libx265 -pix_fmt yuv420p10le -preset ultrafast -x265-params log-level=error \
  -c:a flac -compression_level 0 \
  -c:s ass -metadata:s:s:0 language=jpn -metadata:s:s:0 title="Full subtitles" \
  -metadata title="Demo Episode 01" \
  "$OUT"

echo "wrote $OUT"
ffprobe -v error -show_entries stream=index,codec_name,codec_type,pix_fmt -of compact "$OUT"
