"""Tests for Offline Transcriber.

Run from the app folder:  .venv/bin/python -m unittest discover tests

Tests that need the network block run in child processes, so this process
keeps its network: the FFmpeg tests use a local listener to prove that
nothing ever connects to it.
"""

import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import engine  # noqa: E402  (importing doesn't turn on the network block)

SAMPLE = ROOT / "tests" / "data" / "jfk.flac"
LINUX = sys.platform.startswith("linux")


def run_guarded(code: str, before_guard: str = "") -> str:
    """Run code in a fresh Python with the network block on; return its output."""
    program = (f"import sys\nsys.path.insert(0, {str(ROOT)!r})\n{before_guard}\n"
               f"import netguard\nnetguard.install()\n{code}")
    r = subprocess.run([sys.executable, "-I", "-c", program],
                       capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise AssertionError(r.stdout + r.stderr)
    return r.stdout


class NetworkBlockTests(unittest.TestCase):
    def test_self_test_passes(self):
        out = run_guarded("for label, ok, detail in netguard.self_test(): print(ok, '|', label, '|', detail)")
        self.assertTrue(out.strip())
        for line in out.splitlines():
            self.assertFalse(line.startswith("False"), line)

    def test_python_network_calls_are_blocked(self):
        out = run_guarded('''
import socket, urllib.request
def attempt(fn):
    try:
        fn()
    except netguard.NetworkBlockedError:
        return "blocked"
    except OSError as e:
        return "blocked" if isinstance(getattr(e, "reason", None), netguard.NetworkBlockedError) else repr(e)
    return "OPEN"
print(attempt(lambda: socket.create_connection(("127.0.0.1", 9), timeout=1)))
print(attempt(lambda: socket.getaddrinfo("example.com", 443)))
print(attempt(lambda: socket.gethostbyname("example.com")))
print(attempt(lambda: urllib.request.urlopen("http://127.0.0.1:9/", timeout=1)))
print(attempt(lambda: socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)))
''')
        self.assertEqual(out.split(), ["blocked"] * 5)

    def test_local_unix_sockets_still_work(self):
        if not hasattr(socket, "AF_UNIX") or os.name == "nt":
            self.skipTest("no Unix sockets")
        out = run_guarded("import socket\na, b = socket.socketpair()\na.send(b'ok')\nprint(b.recv(2).decode())")
        self.assertEqual(out.strip(), "ok")

    @unittest.skipUnless(LINUX, "the kernel filter is Linux-only")
    def test_kernel_blocks_native_sockets(self):
        # Look up libc's socket() before the block exists, then call it after:
        # this skips Python entirely, so only the kernel can refuse it.
        out = run_guarded('''
import os
def native(family, kind=1):
    fd = libc_socket(family, kind, 0)
    if fd >= 0:
        os.close(fd)
        return "open"
    return "refused"
print(netguard.status()["kernel_filter"], native(2), native(10), native(17, 3), native(1))
''', before_guard="import ctypes\nlibc_socket = ctypes.CDLL(None, use_errno=True).socket")
        self.assertEqual(out.split(), ["True", "refused", "refused", "refused", "open"])


class FFmpegLockTests(unittest.TestCase):
    """FFmpeg is native code the Python block can't see, so it is limited to local files."""

    def setUp(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(5)
        self.server.settimeout(0.1)
        self.port = self.server.getsockname()[1]
        self.connections = 0
        self.stopping = False
        self.thread = threading.Thread(target=self._accept)
        self.thread.start()
        self.tmp = tempfile.TemporaryDirectory()
        self.playlist = Path(self.tmp.name, "evil.m3u8")
        self.playlist.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n"
                                 f"http://127.0.0.1:{self.port}/segment.ts\n#EXT-X-ENDLIST\n")

    def _accept(self):
        while not self.stopping:
            try:
                conn, _ = self.server.accept()
                self.connections += 1
                conn.close()
            except OSError:
                pass

    def tearDown(self):
        self.stopping = True
        self.thread.join()
        self.server.close()
        self.tmp.cleanup()

    def connections_after_a_moment(self):
        time.sleep(0.5)
        return self.connections

    def test_playlist_pointing_online_is_refused(self):
        with self.assertRaises(engine.SetupError):
            engine.load_audio_file(self.playlist)
        self.assertEqual(self.connections_after_a_moment(), 0)

    def test_network_address_as_input_is_refused(self):
        import av
        with self.assertRaises(Exception):
            av.open(f"tcp://127.0.0.1:{self.port}", mode="r",
                    container_options=engine.FFMPEG_OPTIONS, timeout=2)
        self.assertEqual(self.connections_after_a_moment(), 0)

    def test_control_without_the_lock_does_connect(self):
        # Proves the two tests above would notice a leak.
        import av
        try:
            av.open(str(self.playlist), mode="r", timeout=2,
                    container_options={"protocol_whitelist": "file,http,tcp,crypto,data"}).close()
        except Exception:
            pass
        self.assertGreater(self.connections_after_a_moment(), 0)


class ModelTests(unittest.TestCase):
    def test_model_without_tokenizer_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ("model.bin", "config.json", "vocabulary.txt"):
                Path(d, name).write_text("x")
            with self.assertRaises(engine.SetupError) as cm:
                engine.check_model_dir(Path(d))
            self.assertIn("tokenizer.json", str(cm.exception))

    def test_engine_refuses_to_run_without_network_block(self):
        with self.assertRaises(RuntimeError):
            engine.load_model(Path(tempfile.gettempdir()))


class HelperTests(unittest.TestCase):
    def test_parse_language(self):
        self.assertIsNone(engine.parse_language("auto"))
        self.assertIsNone(engine.parse_language(None))
        self.assertEqual(engine.parse_language("NL"), "nl")
        self.assertEqual(engine.parse_language("dutch"), "nl")
        with self.assertRaises(engine.SetupError):
            engine.parse_language("klingon")

    def test_cloud_sync_warning(self):
        home = Path.home()
        for synced in (home / "OneDrive - Acme" / "notes", home / "Dropbox" / "x",
                       home / "Library" / "CloudStorage" / "GoogleDrive-a@b.c" / "My Drive",
                       home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"):
            self.assertIsNotNone(engine.cloud_sync_warning(synced), synced)
        self.assertIsNone(engine.cloud_sync_warning(Path("/home/megan/OfflineTranscriber")))

    def test_transcript_and_subtitles(self):
        Seg = namedtuple("Seg", "start end text")
        segments = [Seg(0.0, 1.5, " Hello."), Seg(2.0, 2.5, "  "), Seg(61.25, 3725.0, " World ")]
        with tempfile.TemporaryDirectory() as d:
            txt, srt = engine.save_transcript(Path(d, "x.y"), segments, srt=True)
            self.assertEqual(txt.name, "x.y.txt")
            self.assertEqual(txt.read_text(encoding="utf-8"), "Hello.\nWorld\n")
            self.assertEqual(srt.read_text(encoding="utf-8"),
                             "1\n00:00:00,000 --> 00:00:01,500\nHello.\n\n"
                             "2\n00:01:01,250 --> 01:02:05,000\nWorld\n")

    def test_unique_names(self):
        with tempfile.TemporaryDirectory() as d:
            first = engine.unique_base(Path(d), "rec")
            engine.with_ext(first, ".txt").write_text("")
            self.assertEqual(engine.unique_base(Path(d), "rec").name, "rec-2")

    def test_resampling_to_16khz(self):
        import numpy as np
        tone = (np.sin(np.arange(48000) * 2 * np.pi * 440 / 48000) * 10000).astype(np.int16)
        out = engine.to_model_input(tone, 48000)
        self.assertAlmostEqual(len(out), 16000, delta=200)
        self.assertTrue(0.25 < float(np.abs(out).max()) < 0.35)

    def test_audio_file_decoding(self):
        audio = engine.load_audio_file(SAMPLE)
        self.assertAlmostEqual(len(audio) / engine.SAMPLE_RATE, 11.0, delta=0.1)


@unittest.skipUnless(engine.installed_models(), "no speech model installed")
class EndToEndTests(unittest.TestCase):
    def test_transcribe_file_offline(self):
        with tempfile.TemporaryDirectory() as out:
            r = subprocess.run([sys.executable, "-I", str(ROOT / "transcriber.py"), "transcribe",
                                str(SAMPLE), "-o", out, "-l", "en"],
                               capture_output=True, text=True, timeout=900)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            text = Path(out, "jfk.txt").read_text(encoding="utf-8").lower()
        self.assertIn("ask not what your country can do for you", text)


if __name__ == "__main__":
    unittest.main()
