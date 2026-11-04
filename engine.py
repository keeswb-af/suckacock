"""Core of Offline Transcriber: models, audio input, recording and transcription.

Nothing in here uses the network. Run it through transcriber.py, which installs
the network block first; load_model() and Recorder.start() refuse to run in a
process where the block is not active.
"""

from __future__ import annotations

import math
import os
import queue
import sys
import threading
import wave
from pathlib import Path
from typing import TYPE_CHECKING

import netguard

if TYPE_CHECKING:  # numpy is imported lazily, so starting the app stays fast
    import numpy as np

SAMPLE_RATE = 16000  # what Whisper models expect
APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = APP_DIR / "models"
DEFAULT_OUT_DIR = Path.home() / "OfflineTranscriber"

# Best first. Picks the default when several models are installed.
MODEL_PREFERENCE = (
    "large-v3-turbo", "turbo", "large-v3", "large", "distil-large-v3.5",
    "distil-large-v3", "large-v2", "medium", "medium.en", "small", "small.en",
    "base", "base.en", "tiny", "tiny.en",
)

# FFmpeg (used to read audio files) is native code the Python guard can't see,
# so it may only open local files: no http, tcp, udp, rtp..., even when a
# playlist or stream description inside a file asks for it.
FFMPEG_OPTIONS = {"protocol_whitelist": "file"}

LANGUAGES = {
    "en": "English", "zh": "Chinese", "de": "German", "es": "Spanish",
    "ru": "Russian", "ko": "Korean", "fr": "French", "ja": "Japanese",
    "pt": "Portuguese", "tr": "Turkish", "pl": "Polish", "ca": "Catalan",
    "nl": "Dutch", "ar": "Arabic", "sv": "Swedish", "it": "Italian",
    "id": "Indonesian", "hi": "Hindi", "fi": "Finnish", "vi": "Vietnamese",
    "he": "Hebrew", "uk": "Ukrainian", "el": "Greek", "ms": "Malay",
    "cs": "Czech", "ro": "Romanian", "da": "Danish", "hu": "Hungarian",
    "ta": "Tamil", "no": "Norwegian", "th": "Thai", "ur": "Urdu",
    "hr": "Croatian", "bg": "Bulgarian", "lt": "Lithuanian", "la": "Latin",
    "mi": "Maori", "ml": "Malayalam", "cy": "Welsh", "sk": "Slovak",
    "te": "Telugu", "fa": "Persian", "lv": "Latvian", "bn": "Bengali",
    "sr": "Serbian", "az": "Azerbaijani", "sl": "Slovenian", "kn": "Kannada",
    "et": "Estonian", "mk": "Macedonian", "br": "Breton", "eu": "Basque",
    "is": "Icelandic", "hy": "Armenian", "ne": "Nepali", "mn": "Mongolian",
    "bs": "Bosnian", "kk": "Kazakh", "sq": "Albanian", "sw": "Swahili",
    "gl": "Galician", "mr": "Marathi", "pa": "Punjabi", "si": "Sinhala",
    "km": "Khmer", "sn": "Shona", "yo": "Yoruba", "so": "Somali",
    "af": "Afrikaans", "oc": "Occitan", "ka": "Georgian", "be": "Belarusian",
    "tg": "Tajik", "sd": "Sindhi", "gu": "Gujarati", "am": "Amharic",
    "yi": "Yiddish", "lo": "Lao", "uz": "Uzbek", "fo": "Faroese",
    "ht": "Haitian Creole", "ps": "Pashto", "tk": "Turkmen", "nn": "Nynorsk",
    "mt": "Maltese", "sa": "Sanskrit", "lb": "Luxembourgish", "my": "Myanmar",
    "bo": "Tibetan", "tl": "Tagalog", "mg": "Malagasy", "as": "Assamese",
    "tt": "Tatar", "haw": "Hawaiian", "ln": "Lingala", "ha": "Hausa",
    "ba": "Bashkir", "jw": "Javanese", "su": "Sundanese", "yue": "Cantonese",
}

