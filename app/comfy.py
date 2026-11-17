# -*- coding: utf-8 -*-
"""ComfyUI HTTP / WebSocket 客户端

要点（本机环境）：
- 系统代理存在，本地请求一律 trust_env=False，否则会 502。
- ComfyUI 服务实际由 C:\\ComfyUI\\ComfyUI\\main.py 启动，8188 端口。
- 进度通过 /ws 推送（失败时自动降级为 history 轮询，不影响出图）。
"""
import json
import os
import threading
import time
import uuid
from collections import deque

import requests

from . import config

CLIENT_ID = "cyui_" + uuid.uuid4().hex[:8]

_SESSION = requests.Session()
_SESSION.trust_env = False  # 关键：绕过系统代理
_SESSION.headers.update({"User-Agent": "CYUI/1.0"})

LOG = deque(maxlen=400)
LOG_LOCK = threading.Lock()
JOBS = {}
JOBS_LOCK = threading.Lock()
_CATALOG = {"ts": 0, "data": None}
_WS_STARTED = False
_WS_RELOAD = threading.Event()
_WS_BASE = {"value": None}


def base():
    """当前 ComfyUI 服务地址（可在设置页改，运行中即时生效）"""
    return config.get("comfy_base", "http://127.0.0.1:8188").rstrip("/")


def notify_base_changed():
    """地址被用户改掉：清空模型缓存，并让进度通道断开重连到新地址"""
    _CATALOG["data"] = None
    _CATALOG["ts"] = 0
    _WS_RELOAD.set()
    log("ComfyUI 地址已更新为 %s，进度通道将重连" % base(), "WARN")


_LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1", "0.0.0.0")
_INPUT_DIR = {"ts": 0.0, "path": "", "cfg_dir": "", "cfg_ok": False}


def local_base():
    """ComfyUI 是否就在本机。远程地址（局域网另一台机器）读不到本地目录。"""
    from urllib.parse import urlparse
    try:
        return (urlparse(base()).hostname or "").lower() in _LOCAL_HOSTS
    except Exception:
        return False


def reset_input_dir():
    """用户在设置里改了本地目录：清掉探测缓存，下次重新找"""
    _INPUT_DIR["ts"] = 0.0
    _INPUT_DIR["path"] = ""


def input_dir_status():
    """当前 input 目录的解析情况，供设置页/接口做反馈。

    cfg_ok 说明用户手填的目录本身是否可用——配置错了不能默默降级到自动探测，
    否则用户填了 Z:\\no-such-dir 还看到「当前使用 G:\\...」，会以为保存没生效。
    """
    input_dir()
    return {
        "dir": _INPUT_DIR["path"],
        "cfg_dir": _INPUT_DIR.get("cfg_dir") or "",
        "cfg_ok": bool(_INPUT_DIR.get("cfg_ok")),
        "local": local_base(),
    }


def _as_input_dir(p):
    """把用户填的路径收敛成 input 目录：既可填 ComfyUI 根目录，也可直接填 input。"""
    p = str(p or "").strip().strip('"').strip("'").rstrip("/\\")
    if not p:
        return ""
    if os.path.basename(p).lower() == "input" and os.path.isdir(p):
        return p
    q = os.path.join(p, "input")
    return q if os.path.isdir(q) else ""


def input_dir():
    """ComfyUI input 目录的绝对路径，探测不到返回空串。

    「历史输入图片」只能靠读目录：ComfyUI 没有列出 input 文件的 HTTP 接口
    （/internal/folder_paths 并不返回 input/output），/view 也要求先知道文件名。
    所以本机 ComfyUI 走文件系统；远程地址会返回空串，前端退回「本工具上传记录」。
    """
    now = time.time()
    if now - _INPUT_DIR["ts"] < 60:
        return _INPUT_DIR["path"]

    cands = []
    cfg_dir = config.get("comfy_dir")
    if cfg_dir:
        cands.append(cfg_dir)
    env = os.environ.get("CYUI_COMFY_DIR")
    if env:
        cands.append(env)
    if local_base():
        root_self = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cands += [
            os.path.join(os.path.dirname(root_self), "ComfyUI"),
            r"G:\wwdm-cyui\ComfyUI",
            r"C:\ComfyUI\ComfyUI",
            r"C:\ComfyUI",
            r"D:\ComfyUI",
        ]

    found = ""
    for c in cands:
        found = _as_input_dir(c)
        if found:
            break

    _INPUT_DIR["path"] = found
    _INPUT_DIR["ts"] = now
    _INPUT_DIR["cfg_dir"] = str(cfg_dir or "")
    # 用户手填的目录单独校验：无效时不静默掩盖，让设置页能明确提示
    _INPUT_DIR["cfg_ok"] = bool(_as_input_dir(cfg_dir)) if cfg_dir else False
    return found



