"""App window for Offline Transcriber (Tkinter, which ships with Python).

Started by transcriber.py, which has already blocked network access.
Only the main thread touches the window; worker threads report back
through a queue that the window polls.
"""

from __future__ import annotations

import datetime as dt
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from tkinter import font as tkfont

import engine
from engine import SetupError

AUDIO_TYPES = ("*.wav *.mp3 *.m4a *.mp4 *.aac *.flac *.ogg *.opus *.oga *.webm "
               "*.mov *.mkv *.avi *.wma *.aif *.aiff *.caf *.amr *.3gp")
GREEN, ORANGE, RED, GRAY = "#1b7f3b", "#b35c00", "#c62828", "#777777"


@dataclass
class Job:
    title: str
    language: str | None
    prompt: str | None
    base: Path | None = None   # output name without extension
    path: str | None = None    # file to transcribe, or:
    samples: object = None     # recorded int16 samples
    rate: int = 0


class App:
    def __init__(self, root: tk.Tk, args, privacy_report):
        self.root, self.args, self.privacy_report = root, args, privacy_report
        self.out_dir = engine.prepare_out_dir(args.out)
        self.events: queue.Queue = queue.Queue()   # worker threads -> window
        self.jobs: queue.Queue = queue.Queue()     # audio waiting for transcription
        self.model = None
        self.model_loading = False
        self.recorder = None
        self.recording_live = False
        self.rec_base = None
        self.rec_time = dt.datetime.now()
        self.rec_started = 0.0
        self.pending_jobs = 0
        self.closing = False
        self.last_text = ""
        # Cleared while recording: transcription pauses so it can't compete
        # with the microphone for the CPU.
        self.may_transcribe = threading.Event()
        self.may_transcribe.set()

        self.mics = self._list_mics()
        self._build()
        self._refresh_privacy()
        threading.Thread(target=self._worker, name="transcriber", daemon=True).start()
        self._load_model(self.model_var.get() or None)
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(50, self._poll)

    # --- layout ------------------------------------------------------------

    def _build(self) -> None:
        root = self.root
        root.title("Offline Transcriber")
        root.minsize(640, 460)
        root.geometry("800x600")
        style = ttk.Style()
        if sys.platform.startswith("linux") and "clam" in style.theme_names():
            style.theme_use("clam")
        base = tkfont.nametofont("TkDefaultFont")
        size = base.cget("size")  # negative means pixels

        def bigger(font, step):
            f = font.copy()
            f.configure(size=size + step if size > 0 else size - step)
            return f

        self.font_button = bigger(base, 3)
        self.font_button.configure(weight="bold")
        self.font_head = bigger(base, 1)
        self.font_head.configure(weight="bold")
        self.font_clock = bigger(tkfont.nametofont("TkFixedFont"), 6)
        style.configure("Record.TButton", font=self.font_button, padding=(18, 8))

        top = ttk.Frame(root, padding=(12, 10, 12, 4))
        top.pack(fill="x")
        top.columnconfigure(0, weight=1)
        self.privacy_labels = [ttk.Label(top, anchor="w", justify="left") for _ in range(3)]
        for row, label in enumerate(self.privacy_labels):
            label.grid(row=row, column=0, sticky="ew")
            label.bind("<Configure>", lambda e: e.widget.configure(wraplength=max(e.width - 4, 200)))

        controls = ttk.Frame(root, padding=(12, 6))
        controls.pack(fill="x")
        self.record_btn = ttk.Button(controls, text="● Record", style="Record.TButton",
                                     command=self.toggle_record, width=11)
        self.record_btn.grid(row=0, column=0, rowspan=2, padx=(0, 14))
        self.clock_var = tk.StringVar(value="00:00")
        ttk.Label(controls, textvariable=self.clock_var, font=self.font_clock).grid(
            row=0, column=1, sticky="w")
        self.meter = tk.Canvas(controls, width=150, height=10, highlightthickness=0, bg="#dddddd")
        self.meter.grid(row=1, column=1, sticky="w")
        self.meter_bar = self.meter.create_rectangle(0, 0, 0, 10, width=0, fill=GREEN)

        options = ttk.Frame(controls)
        options.grid(row=0, column=2, rowspan=2, sticky="e", padx=(20, 0))
        controls.columnconfigure(2, weight=1)

        ttk.Label(options, text="Microphone").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.mic_var = tk.StringVar(value=self.mics[0][0] if self.mics else "")
        self.mic_box = ttk.Combobox(options, textvariable=self.mic_var, state="readonly", width=30,
                                    values=[name for name, _ in self.mics])
        self.mic_box.grid(row=0, column=1, sticky="ew", pady=2)

        ttk.Label(options, text="Language").grid(row=1, column=0, sticky="w", padx=(0, 6))
        langs = sorted(engine.LANGUAGES.items(), key=lambda kv: kv[1])
        self.lang_values = ["Auto-detect"] + [f"{name} ({code})" for code, name in langs]
        try:
            code = engine.parse_language(self.args.language)
        except SetupError:
            code = None
        self.lang_var = tk.StringVar(
            value=f"{engine.LANGUAGES[code]} ({code})" if code else "Auto-detect")
        ttk.Combobox(options, textvariable=self.lang_var, state="readonly", width=30,
                     values=self.lang_values, height=20).grid(row=1, column=1, sticky="ew", pady=2)

        ttk.Label(options, text="Model").grid(row=2, column=0, sticky="w", padx=(0, 6))
        models = engine.installed_models()
        if self.args.model and self.args.model not in models:
            models.insert(0, self.args.model)
        self.model_var = tk.StringVar(value=self.args.model or (models[0] if models else ""))
        self.model_box = ttk.Combobox(options, textvariable=self.model_var, state="readonly",
                                      width=30, values=models)
        self.model_box.grid(row=2, column=1, sticky="ew", pady=2)
        self.model_box.bind("<<ComboboxSelected>>", lambda e: self._load_model(self.model_var.get()))

        # Packed before the transcript area so it stays visible in a small window.
        bottom = ttk.Frame(root, padding=(12, 6, 12, 10))
        bottom.pack(side="bottom", fill="x")
        ttk.Button(bottom, text="Transcribe file...", command=self.pick_files).pack(side="left")
        ttk.Button(bottom, text="Copy last transcript", command=self.copy_last).pack(side="left", padx=6)
        ttk.Button(bottom, text="Open folder", command=self.open_folder).pack(side="left")
        self.status_var = tk.StringVar()
        ttk.Label(bottom, textvariable=self.status_var, foreground=GRAY, anchor="e").pack(
            side="right", fill="x", expand=True)

        body = ttk.Frame(root, padding=(12, 4))
        body.pack(fill="both", expand=True)
        self.font_text = bigger(base, 1)
        self.text = tk.Text(body, wrap="word", state="disabled", relief="flat", padx=10, pady=8,
                            height=8, font=self.font_text, spacing3=2,
                            borderwidth=1, highlightthickness=1, highlightcolor="#999999",
                            highlightbackground="#cccccc", undo=False)
        scroll = ttk.Scrollbar(body, command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True)
        self.text.tag_configure("head", font=self.font_head, spacing1=10, spacing3=4)
        self.text.tag_configure("note", foreground=GRAY)
        self.text.tag_configure("error", foreground=RED)

        for seq in ("<Control-r>", "<Command-r>"):
            try:
                root.bind_all(seq, lambda e: self.toggle_record())
            except tk.TclError:
                pass  # <Command-...> only exists on macOS

        self._write(f"Recordings and transcripts are saved in {self.out_dir}\n", "note")
        self._write("Press Record (or Ctrl+R) to start.\n", "note")

    def _list_mics(self) -> list[tuple[str, object]]:
        try:
            devices = engine.input_devices()
        except SetupError as exc:
            self.mic_error = str(exc)
            return []
        self.mic_error = None if devices else "No microphone found."
        default = next((d for d in devices if d["default"]), None)
        mics = [(f"Default ({default['name']})" if default else "Default", None)]
        mics += [(f"{d['name']} [{d['index']}]", d["index"]) for d in devices]
        return mics

    # --- small helpers -----------------------------------------------------

    def _write(self, text: str, tag: str | None = None) -> None:
        at_end = self.text.yview()[1] > 0.98
        self.text.configure(state="normal")
        self.text.insert("end", text, tag)
        self.text.configure(state="disabled")
        if at_end:
            self.text.see("end")

    def _status(self, text: str) -> None:
        self.status_var.set(text)

    def _language(self) -> str | None:
        value = self.lang_var.get()
        return None if value == "Auto-detect" else value.rsplit("(", 1)[1].rstrip(")")

    def _mic(self):
        return dict(self.mics).get(self.mic_var.get())

    def _refresh_privacy(self) -> None:
        if self.closing:
            return
        lines = self.privacy_report(self.out_dir)
        for label, (level, msg) in zip(self.privacy_labels, lines + [("", "")] * 3):
            if not msg:
                label.grid_remove()
                continue
            label.configure(text=("✓ " if level == "ok" else "⚠ ") + msg.replace("\n", " "),
                            foreground=GREEN if level == "ok" else ORANGE)
            label.grid()
        self.root.after(5000, self._refresh_privacy)

    def _update_controls(self) -> None:
        recording = self.recorder is not None
        if recording:
            self.record_btn.configure(text="■ Stop" if self.recording_live else "Starting...",
                                      state="normal" if self.recording_live else "disabled")
        else:
            ready = self.model is not None and not self.model_loading and not self.mic_error
            self.record_btn.configure(text="● Record", state="normal" if ready else "disabled")
        self.model_box.configure(state="disabled" if recording or self.model_loading else "readonly")
        self.mic_box.configure(state="disabled" if recording else "readonly")

    # --- model -------------------------------------------------------------

    def _load_model(self, name: str | None) -> None:
        self.model = None
        self.model_loading = True
        self._update_controls()
        self._status(f"Loading model '{name}'..." if name else "No model installed")

        def work():
            try:
                path = engine.resolve_model(name)
                model = engine.load_model(path, compute=self.args.compute, threads=self.args.threads)
                self.events.put(("model", path.name, model))
            except Exception as exc:
                self.events.put(("model_error", str(exc)))

        threading.Thread(target=work, name="model-loader", daemon=True).start()

    # --- recording ---------------------------------------------------------

    def toggle_record(self) -> None:
        if self.recorder is None:
            self.start_recording()
        elif self.recording_live:
            self.stop_recording()

    def start_recording(self) -> None:
        if self.model is None or self.model_loading or str(self.record_btn["state"]) == "disabled":
            return
        self.rec_time = dt.datetime.now()
        base = engine.unique_base(self.out_dir, f"{self.rec_time:%Y-%m-%d_%H-%M-%S}")
        self.may_transcribe.clear()  # pause any running transcription first
        try:
            rec = engine.Recorder(self._mic(), engine.with_ext(base, ".wav"))
            rec.start(wait=False)
        except Exception as exc:
            self.may_transcribe.set()
            messagebox.showerror("Microphone", str(exc))
            return
        self.recorder, self.rec_base = rec, base
        self.recording_live = False
        self.rec_started = time.monotonic()
        self._status("Starting microphone...")
        self._update_controls()

    def stop_recording(self) -> None:
        rec, self.recorder, self.recording_live = self.recorder, None, False
        try:
            samples = rec.stop()
        finally:
            self.may_transcribe.set()
            self.clock_var.set("00:00")
            self.meter.coords(self.meter_bar, 0, 0, 0, 10)
            self._update_controls()
        seconds = len(samples) / rec.samplerate
        problems = rec.problems()
        if problems:
            messagebox.showwarning("Recording", "\n\n".join(problems))
        if seconds < 0.5 or rec.peak < 32:
            if rec.wav_path:
                rec.wav_path.unlink(missing_ok=True)
            self._write(f"\nRecording discarded ({engine.fmt_duration(seconds)}, no sound).\n", "note")
            self._status("Ready")
            return
        title = f"Recording {self.rec_time:%Y-%m-%d %H:%M:%S} ({engine.fmt_duration(seconds)})"
        self._enqueue(Job(title, self._language(), self.args.prompt, base=self.rec_base,
                          samples=samples, rate=rec.samplerate))

    def _check_recording(self) -> None:
        rec = self.recorder
        if rec is None:
            return
        if not self.recording_live:
            if rec.flowing.is_set():
                self.recording_live = True
                self._status("Recording... (press Stop or Ctrl+R)")
                self._update_controls()
            elif time.monotonic() - self.rec_started > 6:
                self.recorder = None
                rec.stop()
                if rec.wav_path and rec.frames == 0:
                    rec.wav_path.unlink(missing_ok=True)
                self.may_transcribe.set()
                self._update_controls()
                self._status("Ready")
                messagebox.showerror("Microphone", "The microphone sent no audio.\n\n" + engine.MIC_HELP)
            return
        self.clock_var.set(engine.fmt_clock(rec.seconds))
        level = rec.level
        color = GREEN if level < 0.88 else ORANGE if level < 0.96 else RED  # red: close to clipping
        self.meter.coords(self.meter_bar, 0, 0, int(150 * level), 10)
        self.meter.itemconfigure(self.meter_bar, fill=color)

    # --- transcription -----------------------------------------------------

    def _enqueue(self, job: Job) -> None:
        self.pending_jobs += 1
        self.jobs.put(job)
        if self.pending_jobs > 1:
            self._status(f"{self.pending_jobs} transcriptions waiting")

    def _should_stop(self) -> bool:
        if not self.may_transcribe.is_set():
            self.events.put(("paused",))
            self.may_transcribe.wait()
            self.events.put(("resumed",))
        return self.closing

    def _worker(self) -> None:
        while True:
            job = self.jobs.get()
            while True:  # wait for a loaded model (e.g. still loading at startup)
                self.may_transcribe.wait()
                model = self.model
                if model is not None and not self.model_loading:
                    break
                time.sleep(0.2)
            self.events.put(("job_start", job))
            try:
                if job.path:
                    audio = engine.load_audio_file(job.path)
                else:
                    audio = engine.to_model_input(job.samples, job.rate)
                    job.samples = None
                total = max(len(audio) / engine.SAMPLE_RATE, 0.01)

                def on_segment(seg, info):
                    self.events.put(("segment", seg.text.strip(), min(seg.end / total, 1.0)))

                segments, info = engine.transcribe(model, audio, job.language, job.prompt,
                                                   on_segment, should_stop=self._should_stop)
                if self.closing:
                    return
                base = job.base or engine.unique_base(self.out_dir, Path(job.path).stem)
                paths = engine.save_transcript(base, segments, srt=self.args.srt)
                self.events.put(("job_done", paths, engine.transcript_text(segments), info, job))
            except SetupError as exc:
                self.events.put(("job_error", str(exc)))
            except Exception as exc:
                self.events.put(("job_error", f"{type(exc).__name__}: {exc}"))

    def _handle(self, event: tuple) -> None:
        kind = event[0]
        if kind == "model":
            _, name, model = event
            self.model, self.model_loading = model, False
            self.model_var.set(name)
            self._status(f"Ready · model {name}")
        elif kind == "model_error":
            self.model_loading = False
            self._status("No model loaded")
            self._write("\n" + event[1] + "\n", "error")
        elif kind == "job_start":
            job = event[1]
            self._write(f"\n{job.title}\n", "head")
            self._status("Transcribing...")
        elif kind == "segment":
            _, text, progress = event
            if text:
                self._write(text + "\n")
            self._status(f"Transcribing... {progress:.0%}")
        elif kind == "paused":
            self._status("Recording... (transcription paused)")
        elif kind == "resumed":
            self._status("Transcribing...")
        elif kind == "job_done":
            _, paths, text, info, job = event
            self.pending_jobs -= 1
            self.last_text = text
            if not text:
                self._write("(no speech detected)\n", "note")
            lang = engine.LANGUAGES.get(info.language, info.language)
            self._write(f"{lang} · saved {', '.join(p.name for p in paths)}\n", "note")
            self._status("Ready" if not self.pending_jobs else f"{self.pending_jobs} waiting")
        elif kind == "job_error":
            self.pending_jobs -= 1
            self._write(event[1] + "\n", "error")
            self._status("Ready")
        self._update_controls()

    def _poll(self) -> None:
        try:
            while True:
                self._handle(self.events.get_nowait())
        except queue.Empty:
            pass
        self._check_recording()
        if not self.closing:
            self.root.after(50, self._poll)

    # --- buttons -----------------------------------------------------------

    def pick_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="Choose audio or video files",
            filetypes=[("Audio and video", AUDIO_TYPES), ("All files", "*")])
        for path in paths:
            self._enqueue(Job(Path(path).name, self._language(), self.args.prompt, path=path))

    def copy_last(self) -> None:
        if not self.last_text:
            self._status("Nothing to copy yet")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.last_text)
        self._status("Copied to clipboard")

    def open_folder(self) -> None:
        try:
            if sys.platform == "win32":
                os.startfile(self.out_dir)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(self.out_dir)])
            else:
                subprocess.Popen(["xdg-open", str(self.out_dir)])
        except Exception:
            messagebox.showinfo("Folder", str(self.out_dir))

    def on_close(self) -> None:
        if self.recorder is not None:
            if not messagebox.askyesno("Quit", "Stop recording and quit? The audio recorded so far "
                                               "is saved, and you can transcribe it later."):
                return
            rec, self.recorder = self.recorder, None
            rec.stop()
        elif self.pending_jobs:
            if not messagebox.askyesno("Quit", "A transcription is still running. Quit anyway?\n"
                                               "Recordings are saved, so you can transcribe them later "
                                               "with 'Transcribe file...'."):
                return
        self.closing = True
        self.may_transcribe.set()
        self.root.destroy()


def run(args, privacy_report) -> int:
    if sys.platform == "win32":
        try:  # sharp text on high-resolution screens
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    try:
        root = tk.Tk()
    except tk.TclError as exc:
        raise SetupError(f"Can't open a window ({exc}). Use the command line instead, "
                         "e.g.: transcriber.py record") from exc
    try:
        app = App(root, args, privacy_report)
    except SetupError:
        root.destroy()
        raise
    if app.mic_error:
        app._write("\n" + app.mic_error + "\n", "error")
    # Started from a terminal, the window can open behind it: bring it forward.
    root.lift()
    root.attributes("-topmost", True)
    root.after(300, lambda: root.attributes("-topmost", False))
    root.focus_force()
    root.mainloop()
    return 0