MIC_HELP = (
    "Check that the right microphone is selected (see the 'devices' command) and\n"
    "that this app may use it:\n"
    "  macOS:   System Settings > Privacy & Security > Microphone > allow your\n"
    "           terminal app (Terminal, iTerm...), then restart it.\n"
    "  Windows: Settings > Privacy & security > Microphone > turn on\n"
    "           'Let desktop apps access your microphone'."
)


class SetupError(Exception):
    """A problem the user can fix. Shown without a traceback."""


def _require_guard() -> None:
    if not netguard.status()["python_hook"]:
        raise RuntimeError("netguard.install() must run before using the engine")


# --- models ------------------------------------------------------------------

def installed_models() -> list[str]:
    if not MODELS_DIR.is_dir():
        return []
    names = [p.name for p in MODELS_DIR.iterdir() if (p / "model.bin").is_file()]
    rank = {name: i for i, name in enumerate(MODEL_PREFERENCE)}
    return sorted(names, key=lambda n: (rank.get(n, len(rank)), n))


def resolve_model(name: str | None) -> Path:
    """Folder of the requested model, or of the best installed one."""
    if name:
        path = Path(name).expanduser()
        if not path.is_dir():
            path = MODELS_DIR / name
        if not path.is_dir():
            raise SetupError(
                f"Model '{name}' isn't installed. Download it once (needs internet):\n"
                f"  python download_model.py {name}"
            )
    else:
        models = installed_models()
        if not models:
            raise SetupError(
                "No speech model installed yet. Run the one-time setup (needs internet),\n"
                "or: python download_model.py"
            )
        path = MODELS_DIR / models[0]
    check_model_dir(path)
    return path


def check_model_dir(path: Path) -> None:
    if not (path / "tokenizer.json").is_file():
        # Without it, faster-whisper silently downloads a tokenizer from the internet.
        raise SetupError(
            f"The model in {path} has no tokenizer.json. Without it the speech library\n"
            "would try to fetch one from the internet, so it won't be loaded.\n"
            "Download the model again with download_model.py."
        )
    missing = [f for f in ("model.bin", "config.json") if not (path / f).is_file()]
    if not any((path / f).is_file() for f in ("vocabulary.txt", "vocabulary.json")):
        missing.append("vocabulary.txt")
    if missing:
        raise SetupError(f"The model in {path} is incomplete (missing {', '.join(missing)}). "
                         "Download it again with download_model.py.")


def default_threads() -> int:
    try:
        import psutil
        cores = psutil.cpu_count(logical=False)
    except Exception:
        cores = None
    return max(1, min(8, cores or os.cpu_count() or 4))


def load_model(model_dir: Path, compute: str = "cpu", compute_type: str | None = None, threads: int = 0):
    _require_guard()
    check_model_dir(model_dir)
    from faster_whisper import WhisperModel

    compute_type = compute_type or ("int8" if compute == "cpu" else "float16")
    try:
        return WhisperModel(str(model_dir), device=compute, compute_type=compute_type,
                            cpu_threads=threads or default_threads(), local_files_only=True)
    except Exception as exc:  # e.g. CUDA requested but its libraries are missing
        raise SetupError(f"Could not load the model in {model_dir}: {exc}") from exc


def parse_language(value: str | None) -> str | None:
    """Language code from a code or English name; None means auto-detect."""
    v = (value or "").strip().lower()
    if v in ("", "auto", "detect", "auto-detect"):
        return None
    if v in LANGUAGES:
        return v
    for code, name in LANGUAGES.items():
        if v == name.lower():
            return code
    raise SetupError(f"Unknown language '{value}'. Use a code such as en, nl, de, fr, or 'auto'.")


def check_language(model, language: str | None) -> None:
    if language and language not in model.supported_languages:
        raise SetupError(f"This model only understands: {', '.join(model.supported_languages)}.")


# --- audio input -------------------------------------------------------------