def log(msg, level="INFO"):
    line = "[%s] [%s] %s" % (time.strftime("%H:%M:%S"), level, msg)
    print(line, flush=True)
    with LOG_LOCK:
        LOG.append(line)
    try:
        from .filelog import write as _flog    # 服务日志落盘（重启后仍可追查）
        _flog(msg, level)
    except Exception:
        pass


def logs(limit=200):
    with LOG_LOCK:
        return list(LOG)[-limit:]


class ComfyError(Exception):
    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


def _url(path):
    return base() + path


def _check(r):
    if r.status_code >= 400:
        try:
            body = r.json()
        except Exception:
            body = r.text[:800]
        raise ComfyError("ComfyUI %s %s" % (r.status_code, r.request.path_url), body)
    return r


def _json_or_error(r):
    """ComfyUI 返回非 JSON（正在重启 / 反代截断 / 空响应）时给出可读错误，
    而不是把 json.decoder 的「Expecting value」直接抛给用户。"""
    try:
        return r.json()
    except ValueError as e:
        snippet = (r.text or "")[:160].replace("\n", " ")
        raise ComfyError(
            "ComfyUI 返回了无法解析的响应（HTTP %d）%s：%s"
            % (r.status_code, "，可能正在重启或加载模型" if not snippet else "：" + snippet, str(e)[:60]))


def get_json(path, params=None, timeout=25):
    return _json_or_error(_check(_SESSION.get(_url(path), params=params, timeout=timeout)))


def post_json(path, payload, timeout=30):
    return _json_or_error(_check(_SESSION.post(_url(path), json=payload, timeout=timeout)))


def get_bytes(path, params=None, timeout=90):
    return _check(_SESSION.get(_url(path), params=params, timeout=timeout)).content


def system_stats():
    return get_json("/system_stats", timeout=8)


def object_info(name=None):
    path = "/object_info" + ("/" + name if name else "")
    timeout = 60 if name is None else 20
    return get_json(path, timeout=timeout)


_ALLOWED_IMAGE_KINDS = ("input", "output", "temp")


def safe_filename(name):
    """把用户给的文件名收敛成单个安全文件名；非法时返回空串。
    防止 ../ 路径遍历、绝对路径、NUL / 控制字符进入 /view 与本地 results 目录。"""
    raw = str(name or "").replace("\\", "/")
    if ".." in raw.split("/"):          # 显式拒绝遍历，不做 basename 兜底后继续请求
        return ""
    s = os.path.basename(raw)
    if not s or s in (".", "..") or "\x00" in s or any(ord(c) < 32 for c in s):
        return ""
    return s


def safe_subfolder(sub):
    """合法子目录返回字符串（可为空）；含 .. / 绝对路径 / 控制字符返回 None 表示非法。"""
    s = str(sub or "").replace("\\", "/").strip()
    if not s:
        return ""
    if s.startswith("/") or any(p in ("", ".", "..") for p in s.split("/")):
        return None
    if "\x00" in s or any(ord(c) < 32 for c in s):
        return None
    return s.strip("/")


def safe_kind(kind):
    k = str(kind or "output").lower()
    return k if k in _ALLOWED_IMAGE_KINDS else None


def upload_image(file_bytes, filename, subfolder=""):
    """上传图片到 ComfyUI input 目录，返回 LoadImage 可用的 name"""
    mime = "image/png"
    low = filename.lower()
    if low.endswith((".jpg", ".jpeg")):
        mime = "image/jpeg"
    elif low.endswith(".webp"):
        mime = "image/webp"
    data = {"overwrite": "true", "type": "input"}
    if subfolder:
        data["subfolder"] = subfolder
    r = _check(
        _SESSION.post(
            _url("/upload/image"),
            files={"image": (filename, file_bytes, mime)},
            data=data,
            timeout=90,
        )
    )
    info = r.json()
    name = info.get("name") or filename
    sub = subfolder or info.get("subfolder") or ""
    return (sub + "/" + name) if sub else name


