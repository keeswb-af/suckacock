#!/usr/bin/env bash
# One-time setup for Offline Transcriber (macOS and Linux). Needs internet;
# nothing after this does.
#   ./setup.sh           install, plus the default model (large-v3-turbo, 1.6 GB)
#   ./setup.sh small     install with a smaller, faster model instead
# On a Mac without Python 3.12-3.14, it installs the official Python 3.13
# from python.org (after Apple's signature check), which asks for your password.
set -euo pipefail
cd "$(dirname "$0")"
MODEL="${1:-large-v3-turbo}"
OS="$(uname -s)"
ARCH="$(uname -m)"
MAC_PYTHONS="/Library/Frameworks/Python.framework/Versions"

suitable() {  # is "$1" Python 3.12, 3.13 or 3.14?
  "$1" -c 'import sys; sys.exit(not (3, 12) <= sys.version_info[:2] <= (3, 14))' 2>/dev/null
}

find_python() {
  local candidates cmd
  if [ "$OS" = Darwin ]; then
    # Official python.org installs (they include Tk for the app window). Never
    # /usr/bin/python3: on a Mac without developer tools, running it opens an
    # "install command line developer tools" window.
    candidates="$MAC_PYTHONS/3.13/bin/python3.13 $MAC_PYTHONS/3.12/bin/python3.12 $MAC_PYTHONS/3.14/bin/python3.14"
  else
    candidates="python3.13 python3.12 python3.14 python3"
  fi
  for cmd in $candidates; do
    if command -v "$cmd" >/dev/null 2>&1 && suitable "$cmd"; then
      echo "$cmd"
      return 0
    fi
  done
  return 1
}

check_macos_version() {
  local need=14 have
  [ "$ARCH" = x86_64 ] && need=13  # Intel Macs
  have="$(sw_vers -productVersion)"
  if [ "${have%%.*}" -lt "$need" ]; then
    echo "This Mac has macOS $have, but the speech engine needs macOS $need or newer."
    echo "Update macOS (Apple menu > System Settings > General > Software Update) and try again."
    exit 1
  fi
}

python_versions() {  # Python 3.13 releases on python.org, newest first
  {
    curl -fsSL https://www.python.org/ftp/python/ 2>/dev/null | grep -oE '3\.13\.[0-9]+/' | tr -d / || true
    printf '%s\n' 3.13.12 3.13.11 3.13.10 3.13.9 3.13.8 3.13.7  # in case the list can't be read
  } | sort -t. -k3 -rn | uniq
}

install_python_mac() {
  local tmp pkg version verdict
  echo
  echo "Python 3.13 is needed and isn't installed yet. Downloading it from python.org..."
  tmp="$(mktemp -d)"
  pkg="$tmp/python.pkg"
  for version in $(python_versions); do
    # Newer 3.13 releases may be source-only; take the newest with a Mac installer.
    if curl -fsSL -o "$pkg" "https://www.python.org/ftp/python/$version/python-$version-macos11.pkg"; then
      break
    fi
    rm -f "$pkg"
  done
  if [ ! -s "$pkg" ]; then
    echo "Couldn't download Python. Check the internet connection and run this again."
    exit 1
  fi
  # Install only what Apple confirms is the genuine, notarized python.org package.
  verdict="$(spctl --assess --type install -vv "$pkg" 2>&1 || true)"
  case "$verdict" in
    *accepted*"Python Software Foundation"*) ;;
    *)
      echo "The downloaded Python installer failed Apple's signature check, so it was not installed:"
      echo "$verdict"
      exit 1
      ;;
  esac
  echo
  echo "Installing Python $version (official, signed by the Python Software Foundation)."
  echo ">> Your Mac now asks for your password: the one you use to log in."
  echo ">> Nothing appears while you type it. Press Enter when done."
  if ! sudo installer -pkg "$pkg" -target /; then
    echo "Python could not be installed (this needs an administrator account on the Mac)."
    exit 1
  fi
  rm -rf "$tmp"
}

if [ "$OS" = Darwin ]; then
  check_macos_version
fi
PY="${PYTHON:-$(find_python || true)}"
if [ -z "$PY" ] && [ "$OS" = Darwin ]; then
  install_python_mac
  PY="$(find_python || true)"
fi
if [ -z "$PY" ]; then
  echo "Python 3.12, 3.13 or 3.14 is needed."
  echo "  Linux: install python3.13 (or 3.12) with your package manager, then run ./setup.sh again."
  exit 1
fi
echo "Using $PY ($("$PY" --version 2>&1))"

if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
echo
echo "Installing the app's components (about 300 MB)..."
# Prebuilt packages only: nothing gets compiled or runs install scripts.
.venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -r requirements.txt
echo
.venv/bin/python download_model.py "$MODEL"

echo
if ! .venv/bin/python -c "import sounddevice" 2>/dev/null; then
  echo "Microphone support needs PortAudio:"
  echo "  Debian/Ubuntu: sudo apt install libportaudio2   Fedora: sudo dnf install portaudio"
fi
if ! .venv/bin/python -c "import tkinter" 2>/dev/null; then
  echo "The app window needs Tk (the command line works without it):"
  echo "  Debian/Ubuntu: sudo apt install python3-tk"
fi
.venv/bin/python -I transcriber.py check || true
echo
echo "Setup done. From now on the app works without internet."
