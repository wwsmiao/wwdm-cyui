"""系统状态采样：CPU / 内存 / NVIDIA GPU / ComfyUI 连通性。

ComfyUI 是远程实例时，显存与内存改读 ComfyUI 的 /system_stats（本机采样只做补充）。
"""
import socket
import subprocess
import time
from urllib.parse import urlparse

import psutil

from core.comfy import ComfyError

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class SystemMonitor:
    def __init__(self, comfy):
        self.comfy = comfy
        self._gpu_cache = []
        self._comfy_cache = {"online": False}
        self._gpu_at = 0.0
        self._comfy_at = 0.0
        self._stats_cache = None
        self._stats_at = 0.0

    def is_remote(self) -> bool:
        """ComfyUI 是否不在本机：地址不是回环地址也不是本机网卡 IP 即视为远程。"""
        host = (urlparse(self.comfy.base).hostname or "").lower()
        if host in ("127.0.0.1", "localhost", "::1", ""):
            return False
        try:
            ips = {socket.gethostbyname(socket.gethostname())}
            for info in socket.getaddrinfo(socket.gethostname(), None):
                ips.add(info[4][0])
        except (OSError, socket.gaierror):
            ips = set()
        return host not in {str(ip).lower() for ip in ips if ip}

    def sample(self) -> dict:
        memory = psutil.virtual_memory()
        local_memory = {
            "percent": round(memory.percent, 1),
            "used_gb": round(memory.used / 1024 ** 3, 1),
            "total_gb": round(memory.total / 1024 ** 3, 1),
        }
        gpu = self._gpu()
        remote = self.is_remote()
        memory_dict = local_memory
        if remote:
            # 远程实例：显存读 ComfyUI 的 /system_stats（字节/MB 自适应），内存仍用本机读数
            stats = self._comfy_stats() or {}
            vram_total = self._normalize_vram(stats.get("vram_total"))
            vram_used = self._normalize_vram(stats.get("vram_total")) - \
                self._normalize_vram(stats.get("vram_free"))
            gpu = [{
                "name": stats.get("name") or "远程 ComfyUI",
                "util": None,
                "vram_used": max(0, vram_used),
                "vram_total": vram_total,
                "temp": 0,
                "remote": True,
            }] if vram_total else []
        return {
            "cpu": round(psutil.cpu_percent(interval=None), 1),
            "memory": memory_dict,
            "gpu": gpu,
            "comfy": self._comfy(),
            "remote": remote,
        }

    @staticmethod
    def _normalize_vram(value) -> int:
        """ComfyUI 的 vram 数值可能是字节或 MB，按量级归一到 MB。"""
        v = int(value or 0)
        if v > 100_000_000:
            return v // (1024 * 1024)
        return v

    def _comfy_stats(self) -> dict | None:
        now = time.time()
        if now - self._stats_at < 3:
            return self._stats_cache
        self._stats_at = now
        self._stats_cache = None
        try:
            data = self.comfy.request("GET", "/system_stats", timeout=8).json()
            device = (data.get("devices") or [{}])[0]
            system = data.get("system") or {}
            self._stats_cache = {
                "name": device.get("name") or "",
                "vram_total": device.get("vram_total") or 0,
                "vram_free": device.get("vram_free") or 0,
                "ram_total": system.get("ram_total") or 0,
                "ram_free": system.get("ram_free") or 0,
            }
        except (ComfyError, ValueError):
            self._stats_cache = None
        return self._stats_cache

    def _gpu(self) -> list:
        now = time.time()
        if now - self._gpu_at < 2:
            return self._gpu_cache
        self._gpu_at = now
        try:
            result = subprocess.run(
                ["nvidia-smi",
                 "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3,
                creationflags=NO_WINDOW,
            )
            gpus = []
            for line in result.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 4:
                    continue
                gpus.append({
                    "name": parts[0],
                    "util": int(float(parts[1] or 0)),
                    "vram_used": int(float(parts[2] or 0)),
                    "vram_total": int(float(parts[3] or 0)),
                    "temp": int(float(parts[4])) if len(parts) > 4 and parts[4] else 0,
                })
            self._gpu_cache = gpus
        except (OSError, ValueError, subprocess.SubprocessError):
            self._gpu_cache = []
        return self._gpu_cache

    def _comfy(self) -> dict:
        now = time.time()
        if now - self._comfy_at < 3:
            return self._comfy_cache
        self._comfy_at = now
        try:
            status = self.comfy.status()
            self._comfy_cache = {
                "online": True,
                "running": status["running"],
                "pending": status["pending"],
                "device": (status["devices"] or [{}])[0].get("name", ""),
            }
        except ComfyError:
            self._comfy_cache = {"online": False, "running": 0, "pending": 0}
        return self._comfy_cache