def _check_lora_names(prompt):
    """提交前校验 workflow 里所有 LoRA 名在 ComfyUI 当前清单中存在。

    为什么放在这里（所有路径的必经之地）：
      AI 助手路径会"编"出听起来合理的 LoRA 名（用户点名了角色但本地没装），
      手动路径也可能因为界面残留了旧参数而带上失效 LoRA。原来要等 ComfyUI
      校验时才报 "Value not in list"，整个任务失败。这里提前拦下，错误信息
      带上当前可用清单——AI 工具循环会把错误回灌给模型，让它重新查清单纠正。
    """
    names = []
    for node in (prompt or {}).values():
        if node.get("class_type") == "LoraLoaderModelOnly":
            n = str((node.get("inputs") or {}).get("lora_name") or "").strip()
            if n:
                names.append(n)
    if not names:
        return
    try:
        # 直接读 object_info 的实时清单（和 ComfyUI 校验用的是同一份数据源），
        # 不用 catalog() 的 2 分钟缓存 —— 避免刚装了 LoRA 还没刷新时被误拦。
        info = object_info("LoraLoaderModelOnly") or {}
        node_info = (info.get("LoraLoaderModelOnly") or {}).get("input") or {}
        available = [str(x) for x in ((node_info.get("required") or {}).get("lora_name") or [])[0]]
    except Exception:
        available = []                  # 清单拿不到就不误拦，让 ComfyUI 自己判
    if not available:
        # 退路：object_info 读不到时用 catalog 缓存（总比不校验强）
        try:
            available = [str(x) for x in ((catalog() or {}).get("loras") or [])]
        except Exception:
            return
    if not available:
        raise ComfyError(
            "当前 ComfyUI 的 LoRA 清单为空，但工作流要用 LoRA：%s。"
            "请先在 ComfyUI-Manager 安装对应 LoRA 并点「刷新模型清单」。" % "、".join(names))
    avail = set(available)
    missing = [n for n in names if n not in avail]
    if missing:
        hint = "、".join(available[:12]) + ("…" if len(available) > 12 else "")
        raise ComfyError(
            "LoRA 不存在：%s。当前可用的有：%s。"
            "请检查模型是否已安装 / 点「刷新模型清单」后重试。" % ("、".join(missing), hint))


def queue_prompt(prompt, client_id=None):
    _check_lora_names(prompt)
    payload = {"prompt": prompt, "client_id": client_id or CLIENT_ID}
    try:
        return post_json("/prompt", payload, timeout=40)
    except ComfyError as e:
        d = e.detail
        if isinstance(d, dict):
            err = d.get("error", {})
            ne = d.get("node_errors", {})
            msg = err.get("message", str(e))
            raise ComfyError(msg, {"error": err, "node_errors": ne})
        raise


def history(prompt_id):
    return get_json("/history/" + prompt_id, timeout=15)


def view(filename, subfolder="", kind="output"):
    # 最后一道防线：这里的值最终会发给 ComfyUI /view，拒绝遍历与非法 type
    f = str(filename or "")
    sub = safe_subfolder(subfolder)
    k = safe_kind(kind)
    if not f or "\x00" in f or ".." in f.replace("\\", "/").split("/") or sub is None or k is None:
        raise ComfyError("图片参数不合法")
    params = {"filename": f, "type": k}
    if sub:
        params["subfolder"] = sub
    return get_bytes("/view", params=params)


def queue_state():
    return get_json("/queue", timeout=10)


def interrupt():
    return post_json("/interrupt", {}, timeout=10)


