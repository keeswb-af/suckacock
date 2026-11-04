"""Network kill-switch for Offline Transcriber.

Call ``install()`` before importing anything else. From then on this process
cannot use the network, and the block cannot be turned off again.

Layers:

1. Kernel filter (Linux on x86-64 or ARM64). A seccomp filter makes the kernel
   refuse to create any socket except local Unix sockets (needed to talk to the
   sound server) and netlink sockets (which only talk to the kernel). This
   covers all code in the process, including native libraries, and every
   program it starts.
2. Python audit hook (every OS). Python refuses to create non-Unix sockets,
   connect, send, or look up host names. Audit hooks are built into CPython
   and cannot be removed once added.
3. Offline switches for the Hugging Face libraries (no downloads, no telemetry).

The transcriber also only lets FFmpeg open local files (see
``transcriber.load_audio_file``), because FFmpeg is native code that layer 2
cannot see.

macOS and Windows have no layer 1. There, keeping the computer offline is what
also covers misbehaving native code, and ``network_connections()`` reports
whether it is offline.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys

__all__ = [
    "NetworkBlockedError",
    "install",
    "status",
    "network_connections",
    "self_test",
]


class NetworkBlockedError(PermissionError):
    """Raised when anything in this process tries to use the network."""


_OFFLINE_ENV = {
    "HF_HUB_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    # onnxruntime (used for voice detection) ships Microsoft telemetry that is on
    # by default and sent from native code. This switches it off entirely: no
    # uploader, no events, no device ID file. Must be set before it loads.
    "ORT_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
}

_AF_UNIX = getattr(socket, "AF_UNIX", None)  # missing on some Windows builds

# Host name lookups are blocked too: a DNS query by itself reveals data.
_LOOKUP_EVENTS = frozenset({
    "socket.getaddrinfo",
    "socket.gethostbyname",
    "socket.gethostbyaddr",
    "socket.getnameinfo",
})
_USE_EVENTS = frozenset({
    "socket.connect",
    "socket.bind",
    "socket.sendto",
    "socket.sendmsg",
})
# C functions that Python code could reach through ctypes to get around the
# audit hook. Nothing in this app needs any of them.
_NATIVE_NET_SYMBOLS = frozenset({
    "socket", "connect", "bind", "sendto", "sendmsg", "sendmmsg", "syscall",
    "getaddrinfo", "getaddrinfo_a", "getnameinfo",
    "gethostbyname", "gethostbyname2", "gethostbyname_r", "gethostbyname2_r",
    "gethostbyaddr", "gethostbyaddr_r",
    "res_init", "res_query", "res_search", "res_send",
    "res_nquery", "res_nsearch", "res_nsend",
    "WSAStartup", "WSASocketA", "WSASocketW", "WSAConnect",
    "WSAConnectByNameA", "WSAConnectByNameW", "WSASendTo",
    "GetAddrInfoW", "GetAddrInfoExA", "GetAddrInfoExW",
    "DnsQuery_A", "DnsQuery_W", "DnsQueryEx",
    "InternetOpenA", "InternetOpenW", "InternetOpenUrlA", "InternetOpenUrlW",
    "WinHttpOpen", "WinHttpConnect", "URLDownloadToFileA", "URLDownloadToFileW",
})

# Audit hooks belong to one interpreter. A sub-interpreter would start without
# this one, so the modules that create them are made unimportable (a None entry
# in sys.modules stops every import route; the audit hook catches the rest).
_BLOCKED_MODULES = frozenset({
    "_interpreters", "_xxsubinterpreters", "_testcapi", "_testinternalcapi",
})

_state = {"python_hook": False, "kernel_filter": False, "kernel_detail": "not attempted"}


def _blocked(what: str) -> NetworkBlockedError:
    return NetworkBlockedError(f"Network access is disabled in Offline Transcriber ({what}).")


def _audit_hook(event: str, args: tuple) -> None:
    # Called for every audited action in the process, so keep the fast path cheap.
    if event.startswith("socket."):
        if event == "socket.__new__":
            # args: (socket, family, type, protocol). family is -1 when it would
            # be auto-detected, which is blocked as well.
            if _AF_UNIX is None or args[1] != _AF_UNIX:
                raise _blocked(f"socket family {args[1]}")
        elif event in _LOOKUP_EVENTS:
            raise _blocked(f"host lookup {args[0]!r}")
        elif event in _USE_EVENTS:
            if _AF_UNIX is None or getattr(args[0], "family", None) != _AF_UNIX:
                raise _blocked(event)
    elif event.startswith("ctypes.dlsym"):
        name = args[1] if len(args) > 1 else None
        if isinstance(name, bytes):
            name = name.decode("ascii", "replace")
        if name in _NATIVE_NET_SYMBOLS:
            raise _blocked(f"native function {name}")
    elif event == "import" and args[0] in _BLOCKED_MODULES:
        raise _blocked(f"module {args[0]} would run code without this block")


# --- Linux kernel filter (seccomp) -------------------------------------------

# Per CPU: (AUDIT_ARCH value, socket syscall, seccomp syscall, has x32 ABI)
_SECCOMP_ARCHES = {
    "x86_64": (0xC000003E, 41, 317, True),
    "amd64": (0xC000003E, 41, 317, True),
    "aarch64": (0xC00000B7, 198, 277, False),
    "arm64": (0xC00000B7, 198, 277, False),
}
_IO_URING_FIRST, _IO_URING_END = 425, 428  # io_uring_setup/enter/register, same on both CPUs


def _seccomp_program(arch: int, nr_socket: int, has_x32: bool) -> list[tuple[int, int, int, int]]:
    """Classic BPF program: refuse socket() unless the family is AF_UNIX or
    AF_NETLINK, and refuse io_uring, which can create sockets without socket()."""
    ld_abs, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06
    allow = 0x7FFF0000
    errno_eacces = 0x00050000 | 13
    errno_enosys = 0x00050000 | 38
    af_unix, af_netlink = 1, 16

    def op(code, k, jt=0, jf=0):
        return (code, jt, jf, k)  # jt/jf skip that many instructions

    prog = [
        op(ld_abs, 4),                      # A = seccomp_data.arch
        op(jeq, arch, jt=1),                # same ABI as this process?
        op(ret, errno_enosys),              #   no: refuse (e.g. 32-bit int 0x80)
        op(ld_abs, 0),                      # A = syscall number
    ]
    if has_x32:
        prog += [
            op(jge, 0x40000000, jf=1),      # x32 ABI syscall?
            op(ret, errno_enosys),          #   yes: refuse
        ]
    prog += [
        op(jge, _IO_URING_FIRST, jf=2),     # io_uring_* ?
        op(jge, _IO_URING_END, jt=1),
        op(ret, errno_enosys),              #   yes: refuse
        op(jeq, nr_socket, jt=1),           # socket() ?
        op(ret, allow),                     #   no: everything else is allowed
        op(ld_abs, 16),                     # A = first argument (address family)
        op(jeq, af_unix, jt=2),
        op(jeq, af_netlink, jt=1),
        op(ret, errno_eacces),              # any other family: refuse
        op(ret, allow),
    ]
    return prog


def _install_linux_kernel_filter() -> str:
    import ctypes
    import platform

    machine = platform.machine().lower()
    if machine not in _SECCOMP_ARCHES:
        raise OSError(f"no kernel filter for CPU type '{machine}'")
    arch, nr_socket, nr_seccomp, has_x32 = _SECCOMP_ARCHES[machine]

    class SockFilter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]

    prog = _seccomp_program(arch, nr_socket, has_x32)
    filters = (SockFilter * len(prog))(*(SockFilter(*ins) for ins in prog))
    fprog = SockFprog(len(prog), filters)

    libc = ctypes.CDLL(None, use_errno=True)
    ulong = ctypes.c_ulong
    # Required before an unprivileged process may install a filter.
    if libc.prctl(ctypes.c_int(38), ulong(1), ulong(0), ulong(0), ulong(0)) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")
    # SECCOMP_SET_MODE_FILTER with SECCOMP_FILTER_FLAG_TSYNC applies it to every thread.
    if libc.syscall(ctypes.c_long(nr_seccomp), ulong(1), ulong(1), ctypes.byref(fprog)) != 0:
        # Older kernels: PR_SET_SECCOMP covers this thread and threads started later.
        if libc.prctl(ctypes.c_int(22), ulong(2), ctypes.byref(fprog), ulong(0), ulong(0)) != 0:
            raise OSError(ctypes.get_errno(), "installing seccomp filter failed")
    if _linux_seccomp_mode() != 2:
        raise OSError("kernel reports no active filter")
    return "Linux kernel blocks all non-local sockets for this process"


def _linux_seccomp_mode() -> int | None:
    try:
        with open("/proc/self/status", encoding="ascii", errors="replace") as f:
            for line in f:
                if line.startswith("Seccomp:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


# --- public API --------------------------------------------------------------

def install() -> dict:
    """Block all network access for the rest of this process's life. Safe to call twice."""
    if _state["python_hook"]:
        return status()
    os.environ.update(_OFFLINE_ENV)

    # The kernel filter goes first: it needs ctypes calls the audit hook refuses.
    if sys.platform.startswith("linux"):
        try:
            _state["kernel_detail"] = _install_linux_kernel_filter()
            _state["kernel_filter"] = True
        except Exception as exc:  # never fatal: the Python layer still applies
            _state["kernel_detail"] = f"unavailable ({exc})"
    else:
        _state["kernel_detail"] = "not available on this OS (keep the computer offline)"

    for name in _BLOCKED_MODULES:
        sys.modules[name] = None
    sys.addaudithook(_audit_hook)
    _state["python_hook"] = True
    return status()


