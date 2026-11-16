# -*- coding: utf-8 -*-
"""用户配置（data/config.json）

目前只存 ComfyUI 服务地址：用户可在「设置」页自行填写，支持局域网另一台机器。
地址改动后会通知 comfy 模块清空模型缓存并重连进度通道。
"""
import json
import os
import threading
from urllib.parse import urlparse

from . import DATA_DIR

_FILE = os.path.join(DATA_DIR, "config.json")
_lock = threading.RLock()
_state = None

_DEFAULT = {
    "comfy_base": (os.environ.get("CYUI_COMFY") or "http://127.0.0.1:8188").rstrip("/"),
}


def normalize_base(url):
    """把用户输入的地址收敛成 http(s)://host:port 形式"""
    u = (url or "").strip().strip('"').strip("'")
    if not u:
        return ""
    if "://" not in u:
        u = "http://" + u
    # 只接受 http(s)：避免 file:// / gopher:// 之类被当成 ComfyUI 地址发起请求
    if urlparse(u).scheme not in ("http", "https"):
        return ""
    u = u.rstrip("/")
    # 常见误填：把接口路径一起粘进来
    for tail in ("/api", "/prompt", "/object_info", "/system_stats"):
        if u.lower().endswith(tail):
            u = u[: -len(tail)].rstrip("/")
    return u


def load():
    global _state
    with _lock:
        if _state is None:
            data = {}
            if os.path.exists(_FILE):
                try:
                    with open(_FILE, "r", encoding="utf-8") as f:
                        data = json.load(f) or {}
                except Exception as e:
                    print("[config] 读取配置失败，使用默认值: %s" % e, flush=True)
            _state = dict(_DEFAULT)
            if isinstance(data.get("comfy_base"), str) and data["comfy_base"].strip():
                _state["comfy_base"] = normalize_base(data["comfy_base"])
            for k, v in data.items():
                if k == "comfy_base":
                    continue
                # llm 这类结构化配置也要能读回来（dict / list）
                if isinstance(v, (str, int, float, bool, dict, list)):
                    _state[k] = v
        return dict(_state)


def get(key, default=None):
    return load().get(key, default)


def _save():
    tmp = _FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _FILE)


def set_many(patch):
    """写入配置并返回最新值；地址变化会触发 comfy 重连"""
    global _state
    old_base = None
    with _lock:
        load()
        old_base = _state.get("comfy_base")
        for k, v in (patch or {}).items():
            if k == "comfy_base":
                v = normalize_base(v)
                if not v:
                    continue
            _state[k] = v
        _save()
        new_base = _state.get("comfy_base")
    if new_base != old_base:
        try:
            from . import comfy
            comfy.notify_base_changed()
        except Exception:
            pass
    return dict(_state)
