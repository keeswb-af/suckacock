#!/usr/bin/env bash
# One-time setup for Offline Transcriber (macOS and Linux). Needs internet;
# nothing after this does.
#   ./setup.sh           install, plus the default model (large-v3-turbo, 1.6 GB)
#   ./setup.sh small     install with a smaller, faster model instead
set -euo pipefail
cd "$(dirname "$0")"
MODEL="${1:-large-v3-turbo}"

find_python() {
  for cmd in python3.13 python3.12 python3.14 python3; do
    if command -v "$cmd" >/dev/null 2>&1 &&
       "$cmd" -c 'import sys; sys.exit(not (3, 12) <= sys.version_info[:2] <= (3, 14))' 2>/dev/null; then
      echo "$cmd"
      return 0
    fi
  done
  return 1
}

PY="${PYTHON:-$(find_python || true)}"
if [ -z "$PY" ]; then
  echo "Python 3.12, 3.13 or 3.14 is needed."
  echo "  macOS: install Python 3.13 from https://www.python.org/downloads/"
  echo "  Linux: install python3.13 (or 3.12) with your package manager"
  echo "Then run ./setup.sh again."
  exit 1
fi
echo "Using $PY ($("$PY" --version 2>&1))"

if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
# Prebuilt packages only: nothing gets compiled or runs install scripts.
.venv/bin/python -m pip install --only-binary=:all: -r requirements.txt
.venv/bin/python download_model.py "$MODEL"

echo
if ! .venv/bin/python -c "import sounddevice" 2>/dev/null; then
  echo "Microphone support needs PortAudio:"
  echo "  Debian/Ubuntu: sudo apt install libportaudio2   Fedora: sudo dnf install portaudio"
fi
if ! .venv/bin/python -c "import tkinter" 2>/dev/null; then
  echo "The app window needs Tk (the command line works without it):"
  echo "  macOS with Homebrew Python: brew install python-tk   Debian/Ubuntu: sudo apt install python3-tk"
fi
.venv/bin/python -I transcriber.py check || true
echo
echo "Setup done. You can go offline now. Start the app with: ./run.sh"
