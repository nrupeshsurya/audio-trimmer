#!/usr/bin/env bash
# Downloads a static FFmpeg build and places it where Tauri expects the sidecar:
#   src-tauri/binaries/ffmpeg-<target-triple>[.exe]
# Usage: scripts/fetch-ffmpeg.sh [target-triple]   (defaults to the host triple)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
OUT_DIR="$ROOT/src-tauri/binaries"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT_DIR"

case "$TRIPLE" in
  aarch64-apple-darwin)
    URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip" ;;
  x86_64-apple-darwin)
    URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip" ;;
  x86_64-pc-windows-msvc)
    URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" ;;
  *)
    echo "Unsupported target: $TRIPLE" >&2; exit 1 ;;
esac

EXT=""
[[ "$TRIPLE" == *windows* ]] && EXT=".exe"
DEST="$OUT_DIR/ffmpeg-$TRIPLE$EXT"

if [[ -f "$DEST" ]]; then
  echo "Already present: $DEST"; exit 0
fi

echo "Downloading FFmpeg for $TRIPLE..."
curl -fL --retry 3 -o "$TMP/ffmpeg.zip" "$URL"
unzip -q "$TMP/ffmpeg.zip" -d "$TMP/x"
BIN="$(find "$TMP/x" -type f -name "ffmpeg$EXT" | head -n1)"
[[ -n "$BIN" ]] || { echo "ffmpeg binary not found in archive" >&2; exit 1; }
cp "$BIN" "$DEST"
chmod +x "$DEST"
echo "Installed $DEST"
