"""极简 JSON 持久化层：原子写入 + 线程锁，避免并发任务把文件写坏。"""
import json
import shutil
import os
import threading
from copy import deepcopy
from pathlib import Path


class JsonStore:
    def __init__(self, path: Path, default: dict):
        self.path = Path(path)
        self.default = default
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.write(deepcopy(default))

    def read(self) -> dict:
        with self._lock:
            try:
                with self.path.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                data = deepcopy(self.default)
            for key, value in self.default.items():
                data.setdefault(key, deepcopy(value))
            return data

    def write(self, data: dict) -> None:
        with self._lock:
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            # 写之前留一份上一版，误删/写坏时还能捞回来
            if self.path.exists():
                backup = self.path.with_suffix(self.path.suffix + ".bak")
                try:
                    shutil.copy2(self.path, backup)
                except OSError:
                    pass
            os.replace(tmp, self.path)

    def update(self, func) -> dict:
        """func(data) 原地修改；返回修改后的数据。"""
        with self._lock:
            data = self.read()
            func(data)
            self.write(data)
            return data
