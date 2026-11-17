# -*- coding: utf-8 -*-
"""
launch.py - 先启动 ComfyUI，端口就绪后再启动 CYUI；关闭窗口自动清理子进程；
CYUI 的 Werkzeug/Flask 访问日志在控制台中被过滤，只保留业务日志。
放置位置：.../ComfyUI/launch.py
"""
import os
import re
import sys
import time
import socket
import atexit
import signal
import threading
import subprocess
import webbrowser
from urllib.parse import urlparse

# ===================== 路径推导（全部相对） =====================
BASE      = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT  = os.path.abspath(os.path.join(BASE, ".."))
PYTHON    = os.path.join(PKG_ROOT, "python312", "python.exe")
COMFY_DIR = BASE
CYUI_DIR  = os.path.join(BASE, "wwdm-cyui")
COMFY_ENTRY = "main.py"
CYUI_ENTRY  = "run.py"

COMFY_READY_TIMEOUT = 300
COMFY_TCP_TIMEOUT   = 15
FALLBACK_URLS       = []
# ==============================================================

URL_RE = re.compile(r"https?://(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?(?:/\S*)?")

# ===================== 控制台日志过滤器 ======================
# 只影响控制台打印，不影响 URL 抓取（启动横幅里的 URL 仍能被识别）
LOG_FILTERS = {
    "CYUI": [
        # Werkzeug / Flask 访问日志：
        #   127.0.0.1 - - [01/Jan/2024 12:00:00] "GET /api/xxx HTTP/1.1" 200 -
        #   ::1 - - [..] "POST /run HTTP/1.1" 500 -
        re.compile(
            r'^\s*(?:[0-9a-fA-F:.]+|[\w.-]+)\s+-\s+-\s+\[[^\]]+\]\s+'
            r'"[A-Z]+ \S+ HTTP/[\d.]+"\s+\d{3}'
        ),
        # 如果你也想隐藏“* Detected change in ...”“* Restarting with stat ...”
        # 这类 reloader 日志，取消下面两行的注释：
        # re.compile(r'^\s*\*\s+Detected change in '),
        # re.compile(r'^\s*\*\s+Restarting with '),
    ],
    # "ComfyUI": [],   # 需要时也可以给 ComfyUI 加过滤
}
# ==============================================================

_opened      = set()
_lock        = threading.Lock()
_comfy_ready = threading.Event()
_comfy_url   = [None]

# ===================== Windows Job Object =====================
_job       = None
_kernel32  = None
_procs     = []
_procs_lock = threading.Lock()


def _init_job():
    global _kernel32
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        JobObjectExtendedLimitInformation = 9
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info)
        ):
            kernel32.CloseHandle(job)
            return None
        _kernel32 = kernel32
        return job
    except Exception as e:
        print(f"[启动器] 初始化 Job Object 失败: {e}")
        return None


def _assign_to_job(job, pid):
    if not job or not _kernel32:
        return False
    try:
        PROCESS_ALL_ACCESS = 0x1F0FFF
        h = _kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
        if not h:
            return False
        try:
            return bool(_kernel32.AssignProcessToJobObject(job, h))
        finally:
            _kernel32.CloseHandle(h)
    except Exception as e:
        print(f"[启动器] 把 pid={pid} 加入 Job 失败: {e}")
        return False
# ==============================================================


def _normalize(url: str) -> str:
    return url.replace("0.0.0.0", "127.0.0.1")


def open_url(url: str):
    url = _normalize(url)
    with _lock:
        if url in _opened:
            return
        _opened.add(url)
    print(f"\n[启动器] >>> 打开浏览器: {url}\n")
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f"[启动器] 打开浏览器失败: {e}")


def _tcp_ready(url: str, timeout: float) -> bool:
    p = urlparse(url)
    host = p.hostname or "127.0.0.1"
    port = p.port or (443 if p.scheme == "https" else 80)
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(1)
            if s.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.2)
    return False


