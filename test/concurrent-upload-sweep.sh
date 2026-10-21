#!/usr/bin/env bash
# Reproduces the "skipped episode" bug and proves the fix.
#
# An upload writes media/<name>.part and renames it when the bytes are in. The
# library scan sweeps stale .part files as crash debris - and it used to sweep
# live ones too, so a scan running while another upload was in flight deleted
# that upload's file. The rename then failed with ENOENT and the episode never
# appeared, with nothing left behind to look at.
#
# This boots the real server on a scratch port, uploads two files slowly while
# hammering /api/rescan, and checks both land.
set -u
cd "$(dirname "$0")/.."
export PATH=/home/hermes/.local/node22/bin:$PATH

PORT=${PORT:-8097}
TMP=$(mktemp -d)
mkdir -p "$TMP/media" "$TMP/cache"
head -c 6000000 /dev/urandom > "$TMP/one.mkv"
head -c 6000000 /dev/urandom > "$TMP/two.mkv"

PORT=$PORT BIND=127.0.0.1 MEDIA_DIR="$TMP/media" CACHE_DIR="$TMP/cache" \
  node server/index.js > "$TMP/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT

for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.3
done
echo "server up on $PORT"

# Rescan continuously for the whole transfer: this is what used to eat the files.
( for _ in $(seq 1 120); do curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/api/rescan"; sleep 0.3; done ) &
RESCANNER=$!

CODE1=0
CODE2=0
curl -s -o /dev/null -w '%{http_code}' --limit-rate 400k \
  -F "file=@$TMP/one.mkv" "http://127.0.0.1:$PORT/api/upload" > "$TMP/c1" &
C1=$!
curl -s -o /dev/null -w '%{http_code}' --limit-rate 400k \
  -F "file=@$TMP/two.mkv" "http://127.0.0.1:$PORT/api/upload" > "$TMP/c2" &
C2=$!
wait $C1 $C2
kill $RESCANNER 2>/dev/null
CODE1=$(cat "$TMP/c1")
CODE2=$(cat "$TMP/c2")

echo "upload 1: HTTP $CODE1"
echo "upload 2: HTTP $CODE2"
echo "files on disk:"
ls -la "$TMP/media" | awk 'NR>3 {print "  ", $5, $9}'
echo "server said:"
grep -E "upload (received|rejected)" "$TMP/server.log" | sed 's/^/  /' || echo "  (nothing)"

if [ "$CODE1" = "200" ] && [ "$CODE2" = "200" ] \
   && [ -f "$TMP/media/one.mkv" ] && [ -f "$TMP/media/two.mkv" ]; then
  echo "RESULT: both uploads survived concurrent rescans"
  exit 0
fi
echo "RESULT: an upload was lost"
exit 1