def free_models():
    """卸载 ComfyUI 里缓存的模型并清空显存（POST /free）。

    为什么需要：ComfyUI 默认「智能内存管理」会把加载过的模型留在显存里，
    直到下一个任务要空间才换出。本地反推 / 润色跑的是 Qwen3-VL 4B（~5G），
    跑完不释放的话，紧接着的生图任务（UNET+CLIP ~15G）就得先把 4B 挤走，
    在 8G 显存的机器上这一挤一装非常慢。

    两个开关都要给：
      unload_models → 从显存卸载所有模型
      free_memory   → 让 ComfyUI 回收空闲显存块（torch.cuda.empty_cache）
    """
    # /free 端点成功时返回空 body（web.Response(status=200)），不能用 post_json 解析 JSON，
    # 只用 _check 校验 HTTP 状态码即可。
    _check(_SESSION.post(_url("/free"),
                         json={"unload_models": True, "free_memory": True}, timeout=10))
    return True


def delete_queue(ids):
    return post_json("/queue", {"delete": ids}, timeout=10)


def catalog(force=False):
    """模型 / LoRA / 采样器清单，带 2 分钟缓存

    GGUF 支持：装了 ComfyUI-GGUF 后会有 UnetLoaderGGUF / CLIPLoaderGGUF，
    这两个节点的可选项就是 models/unet、models/clip 下的 *.gguf 文件。
    """
    now = time.time()
    if not force and _CATALOG["data"] and now - _CATALOG["ts"] < 120:
        return _CATALOG["data"]
    info = object_info()

    def opts(node, key):
        """兼容两种 COMBO 写法：旧版 [[...], {...}]，新版 ["COMBO", {"options": [...]}]"""
        try:
            inp = info[node]["input"]
            v = inp.get("required", {}).get(key)
            if v is None:
                v = inp.get("optional", {}).get(key)
        except Exception:
            return []
        if isinstance(v, (list, tuple)) and v:
            first = v[0]
            if isinstance(first, (list, tuple)):
                return list(first)
            if len(v) > 1 and isinstance(v[1], dict) and isinstance(v[1].get("options"), list):
                return list(v[1]["options"])
        return []

    gguf_unet = "UnetLoaderGGUF" in info
    gguf_clip = "CLIPLoaderGGUF" in info
    loras = opts("LoraLoaderModelOnly", "lora_name")
    from . import workflows as _wf
    viggle_lora = _wf.find_viggle_lora(loras)
    data = {
        "unets": opts("UNETLoader", "unet_name"),
        "clips": opts("CLIPLoader", "clip_name"),
        "clip_types": opts("CLIPLoader", "type"),
        "vaes": opts("VAELoader", "vae_name"),
        "loras": loras,
        "samplers": opts("KSampler", "sampler_name"),
        "schedulers": opts("KSampler", "scheduler"),
        # GGUF 底模（可选插件）
        "unets_gguf": opts("UnetLoaderGGUF", "unet_name") if gguf_unet else [],
        "clips_gguf": opts("CLIPLoaderGGUF", "clip_name") if gguf_clip else [],
        "gguf": {"unet": gguf_unet, "clip": gguf_clip},
        # 加速方案：只按 LoRA 清单里的文件名判断是否可用，不读文件、不做格式转换
        # （ComfyUI 的 QwenImage lora 映射已原生接受 diffusers 键名与 gate_layer/proj 分半）
        "accel": {
            "viggle": {
                "ready": bool(viggle_lora),
                "lora": viggle_lora,
                "filename": _wf.VIGGLE_FILE,
                "repo": _wf.VIGGLE_REPO,
                "download": _wf.VIGGLE_DOWNLOAD,
                "steps": _wf.VIGGLE_STEPS,
            },
        },
        # 本地文本工作流（提示词润色 / 反推）
        "llm": {"textgen": "TextGenerateV2" in info, "preview": "PreviewAny" in info},
        # 三种采样方案的关系（步数 / CFG / 底模要求），参数选项卡照着渲染
        "samplings": _wf.SAMPLINGS,
        # 高清放大（SeedVR2 + TTP 分块，可选插件）
        "seedvr2": {
            "ready": ("SeedVR2LoadDiTModel" in info and "SeedVR2LoadVAEModel" in info
                      and "SeedVR2VideoUpscaler" in info and "TTP_Image_Tile_Batch" in info),
            "dit": opts("SeedVR2LoadDiTModel", "model"),
            "vae": opts("SeedVR2LoadVAEModel", "model"),
            "attention": opts("SeedVR2LoadDiTModel", "attention_mode"),
        },
        # 插件（自定义节点）检测：逐个类名对照 /object_info
        "plugins": plugin_status(info),
        "max_ref_images": 16,
    }
    _CATALOG["data"] = data
    _CATALOG["ts"] = now
    return data