def _handle_url(tag: str, url: str):
    if tag == "ComfyUI":
        if not _comfy_ready.is_set():
            _comfy_url[0] = _normalize(url)
            _comfy_ready.set()
    else:
        open_url(url)


def stream(proc, tag):
    filters = LOG_FILTERS.get(tag, ())
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            # 被过滤的行：不打印，但依然尝试抓 URL（可能包含在横幅里）
            if not any(f.search(line) for f in filters):
                print(f"[{tag}] {line}")
            for m in URL_RE.finditer(line):
                _handle_url(tag, m.group(0))
    except Exception as e:
        print(f"[{tag}] 读取输出异常: {e}")
    finally:
        proc.wait()


def launch(tag, cwd, script):
    args = [PYTHON, "-u", script]
    print(f"[启动器] 启动 {tag}: {' '.join(args)}")
    print(f"[启动器] 工作目录: {cwd}")

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"]  = "1"

    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0

    p = subprocess.Popen(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
        creationflags=flags,
    )
    with _procs_lock:
        _procs.append(p)
    if _job:
        _assign_to_job(_job, p.pid)

    threading.Thread(target=stream, args=(p, tag), daemon=True).start()
    return p


def kill_tree(p):
    if p is None or p.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(p.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            p.terminate()
    except Exception as e:
        print(f"[启动器] 结束进程失败 pid={p.pid}: {e}")


def _cleanup_all():
    with _procs_lock:
        procs = list(_procs)
    for p in procs:
        try:
            kill_tree(p)
        except Exception:
            pass


def wait_comfy_ready(comfy_proc) -> bool:
    print(f"[启动器] 等待 ComfyUI 端口就绪（最长 {COMFY_READY_TIMEOUT}s）...")
    deadline = time.time() + COMFY_READY_TIMEOUT
    while time.time() < deadline:
        if _comfy_ready.is_set():
            print(f"[启动器] ComfyUI 日志已给出地址: {_comfy_url[0]}")
            return True
        if comfy_proc.poll() is not None:
            print("[启动器] ComfyUI 进程已退出，跳过等待")
            return False
        time.sleep(0.2)
    print("[启动器] 等待 ComfyUI 超时")
    return False


def _on_sigint(signum, frame):
    raise KeyboardInterrupt


def main():
    global _job

    checks = [
        (PYTHON,                               "Python 解释器"),
        (os.path.join(COMFY_DIR, COMFY_ENTRY), "ComfyUI 入口 main.py"),
        (os.path.join(CYUI_DIR,  CYUI_ENTRY),  "CYUI 入口 run.py"),
    ]
    for path, desc in checks:
        if not os.path.isfile(path):
            sys.exit(f"[启动器] 找不到{desc}: {path}")

    _job = _init_job()
    if _job:
        print("[启动器] 已启用 Windows Job Object")
    else:
        print("[启动器] 警告: Job Object 启用失败，关闭窗口时子进程可能残留")

    atexit.register(_cleanup_all)
    if os.name == "nt":
        signal.signal(signal.SIGINT, _on_sigint)
        try:
            signal.signal(signal.SIGBREAK, _on_sigint)
        except Exception:
            pass

    comfy_proc = launch("ComfyUI", COMFY_DIR, COMFY_ENTRY)

    if wait_comfy_ready(comfy_proc):
        _tcp_ready(_comfy_url[0], COMFY_TCP_TIMEOUT)
        open_url(_comfy_url[0])
    else:
        for u in FALLBACK_URLS:
            open_url(u)

    print("[启动器] 现在启动 CYUI ...")
    time.sleep(0.5)
    launch("CYUI", CYUI_DIR, CYUI_ENTRY)

    with _procs_lock:
        procs_snapshot = list(_procs)
    try:
        while any(p.poll() is None for p in procs_snapshot):
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[启动器] 收到 Ctrl+C，正在关闭所有子进程...")
    finally:
        _cleanup_all()
        if _job:
            try:
                _kernel32.CloseHandle(_job)
            except Exception:
                pass
            _job = None
        print("[启动器] 已退出。")


if __name__ == "__main__":
    main()