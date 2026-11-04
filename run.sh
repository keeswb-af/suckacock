#!/usr/bin/env bash
# Start Offline Transcriber (macOS and Linux). Works without internet.
#   ./run.sh                   app window
#   ./run.sh record            record in the terminal
#   ./run.sh transcribe FILE   transcribe a file
#   ./run.sh check             test the privacy protections
#   ./run.sh --help            everything else
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  echo "Run ./setup.sh first (one time, needs internet)."
  exit 1
fi
# -I: ignore PYTHON* environment variables and user packages.
exec "$DIR/.venv/bin/python" -I "$DIR/transcriber.py" "$@"