def plugin_status(info):
    """对照 REQUIRED_PLUGINS 检测每个插件的节点是否已在 ComfyUI 注册"""
    from . import workflows
    out = []
    for p in workflows.REQUIRED_PLUGINS:
        missing = [n for n in p["nodes"] if n not in info]
        out.append({"key": p["key"], "ok": not missing, "missing": missing})
    return out


def cached_catalog():
    """只取缓存，不发请求；用于生成前的轻量校验"""
    return _CATALOG["data"] or {}


def track(prompt_id, meta):
    with JOBS_LOCK:
        JOBS[prompt_id] = {
            "prompt_id": prompt_id,
            "status": "queued",
            "progress": 0,
            "step": 0,
            "total": 0,
            "node": None,
            "error": None,
            "finalized": False,
            "started_at": time.time(),
            "meta": meta,
        }


def job(prompt_id):
    with JOBS_LOCK:
        j = JOBS.get(prompt_id)
        return dict(j) if j else None


def patch_job(prompt_id, **kw):
    with JOBS_LOCK:
        j = JOBS.get(prompt_id)
        if j:
            j.update(kw)


def _ws_worker():
    """订阅 ComfyUI 进度事件；断线自动重连，服务地址变更后立即重连到新地址"""
    import websocket

    kwargs = {"timeout": 8}
    try:
        import inspect
        sig = inspect.signature(websocket.create_connection).parameters
        if "http_proxy_host" in sig:
            kwargs["http_proxy_host"] = None
        if "http_no_proxy" in sig:
            kwargs["http_no_proxy"] = ["127.0.0.1", "localhost"]
    except Exception:
        pass

    while True:
        target = base()
        url = target.replace("http://", "ws://").replace("https://", "wss://")
        url += "/ws?clientId=" + CLIENT_ID
        _WS_BASE["value"] = target
        ws = None
        try:
            ws = websocket.create_connection(url, **kwargs)
            _WS_RELOAD.clear()
            log("已连接 ComfyUI 进度通道 · %s" % target, "OK")
            while True:
                try:
                    raw = ws.recv()
                except Exception as e:
                    low = str(e).lower()
                    # websocket-client 超时信息为 "Connection timed out"，属于正常空闲心跳
                    if "timeout" in low or "timed out" in low or e.__class__.__name__ == "WebSocketTimeoutException":
                        if _WS_RELOAD.is_set():
                            raise Exception("服务地址已变更")
                        continue
                    raise
                if _WS_RELOAD.is_set():
                    raise Exception("服务地址已变更")
                if not raw or isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                t = msg.get("type")
                d = msg.get("data") or {}
                pid = d.get("prompt_id")
                if not pid:
                    continue
                if t == "progress":
                    patch_job(
                        pid,
                        status="running",
                        step=d.get("value", 0),
                        total=d.get("max", 0),
                        progress=round(100.0 * d.get("value", 0) / max(1, d.get("max", 1)), 1),
                        node=d.get("node"),
                    )
                elif t == "executing":
                    node = d.get("node")
                    if node is None:
                        patch_job(pid, status="finishing", progress=100)
                    else:
                        patch_job(pid, status="running", node=node)
                elif t == "execution_error":
                    ex = d.get("exception_message") or d.get("exception_type") or "执行失败"
                    patch_job(pid, status="error", error=str(ex))
                    log("生成失败 %s: %s" % (pid[:8], ex), "ERROR")
                elif t == "execution_cached":
                    pass
        except Exception as e:
            log("进度通道断开（%s），2 秒后重连" % str(e)[:100], "WARN")
            time.sleep(2)
        finally:
            try:
                if ws:
                    ws.close()
            except Exception:
                pass


def init_app(app):
    global _WS_STARTED
    if _WS_STARTED:
        return
    _WS_STARTED = True
    t = threading.Thread(target=_ws_worker, name="cyui-ws", daemon=True)
    t.start()
