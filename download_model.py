#!/usr/bin/env python3
"""Download a speech model into ./models.

This is the only part of Offline Transcriber that uses the internet. Run it
once (setup does this for you); the app itself never downloads anything.

    python download_model.py                 the default model (large-v3-turbo)
    python download_model.py small           another model
    python download_model.py --list          what's available

To set up a computer that is never online, run this on another computer and
copy the models folder over.
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

MODELS_DIR = Path(__file__).resolve().parent / "models"
DEFAULT = "large-v3-turbo"

# name: (download size, what it's good for)
MODELS = {
    "large-v3-turbo": ("1.6 GB", "best balance of accuracy and speed, 99 languages (default)"),
    "large-v3": ("3.1 GB", "slightly more accurate than turbo, several times slower"),
    "medium": ("1.5 GB", "multilingual, slower than turbo and usually less accurate"),
    "small": ("0.5 GB", "fast, fine for clear English, weaker for other languages"),
    "base": ("0.15 GB", "very fast, rough"),
    "tiny": ("0.08 GB", "fastest, roughest; for testing"),
    "distil-large-v3.5": ("1.5 GB", "English only, fast and accurate"),
    "small.en": ("0.5 GB", "English only"),
    "medium.en": ("1.5 GB", "English only"),
}
FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]


def repo_for(name: str) -> str:
    if "/" in name:  # any CTranslate2 Whisper model on Hugging Face, e.g. org/model
        return name
    from faster_whisper.utils import _MODELS
    if name not in _MODELS:
        sys.exit(f"Unknown model '{name}'. See: python download_model.py --list")
    return _MODELS[name]


def main() -> int:
    parser = argparse.ArgumentParser(description="Download a speech model (needs internet, once).")
    parser.add_argument("model", nargs="?", default=DEFAULT, help=f"model name (default: {DEFAULT})")
    parser.add_argument("--list", action="store_true", help="show the available models")
    args = parser.parse_args()

    if args.list:
        for name, (size, note) in MODELS.items():
            print(f"  {name:18s} {size:>8s}  {note}")
        print("\nAny CTranslate2 Whisper model on Hugging Face also works: org/model-name")
        return 0

    repo = repo_for(args.model)
    target = MODELS_DIR / args.model.replace("/", "--")
    MODELS_DIR.mkdir(exist_ok=True)
    free_gb = shutil.disk_usage(MODELS_DIR).free / 1e9
    size = MODELS.get(args.model, ("unknown size", ""))[0]
    print(f"Downloading '{args.model}' ({size}) from huggingface.co/{repo}")
    print(f"into {target}  ({free_gb:.1f} GB free)\n")

    from huggingface_hub import snapshot_download
    try:
        snapshot_download(repo, local_dir=str(target), allow_patterns=FILES)
    except KeyboardInterrupt:
        sys.exit("\nStopped. Run this again to resume the download.")
    except Exception as exc:
        sys.exit(f"\nDownload failed: {type(exc).__name__}: {exc}\n"
                 "Check the internet connection and run this again; it resumes where it stopped.")

    if not (target / "tokenizer.json").is_file():
        # The app refuses such models: the speech library would fetch the
        # missing tokenizer from the internet at runtime.
        shutil.rmtree(target, ignore_errors=True)
        sys.exit(f"'{repo}' has no tokenizer.json, so it can't be used offline. Pick another model.")
    missing = [f for f in ("model.bin", "config.json") if not (target / f).is_file()]
    if missing:
        sys.exit(f"Download incomplete (missing {', '.join(missing)}). Run this again to resume.")

    total = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1e9
    print(f"\nDone: {target} ({total:.2f} GB).")
    print("From now on the app works without internet. Start it with ./run.sh (Windows: run.bat).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