def load_audio_file(path) -> "np.ndarray":
    """Decode an audio or video file to 16 kHz mono float32, reading local files only."""
    import av
    import numpy as np

    path = os.path.abspath(os.path.expanduser(str(path)))
    if not os.path.isfile(path):
        raise SetupError(f"File not found: {path}")
    try:
        container = av.open(path, mode="r", container_options=FFMPEG_OPTIONS)
    except (av.error.FFmpegError, OSError, ValueError) as exc:
        raise SetupError(f"Can't read {path} as audio: {exc}") from exc

    chunks = []
    with container:
        if not container.streams.audio:
            raise SetupError(f"{path} has no audio track.")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        frames = container.decode(container.streams.audio[0])
        while True:
            try:
                frame = next(frames)
            except StopIteration:
                break
            except av.error.InvalidDataError:
                continue  # skip a damaged frame, like most players do
            frame.pts = None
            chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
        chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def to_model_input(samples, rate: int):
    """int16 mono samples at any rate -> 16 kHz float32, as the model expects."""
    import numpy as np

    if rate == SAMPLE_RATE or len(samples) == 0:
        return samples.astype(np.float32) / 32768.0
    import av

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    out = []
    step = rate * 10
    for i in range(0, len(samples), step):
        block = np.ascontiguousarray(samples[i:i + step], dtype=np.int16).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(block, format="s16", layout="mono")
        frame.sample_rate = rate
        out.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
    out.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
    return np.concatenate(out).astype(np.float32) / 32768.0


def import_sounddevice():
    try:
        import sounddevice
    except OSError as exc:
        raise SetupError(
            "Can't use the microphone: the PortAudio library is missing.\n"
            "  Debian/Ubuntu: sudo apt install libportaudio2\n"
            "  Fedora:        sudo dnf install portaudio\n"
            "  Arch:          sudo pacman -S portaudio"
        ) from exc
    return sounddevice


def input_devices() -> list[dict]:
    """Microphones: [{'index', 'name', 'api', 'rate', 'default'}]."""
    sd = import_sounddevice()
    try:
        default_in = sd.default.device[0]
        devices = sd.query_devices()
        apis = sd.query_hostapis()
    except Exception as exc:
        raise SetupError(f"Can't list audio devices: {exc}") from exc
    if default_in is None or default_in < 0:
        try:
            default_in = sd.query_devices(kind="input")["index"]
        except Exception:
            default_in = -1
    return [
        {"index": i, "name": d["name"], "api": apis[d["hostapi"]]["name"],
         "rate": int(d["default_samplerate"]), "default": i == default_in}
        for i, d in enumerate(devices) if d["max_input_channels"] > 0
    ]


def _parse_device(device):
    if device is None or device == "":
        return None
    if isinstance(device, int):
        return device
    return int(device) if str(device).strip().isdigit() else str(device)


