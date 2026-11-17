# -*- coding: utf-8 -*-
"""filelog —— 服务日志落盘（独立小模块，零依赖，避免循环导入）。

为什么存在：comfy.log 的内存环形日志在服务重启后丢失，store 的事件只 print 到
控制台——数据类事故（图库丢失、拒写保护触发）事后无据可查，追凶全靠猜。

设计：
  * 日志写到 <DATA_DIR>/logs/cyui-YYYYMMDD.log，按天一个文件
  * 超过 LOG_MAX_BYTES 自动轮换为 .old（只留一代，防磁盘膨胀）
  * 任何写失败都静默吞掉（日志永远不能影响主流程）
  * 线程安全（写锁）

用法：
    from .filelog import write
    write("图库对账：恢复 3 张", "INFO")
"""

import os
import threading
import time

from . import DATA_DIR

LOG_DIR = os.path.join(DATA_DIR, "logs")
LOG_MAX_BYTES = 5 * 1024 * 1024          # 单文件上限 5MB，超出轮换为 .old

_lock = threading.Lock()


def write(msg, level="INFO"):
    """追加一条日志到当日文件。绝不抛异常。"""
    try:
        line = "[%s] [%s] %s" % (
            time.strftime("%Y-%m-%d %H:%M:%S"), level, str(msg).rstrip())
        with _lock:
            os.makedirs(LOG_DIR, exist_ok=True)
            path = os.path.join(LOG_DIR, "cyui-%s.log" % time.strftime("%Y%m%d"))
            if os.path.exists(path) and os.path.getsize(path) > LOG_MAX_BYTES:
                old = path[:-4] + ".old.log"
                if os.path.exists(old):
                    os.remove(old)
                os.replace(path, old)
            with open(path, "a", encoding="utf-8", errors="replace") as f:
                f.write(line + "\n")
    except Exception:
        pass
