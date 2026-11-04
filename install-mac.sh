#!/bin/bash
# Installs (or updates) Offline Transcriber on a Mac. Open Terminal and paste:
#
#   curl -fsSL https://raw.githubusercontent.com/keeswb-af/suckacock/refs/heads/claude/compassionate-feynman-f9o7ga/install-mac.sh | bash
#
# The app goes to ~/Applications/OfflineTranscriber, your recordings to
# ~/OfflineTranscriber, and an "Offline Transcriber" icon onto the Desktop.
set -euo pipefail

APP_DIR="$HOME/Applications/OfflineTranscriber"
SOURCE="https://github.com/keeswb-af/suckacock/archive/refs/heads/claude/compassionate-feynman-f9o7ga.tar.gz"
LAUNCHER="$HOME/Desktop/Offline Transcriber.command"

make_launcher() {
  # A file you double-click; it opens a Terminal window that starts the app.
  if { printf '#!/bin/bash\nexec "%s/run.sh"\n' "$APP_DIR" > "$LAUNCHER"; } 2>/dev/null &&
     chmod +x "$LAUNCHER"; then
    return 0
  fi
  return 1
}

main() {
  if [ "$(uname -s)" != Darwin ]; then
    echo "This installer is for Macs. On Linux, download the app and run setup.sh."
    exit 1
  fi
  echo "=================================================================="
  echo " Offline Transcriber: one-time setup"
  echo " Downloads about 2 GB. Takes roughly 5 to 20 minutes."
  echo "=================================================================="
  echo
  echo "Downloading the app into $APP_DIR ..."
  mkdir -p "$APP_DIR"
  curl -fsSL "$SOURCE" | tar -xz --strip-components=1 -C "$APP_DIR"

  "$APP_DIR/setup.sh"

  echo
  echo "=================================================================="
  if make_launcher; then
    echo " ALL DONE. To use Offline Transcriber:"
    echo "   1. Double-click \"Offline Transcriber\" on your Desktop."
  else
    echo " ALL DONE. To use Offline Transcriber:"
    echo "   1. Open Terminal and paste:  \"$APP_DIR/run.sh\""
  fi
  echo "   2. Press Record. The first time, click Allow when your Mac asks"
  echo "      about the microphone, then record again."
  echo " You can turn off Wi-Fi first: it works without internet."
  echo " Your recordings and text: the OfflineTranscriber folder in your"
  echo " home folder (or press \"Open folder\" in the app)."
  echo "=================================================================="
}

main "$@"