class Recorder:
    """Records a microphone into memory and, optionally, into a WAV file as it
    goes, so a crash or power cut loses at most a fraction of a second."""

    def __init__(self, device=None, wav_path=None):
        self._sd = import_sounddevice()
        self.device = _parse_device(device)
        try:
            info = self._sd.query_devices(self.device, "input")
        except Exception as exc:
            what = f"'{device}'" if device is not None else "(default)"
            raise SetupError(f"No microphone {what} found: {exc}\n{MIC_HELP}") from exc
        self.device_name = info["name"]
        self.samplerate, self.channels = self._pick_format(info)
        self.wav_path = Path(wav_path) if wav_path else None
        self.level = 0.0    # loudness of the latest block, 0..1, for meters
        self.peak = 0       # largest sample seen
        self.frames = 0
        self.dropped = 0    # times the audio driver reported lost input
        self.save_error = None  # set if writing the WAV file failed (e.g. disk full)
        self.flowing = threading.Event()  # set once the microphone delivers audio
        self._chunks = []
        self._queue = queue.Queue()
        self._stream = None
        self._wav = None
        self._writer = None

    @property
    def seconds(self) -> float:
        return self.frames / self.samplerate

    def _pick_format(self, info) -> tuple[int, int]:
        rates = []
        for rate in (SAMPLE_RATE, int(info["default_samplerate"]), 48000, 44100):
            if rate and rate not in rates:
                rates.append(rate)
        for channels in ([1, 2] if info["max_input_channels"] >= 2 else [1]):
            for rate in rates:
                try:
                    self._sd.check_input_settings(device=self.device, channels=channels,
                                                  dtype="int16", samplerate=rate)
                    return rate, channels
                except Exception:
                    continue
        raise SetupError(f"The microphone '{info['name']}' doesn't accept a standard recording format.")

    def start(self, wait: bool = True, timeout: float = 5.0) -> None:
        """Open the microphone. With wait=True, return only once audio is
        actually arriving (devices can take a moment to wake up), so nothing
        said after "recording" appears gets lost."""
        _require_guard()
        if self.wav_path:
            try:
                self._wav = wave.open(str(self.wav_path), "wb")
                self._wav.setnchannels(1)
                self._wav.setsampwidth(2)
                self._wav.setframerate(self.samplerate)
            except OSError as exc:
                raise SetupError(f"Can't create the recording file {self.wav_path}: {exc}") from exc
        self._writer = threading.Thread(target=self._drain, name="recorder", daemon=True)
        self._writer.start()
        try:
            # A 0.25 s buffer rides out brief CPU spikes without losing audio.
            self._stream = self._sd.InputStream(
                device=self.device, samplerate=self.samplerate, channels=self.channels,
                dtype="int16", latency=0.25, callback=self._callback)
            self._stream.start()
        except Exception as exc:
            self._stream = None
            self._finish()
            self._remove_empty_wav()
            raise SetupError(f"Could not open the microphone '{self.device_name}': {exc}\n{MIC_HELP}") from exc
        if wait and not self.flowing.wait(timeout):
            self.stop()
            self._remove_empty_wav()
            raise SetupError(f"The microphone '{self.device_name}' sent no audio.\n{MIC_HELP}")

    def _remove_empty_wav(self) -> None:
        if self.wav_path and self.frames == 0:
            self.wav_path.unlink(missing_ok=True)

    def _callback(self, indata, frames, time_info, status) -> None:
        if status.input_overflow:
            self.dropped += 1
        self._queue.put(indata.copy())
        if not self.flowing.is_set():
            self.flowing.set()

    def _drain(self) -> None:
        import numpy as np

        while (block := self._queue.get()) is not None:
            mono = block[:, 0] if self.channels == 1 else block.mean(axis=1).astype(np.int16)
            if not len(mono):
                continue
            self._chunks.append(mono)
            if self._wav:
                try:
                    self._wav.writeframes(mono.tobytes())
                except OSError as exc:  # e.g. disk full: keep recording into memory
                    self.save_error = exc
                    self._close_wav()
            magnitude = np.abs(mono.astype(np.int32))
            self.peak = max(self.peak, int(magnitude.max()))
            rms = math.sqrt(float(np.mean(magnitude.astype(np.float64) ** 2)))
            self.level = min(1.0, max(0.0, (20 * math.log10(max(rms, 1.0) / 32768) + 60) / 60))
            self.frames += len(mono)

    def _close_wav(self) -> None:
        wav, self._wav = self._wav, None
        if wav:
            try:
                wav.close()
            except OSError as exc:
                self.save_error = self.save_error or exc

    def _finish(self) -> None:
        self._queue.put(None)
        if self._writer:
            self._writer.join()
        self._close_wav()
        self.level = 0.0

    def stop(self):
        """Stop recording and return all samples (int16 mono at self.samplerate)."""
        import numpy as np

        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None
        self._finish()
        return np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype=np.int16)

    def problems(self) -> list[str]:
        """Warnings about the finished recording, if any."""
        issues = []
        if self.frames and self.peak < 32:  # quieter than about -60 dBFS: nothing came in
            issues.append("The recording is silent.\n" + MIC_HELP)
        if self.dropped:
            issues.append(f"The audio driver reported {self.dropped} dropout(s); "
                          "some audio may be missing.")
        if self.save_error:
            issues.append(f"Saving the audio file failed ({self.save_error}). The recording was "
                          "kept in memory and is still transcribed, but the .wav file is incomplete.")
        return issues


