#!/usr/bin/env python3
"""Offline Transcriber: record speech and turn it into text, entirely on this computer.

Run without arguments to open the app window, or see --help for the command line.
Network access is blocked before anything else loads (see netguard.py).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netguard  # noqa: E402

netguard.install()  # keep this above every other import

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import signal  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

import engine  # noqa: E402
from engine import SetupError  # noqa: E402


def privacy_report(out_dir: Path | None = None) -> list[tuple[str, str]]:
    """(level, message) lines about privacy; level is "ok" or "warn"."""
    guard = netguard.status()
    layers = "Python and Linux kernel" if guard["kernel_filter"] else "Python"
    lines = [("ok", f"Network access is blocked inside this app ({layers} level).")]
    conns = netguard.network_connections()
    if conns == []:
        lines.append(("ok", "This computer is offline."))
    elif conns is None:
        lines.append(("warn", "Couldn't tell whether this computer is online."))
    else:
        lines.append(("warn", f"This computer is online: {', '.join(conns)}. The app still can't "
                              "use the network; turn off Wi-Fi/Ethernet for a full air gap."))
    warning = out_dir and engine.cloud_sync_warning(out_dir)
    if warning:
        lines.append(("warn", warning))
    return lines


def print_privacy(out_dir: Path | None = None) -> None:
    for level, msg in privacy_report(out_dir):
        print(("  ok  " if level == "ok" else "  !!  ") + msg.replace("\n", "\n      "))
    print()


def enforce_offline(args) -> None:
    if not getattr(args, "require_offline", False):
        return
    conns = netguard.network_connections()
    if conns is None:
        raise SetupError("--require-offline: couldn't tell whether this computer is online.")
    if conns:
        raise SetupError(f"--require-offline: this computer is online: {', '.join(conns)}.\n"
                         "Turn off Wi-Fi / unplug the network and try again.")


def load_model_verbose(args):
    model_dir = engine.resolve_model(args.model)
    print(f"Loading model '{model_dir.name}'...", end=" ", flush=True)
    start = time.monotonic()
    model = engine.load_model(model_dir, compute=args.compute, threads=args.threads)
    print(f"ready ({time.monotonic() - start:.1f} s)")
    return model


def run_transcription(model, audio, language, prompt):
    duration = len(audio) / engine.SAMPLE_RATE
    print(f"Transcribing {engine.fmt_duration(duration)} of audio...\n")
    start = time.monotonic()

    def show(seg, info):
        print(f"[{engine.fmt_clock(seg.start)}] {seg.text.strip()}", flush=True)

    segments, info = engine.transcribe(model, audio, language, prompt, on_segment=show)
    if not segments:
        print("(no speech detected)")
    lang = engine.LANGUAGES.get(info.language, info.language)
    if language is None:
        lang += f", detected with {info.language_probability:.0%} confidence"
    print(f"\nDone in {engine.fmt_duration(time.monotonic() - start)}. Language: {lang}.")
    return segments


def wait_for_stop(seconds: float | None) -> None:
    if seconds:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            time.sleep(0.05)
    elif sys.stdin is not None and sys.stdin.isatty():
        input()
    else:
        print("(Not in a terminal: press Ctrl+C or send SIGTERM to stop.)", flush=True)
        while True:
            time.sleep(0.2)


def show_meter(rec, stop: threading.Event) -> None:
    while not stop.wait(0.1):
        n = round(rec.level * 24)
        sys.stdout.write(f"\r  {engine.fmt_clock(rec.seconds)}  {'█' * n}{'░' * (24 - n)} ")
        sys.stdout.flush()


def cmd_record(args) -> int:
    enforce_offline(args)
    language = engine.parse_language(args.language)
    out_dir = engine.prepare_out_dir(args.out)
    print_privacy(out_dir)
    engine.import_sounddevice()  # fail early if audio support is missing
    # Load the model before recording: loading can briefly stall the audio thread.
    model = load_model_verbose(args)
    engine.check_language(model, language)

    base = engine.unique_base(out_dir, dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
    wav_path = None if args.no_audio else engine.with_ext(base, ".wav")
    rec = engine.Recorder(args.mic, wav_path)
    print(f"\nStarting microphone '{rec.device_name}'...", flush=True)
    rec.start()  # returns once audio is actually arriving
    how = (f"stops after {args.seconds:g} s, Ctrl+C to stop early" if args.seconds
           else "press Enter to stop")
    print(f"● Recording ({how})", flush=True)
    stop = threading.Event()
    meter = threading.Thread(target=show_meter, args=(rec, stop), daemon=True)
    if sys.stdout.isatty():
        meter.start()
    try:
        wait_for_stop(args.seconds)
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        stop.set()
        if meter.is_alive():
            meter.join()
        samples = rec.stop()

    duration = len(samples) / rec.samplerate
    if not wav_path:
        where = "kept in memory only, not saved"
    elif rec.save_error:
        where = f"{wav_path} is incomplete, see below"
    else:
        where = f"saved to {wav_path}"
    print(f"\nRecorded {engine.fmt_duration(duration)} ({where}).")
    for problem in rec.problems():
        print("\n!! " + problem.replace("\n", "\n   "))
    if duration < 0.5:
        print("Too short to transcribe.")
        return 1

    audio = engine.to_model_input(samples, rec.samplerate)
    del samples
    segments = run_transcription(model, audio, language, args.prompt)
    for path in engine.save_transcript(base, segments, args.srt):
        print(f"Saved {path}")
    return 0


def cmd_transcribe(args) -> int:
    enforce_offline(args)
    language = engine.parse_language(args.language)
    files = [Path(f).expanduser() for f in args.files]
    missing = [str(f) for f in files if not f.is_file()]
    if missing:
        raise SetupError("File(s) not found: " + ", ".join(missing))
    out_dir = engine.prepare_out_dir(args.out)
    print_privacy(out_dir)
    model = load_model_verbose(args)
    engine.check_language(model, language)

    failed = 0
    for f in files:
        print(f"\n=== {f}")
        try:
            audio = engine.load_audio_file(f)
        except SetupError as exc:
            print(f"!! {exc}")
            failed += 1
            continue
        segments = run_transcription(model, audio, language, args.prompt)
        for path in engine.save_transcript(engine.unique_base(out_dir, f.stem), segments, args.srt):
            print(f"Saved {path}")
    return 1 if failed else 0


def cmd_devices(args) -> int:
    devices = engine.input_devices()
    if not devices:
        print("No microphones found.")
        return 1
    print("Microphones (* = default):")
    for d in devices:
        print(f" {'*' if d['default'] else ' '} {d['index']:3d}  {d['name']}  ({d['api']}, {d['rate']} Hz)")
    print("\nPick one with: record --mic NUMBER  (or --mic 'part of the name')")
    return 0


def cmd_models(args) -> int:
    models = engine.installed_models()
    if not models:
        print("No models installed. Download one (needs internet): python download_model.py")
        return 1
    print(f"Installed models in {engine.MODELS_DIR} (first = default):")
    for name in models:
        path = engine.MODELS_DIR / name
        size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / 1e6
        try:
            engine.check_model_dir(path)
            note = ""
        except SetupError:
            note = "  (incomplete: download it again)"
        print(f"  {name:20s} {size:7.0f} MB{note}")
    return 0


def ffmpeg_lock_check() -> tuple[bool | None, str]:
    """Show that FFmpeg refuses anything but local files, with no network contact:
    an inline data: URL opens normally, but must be refused under our options."""
    import base64
    import io
    import wave

    import av

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * 160)
    url = "data:audio/wav;base64," + base64.b64encode(buf.getvalue()).decode()
    try:
        av.open(url, mode="r").close()
    except Exception as exc:
        return None, f"test inconclusive: {exc}"
    try:
        av.open(url, mode="r", container_options=engine.FFMPEG_OPTIONS).close()
    except Exception:
        return True, "only local files can be opened"
    return False, "FFmpeg opened a non-file address"


def cmd_check(args) -> int:
    def row(ok, label, detail=""):
        mark = {True: "ok", False: "FAIL", None: "--"}[ok]
        print(f"  {mark:4s}  {label}" + (f": {detail}" if detail else ""))

    failures = 0
    print("Network block inside the app")
    for label, ok, detail in netguard.self_test():
        row(ok, label, detail)
        failures += ok is False
    ok, detail = ffmpeg_lock_check()
    row(ok, "FFmpeg (audio file reader) limited to local files", detail)
    failures += ok is False

    print("\nThis computer")
    for level, msg in privacy_report(engine.prepare_out_dir(args.out))[1:]:
        row(True if level == "ok" else None, msg.replace("\n", "\n        "))

    print("\nSpeech models")
    models = engine.installed_models()
    if not models:
        row(False, "no model installed", "run: python download_model.py")
        failures += 1
    for name in models:
        try:
            engine.check_model_dir(engine.MODELS_DIR / name)
            row(True, name, "complete, loads from disk only")
        except SetupError as exc:
            row(False, name, str(exc).splitlines()[0])
            failures += 1

    print("\nMicrophone")
    try:
        default = [d for d in engine.input_devices() if d["default"]]
        row(True if default else None, default[0]["name"] if default else "no default microphone")
    except SetupError as exc:
        row(None, str(exc).splitlines()[0])

    print("\n" + ("All checks passed." if not failures else f"{failures} check(s) FAILED."))
    return 1 if failures else 0


def cmd_gui(args) -> int:
    enforce_offline(args)
    try:
        import gui
    except ImportError as exc:
        raise SetupError(
            f"The app window needs Tk ({exc}).\n"
            "  macOS (Homebrew Python): brew install python-tk\n"
            "  Debian/Ubuntu:           sudo apt install python3-tk\n"
            "Or use the command line: run.sh record (Windows: run.bat record)"
        ) from exc
    return gui.run(args, privacy_report)


def build_parser() -> argparse.ArgumentParser:
    out = argparse.ArgumentParser(add_help=False)
    out.add_argument("-o", "--out", default=str(engine.DEFAULT_OUT_DIR),
                     help="folder for recordings and transcripts (default: %(default)s)")

    common = argparse.ArgumentParser(add_help=False, parents=[out])
    common.add_argument("-m", "--model", help="installed model name or a model folder (default: best installed)")
    common.add_argument("-l", "--language", default="auto",
                        help="spoken language: auto (default), or a code or name such as en, nl, dutch")
    common.add_argument("--srt", action="store_true", help="also save subtitles with timestamps (.srt)")
    common.add_argument("--prompt", help="spellings to help recognition, e.g. names: \"Kees, Rijksmuseum\"")
    common.add_argument("--compute", choices=("cpu", "cuda"), default="cpu",
                        help="cuda = NVIDIA GPU (needs CUDA 12 and cuDNN 9 installed)")
    common.add_argument("--threads", type=int, default=0, help="CPU threads (default: automatic)")
    common.add_argument("--require-offline", action="store_true",
                        help="refuse to run while this computer has a network connection")

    parser = argparse.ArgumentParser(
        prog="transcriber", description="Record and transcribe speech, 100% offline.",
        epilog="With no command, the app window opens.")
    sub = parser.add_subparsers(dest="command", metavar="command")

    p = sub.add_parser("gui", parents=[common], help="open the app window (default)")
    p.set_defaults(func=cmd_gui)

    p = sub.add_parser("record", parents=[common], help="record from the microphone, then transcribe")
    p.add_argument("--mic", help="microphone number or part of its name (see 'devices')")
    p.add_argument("--seconds", type=float, help="stop automatically after this many seconds")
    p.add_argument("--no-audio", action="store_true",
                   help="don't save the recording; audio stays in memory only")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("transcribe", parents=[common], help="transcribe audio or video files")
    p.add_argument("files", nargs="+", metavar="FILE")
    p.set_defaults(func=cmd_transcribe)

    sub.add_parser("devices", help="list microphones").set_defaults(func=cmd_devices)
    sub.add_parser("models", help="list installed models").set_defaults(func=cmd_models)
    sub.add_parser("check", parents=[out], help="test the privacy protections").set_defaults(func=cmd_check)
    return parser


def _stop_on_sigterm(signum, frame):
    raise KeyboardInterrupt


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")  # never crash on a console that lacks a symbol
    os.umask(0o077)  # new files are readable by you only
    signal.signal(signal.SIGTERM, _stop_on_sigterm)

    argv = sys.argv[1:] if argv is None else argv
    args = build_parser().parse_args(argv or ["gui"])
    try:
        return args.func(args)
    except SetupError as exc:
        print(f"\n{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