def status() -> dict:
    return dict(_state)


def network_connections() -> list[str] | None:
    """Connections that could reach other computers, e.g. ["wlan0 (192.168.1.20)"].

    An empty list means offline; None means it could not be determined. Only
    reads local system state, never sends anything.
    """
    if sys.platform.startswith("linux"):
        return _linux_connections()
    return _psutil_connections()


def _linux_connections() -> list[str] | None:
    names = []
    try:
        with open("/proc/net/route", encoding="ascii") as f:
            next(f, None)
            for line in f:
                p = line.split()
                # Iface Destination Gateway Flags ... Mask: default route = dest 0, mask 0, RTF_UP
                if len(p) >= 8 and p[1] == "00000000" and p[7] == "00000000" and int(p[3], 16) & 1:
                    names.append(p[0])
    except (OSError, ValueError):
        return None
    try:
        with open("/proc/net/ipv6_route", encoding="ascii") as f:
            for line in f:
                p = line.split()
                if len(p) >= 10 and p[0] == "0" * 32 and p[1] == "00" and p[9] != "lo":
                    flags = int(p[8], 16)
                    if flags & 0x1 and not flags & 0x200:  # RTF_UP and not RTF_REJECT
                        names.append(p[9])
    except (OSError, ValueError):
        pass  # IPv6 disabled

    result = []
    for name in dict.fromkeys(names):
        try:
            with open(f"/sys/class/net/{name}/operstate", encoding="ascii") as f:
                if f.read().strip() in ("down", "lowerlayerdown", "notpresent"):
                    continue
        except OSError:
            pass
        result.append(name + _address_suffix(name))
    return result