# --- transcription and output ------------------------------------------------

def transcribe(model, audio, language=None, prompt=None, on_segment=None, should_stop=None):
    """Transcribe 16 kHz float32 audio. Returns (segments, info).

    on_segment(segment, info) is called as text arrives. should_stop() is
    called before each next piece of work; it may block to pause, and
    returning True ends the transcription early.
    """
    segments, info = model.transcribe(
        audio, language=language, initial_prompt=prompt or None,
        beam_size=5, vad_filter=True)
    result = []
    pending = iter(segments)  # each next() does the work for the next segment
    while not (should_stop and should_stop()):
        seg = next(pending, None)
        if seg is None:
            break
        result.append(seg)
        if on_segment:
            on_segment(seg, info)
    return result, info


def transcript_text(segments) -> str:
    return "\n".join(t for t in (s.text.strip() for s in segments) if t)


def with_ext(base: Path, ext: str) -> Path:
    return base.parent / (base.name + ext)


def unique_base(out_dir: Path, stem: str) -> Path:
    """out_dir/stem, numbered if a file with that name already exists."""
    base, n = out_dir / stem, 2
    while any(with_ext(base, e).exists() for e in (".txt", ".srt", ".wav")):
        base, n = out_dir / f"{stem}-{n}", n + 1
    return base


def _srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def save_transcript(base: Path, segments, srt: bool = False) -> list[Path]:
    text = transcript_text(segments)
    files = {with_ext(base, ".txt"): text + "\n" if text else ""}
    if srt:
        blocks = [f"{i}\n{_srt_time(s.start)} --> {_srt_time(s.end)}\n{s.text.strip()}\n"
                  for i, s in enumerate((s for s in segments if s.text.strip()), 1)]
        files[with_ext(base, ".srt")] = "\n".join(blocks)
    for path, content in files.items():
        try:
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            raise SetupError(f"Couldn't save the transcript to {path}: {exc}\n"
                             "The text is still shown on screen; copy it from there.") from exc
    return list(files)


def prepare_out_dir(path) -> Path:
    out = Path(path).expanduser().resolve()
    try:
        out.mkdir(mode=0o700, parents=True, exist_ok=True)  # private to you
    except OSError as exc:
        raise SetupError(f"Can't create the output folder {out}: {exc}") from exc
    return out


_SYNC_FOLDER_PREFIXES = ("onedrive", "dropbox", "google drive", "googledrive", "icloud",
                         "nextcloud", "owncloud", "pcloud", "proton drive", "megasync",
                         "tresorit", "seafile", "box sync")
_SYNC_FOLDER_NAMES = {"mobile documents", "cloudstorage", "my drive", "mega", "box"}


def cloud_sync_warning(path: Path) -> str | None:
    """A warning if files saved in `path` would likely be uploaded to a cloud service."""
    for part in path.parts:
        p = part.lower()
        if p in _SYNC_FOLDER_NAMES or p.startswith(_SYNC_FOLDER_PREFIXES):
            return (f"{path} looks like a cloud-synced folder ('{part}'), so recordings and\n"
                    "transcripts saved there may be uploaded. Choose a local folder with --out.")
    if sys.platform == "darwin":
        home = Path.home()
        for sub in ("Desktop", "Documents"):
            if path == home / sub or home / sub in path.parents:
                return (f"{path} is inside ~/{sub}, which iCloud uploads when 'Desktop & Documents\n"
                        "Folders' is on (System Settings > Apple Account > iCloud > iCloud Drive).")
    return None


def fmt_clock(seconds: float) -> str:
    s = int(seconds)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f} s"
    m, s = divmod(int(round(seconds)), 60)
    h, m = divmod(m, 60)
    return f"{h} h {m:02d} min" if h else f"{m} min {s:02d} s"