def _address_suffix(name: str) -> str:
    try:
        import ipaddress
        import psutil
        for a in psutil.net_if_addrs().get(name, []):
            if a.family in (socket.AF_INET, socket.AF_INET6):
                ip = ipaddress.ip_address(a.address.split("%")[0])
                if not (ip.is_loopback or ip.is_link_local):
                    return f" ({ip})"
    except Exception:
        pass
    return ""


def _psutil_connections() -> list[str] | None:
    try:
        import ipaddress
        import psutil
        stats = psutil.net_if_stats()
        addrs = psutil.net_if_addrs()
    except Exception:
        return None
    found = []
    for name, entries in addrs.items():
        st = stats.get(name)
        if st is not None and not st.isup:
            continue
        for a in entries:
            if a.family not in (socket.AF_INET, socket.AF_INET6):
                continue
            try:
                ip = ipaddress.ip_address(a.address.split("%")[0])
            except ValueError:
                continue
            if ip.is_loopback or ip.is_link_local or ip.is_unspecified:
                continue
            found.append(f"{name} ({ip})")
            break
    return found


_CHILD_SOCKET_TEST = (
    "import socket\n"
    "try:\n"
    "    socket.socket(socket.AF_INET, socket.SOCK_DGRAM).close()\n"
    "except OSError as e:\n"
    "    print('BLOCKED', e.errno)\n"
    "else:\n"
    "    print('OPEN')\n"
)


def self_test() -> list[tuple[str, bool | None, str]]:
    """Check that the block works. Returns (check, passed, detail) rows, where
    passed is None for a check that doesn't apply on this OS.

    Nothing here can reach another computer even if the guard were broken:
    sockets are only created (never connected), the lookup is for "localhost"
    and the HTTP request targets this computer.
    """
    results = []

    def expect_blocked(label, fn):
        try:
            fn()
        except NetworkBlockedError:
            results.append((label, True, "blocked"))
        except OSError as exc:  # urllib wraps the error in URLError(reason=...)
            ok = isinstance(getattr(exc, "reason", None), NetworkBlockedError)
            results.append((label, ok, "blocked" if ok else f"unexpected error: {exc!r}"))
        except Exception as exc:
            results.append((label, False, f"unexpected error: {exc!r}"))
        else:
            results.append((label, False, "NOT blocked"))

    expect_blocked("Python: open IPv4 socket",
                   lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM).close())
    expect_blocked("Python: open IPv6 socket",
                   lambda: socket.socket(socket.AF_INET6, socket.SOCK_DGRAM).close())
    expect_blocked("Python: DNS lookup", lambda: socket.getaddrinfo("localhost", 80))

    def http_request():
        import urllib.request
        no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        no_proxy.open("http://127.0.0.1:9/", timeout=2)
    expect_blocked("Python: HTTP request", http_request)

    def sub_interpreter():
        import importlib
        for name in ("_interpreters", "_xxsubinterpreters"):
            try:
                importlib.import_module(name)
            except (ImportError, NetworkBlockedError):
                continue  # blocked, or not part of this Python
            return  # imported: NOT blocked
        raise NetworkBlockedError("no sub-interpreter module can be loaded")
    expect_blocked("Python: sub-interpreters (would start without the block)", sub_interpreter)

    if os.name == "posix":
        def ctypes_socket():
            import ctypes
            ctypes.CDLL(None).socket
        expect_blocked("Python: native socket() via ctypes", ctypes_socket)

    # A fresh interpreter has no audit hook; only the kernel filter can stop it.
    label = "Kernel: socket in a child process"
    if not sys.platform.startswith("linux"):
        results.append((label, None, _state["kernel_detail"]))
    elif not _state["kernel_filter"]:
        results.append((label, False, _state["kernel_detail"]))
    else:
        try:
            out = subprocess.run([sys.executable, "-I", "-S", "-c", _CHILD_SOCKET_TEST],
                                 capture_output=True, text=True, timeout=30).stdout.strip()
            results.append((label, out.startswith("BLOCKED"), out or "no output"))
        except Exception as exc:
            results.append((label, False, f"could not run test: {exc!r}"))
    return results
