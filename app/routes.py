# -*- coding: utf-8 -*-
"""CYUI HTTP API"""
import io
import json
import os
import re
import threading
import time
import traceback
import uuid
import hashlib

from urllib.parse import quote

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory
from PIL import Image, ImageOps

from . import DATA_DIR, RESULTS_DIR, assistant, comfy, config, llm, store, upscale, version, workflows
from . import polish as polish_svc

bp = Blueprint("cyui", __name__)


def ok(**kw):
    d = {"ok": True}
    d.update(kw)
    return jsonify(d)


def fail(msg, detail=None, code=200):
    d = {"ok": False, "error": msg}
    if detail is not None:
        d["detail"] = detail
    return jsonify(d), code


def pending_job_ids():
    """扫描所有会话里仍为 pending 的任务（页面刷新后前端会据此恢复轮询）"""
    out = []
    for s in store.list_sessions():
        full = store.get_session(s["id"]) or {}
        for m in full.get("messages", []):
            if m.get("role") == "assistant" and m.get("status") == "pending" and m.get("job_id"):
                out.append(m["job_id"])
    return out


def _int_arg(name, default, lo, hi):
    """query 里的整数参数统一 clamp，避免非数字导致 500 / 负数导致异常行为"""
    try:
        v = int(request.args.get(name, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _sanitize_text(s):
    """回给浏览器前脱敏：藏掉本地绝对路径、密钥与内网地址"""
    s = str(s)
    s = re.sub(r"(?i)\b(api[_-]?key|token|authorization|bearer)\s*[:=]\s*\S+", r"\1=[已隐藏]", s)
    s = re.sub(r"[A-Za-z]:\\[^\s'\"<>]+", "[本地路径]", s)
    s = re.sub(r"/(?:Users|home|root)/[^\s'\"<>]+", "[本地路径]", s)
    s = re.sub(r"https?://[^\s'\"<>]+", "[服务地址]", s)
    return s


def _sanitize_error(e):
    return ("%s: %s" % (type(e).__name__, _sanitize_text(e)))[:300]


# ComfyUI 送回来的底层报错常常只有一句英文，这里补一句能照着做的提示
_ERROR_HINTS = (
    ("unknown model architecture",
     "这个 .gguf 缺少架构标识（general.architecture），ComfyUI 无法识别它。"
     "常见于 stable-diffusion.cpp 格式的导出（例如 unsloth 的 Qwen-Image GGUF）。"
     "请换 ComfyUI 兼容的导出，例如 Abiray/Qwen-Image-2.1-GGUF（标准版）或 "
     "m9ter1a/Qwen-Image-2.1-Turbo-GGUF（turbo 版）。"),
    ("not currently supported",
     "当前 ComfyUI-GGUF 版本不支持该文件的张量结构，建议换官方发布的同名 GGUF。"),
    ("out of memory",
     "显存不足：降低输出分辨率，或换更小的量化版本（Q3/Q4）。"),
    ("no such file or directory",
     "文件找不到：模型可能已被移动或改名，点「刷新模型清单」后重新选择。"),
    ("lora key not loaded",
     "LoRA 权重一个键都没匹配上：确认它对应的是同一个底模架构，且不是别的模型的 LoRA。"),
)


def _humanize_error(msg):
    """给 ComfyUI 的原始报错补一条可执行提示（保留原文，便于排查）"""
    s = str(msg or "")
    low = s.lower()
    for k, hint in _ERROR_HINTS:
        if k in low:
            return s + "\n\n提示：" + hint
    return s


def _sanitize_detail(d):
    if isinstance(d, str):
        return _sanitize_text(d)[:800]
    if isinstance(d, dict):
        return {str(k): (_sanitize_text(v)[:500] if isinstance(v, str) else v)
                for k, v in list(d.items())[:20]}
    return None


def _guard(fn):
    try:
        return fn()
    except comfy.ComfyError as e:
        comfy.log("ComfyUI 错误: %s" % e, "ERROR")
        return fail(_sanitize_text(e)[:300], _sanitize_detail(e.detail))
    except Exception as e:
        comfy.log("接口异常: %s" % e, "ERROR")
        traceback.print_exc()
        return fail(_sanitize_error(e))


def _enrich_ref_size(cfg):
    """读首图真实尺寸，交给 workflows.resolve_canvas 决定编码画布。

    以前这里只认 params.resolution（参考图缩放预算，面积口径），于是用户在
    「尺寸」卡片里选的宽高在带参考图的技能里被完全静默忽略——16:9 1K、
    1:1 1K、手填 800×600 三种选择跑出来都是同一个 1184×896。
    现在按 params.size_mode 决策：auto 跟随图1 / fixed 按指定宽高 / native 原图像素。
    """
    p = cfg["params"]
    orig = None
    if cfg["mode"] in ("img2img", "inpaint") and cfg["images"]:
        try:
            raw = comfy.view(cfg["images"][0], "", "input")
            with Image.open(io.BytesIO(raw)) as im:
                # 手机照片带 EXIF 旋转：必须按真实方向取尺寸，否则竖拍图的遮罩会错位
                im = ImageOps.exif_transpose(im)
                orig = im.size
        except Exception as e:
            comfy.log("首图尺寸读取失败: %s" % str(e)[:90], "WARN")

    size, label = workflows.resolve_canvas(cfg["mode"], p, cfg["images"], orig)
    if not size:
        return cfg
    cfg["target_size"] = (int(size[0]), int(size[1]))
    cfg["size_label"] = label
    if orig:
        comfy.log("%s：首图 %d×%d → 编码画布 %d×%d"
                  % (label, orig[0], orig[1], size[0], size[1]), "INFO")
    else:
        comfy.log("%s：编码画布 %d×%d（读不到首图）" % (label, size[0], size[1]), "WARN")
    return cfg



@bp.route("/")
def index():
    return render_template("index.html")


@bp.route("/results/<path:filename>")
def result_file(filename):
    return send_from_directory(RESULTS_DIR, filename)


@bp.route("/api/bootstrap")
def bootstrap():
    def run():
        online = False
        stats = {}
        try:
            stats = comfy.system_stats()
            online = True
        except Exception as e:
            comfy.log("ComfyUI 未连接: %s" % str(e)[:120], "WARN")
        cat = {}
        if online:
            try:
                cat = comfy.catalog()
            except Exception as e:
                comfy.log("模型清单获取失败: %s" % e, "WARN")
        return ok(
            comfy={"online": online, "base": comfy.base(), "stats": stats},
            comfy_base=comfy.base(),
            comfy_dir=config.get("comfy_dir", ""),
            catalog=cat,
            skills=workflows.SKILLS,
            defaults=workflows.DEFAULTS,
            turbo_sigmas=workflows.TURBO_SIGMAS,
            required_models=workflows.REQUIRED_MODELS,
            required_plugins=workflows.REQUIRED_PLUGINS,
            llm=llm.settings(),
            llm_default=llm.default_settings(),
            upscale=upscale.settings(),
            upscale_defaults=upscale.DEFAULTS,
            upscale_targets=upscale.TARGETS,
            assistant_skills=assistant.public_skills(),
            sessions=store.list_sessions(),
            gallery=store.list_gallery(48),
            pending_jobs=pending_job_ids(),
            gallery_count=len(store.list_gallery(400)),
            # 真实数据目录：前端文案动态显示（部署目录随电脑而变，不能写死 D:\...）
            data_dir=DATA_DIR,
            results_dir=RESULTS_DIR,
        )
    return _guard(run)


@bp.route("/api/settings", methods=["GET"])
def settings_get():
    return _guard(lambda: ok(comfy_base=comfy.base(), llm=llm.settings(), upscale=upscale.settings()))


@bp.route("/api/settings", methods=["POST"])
def settings_save():
    """保存 ComfyUI 地址 / 文本工作流 / 放大设置；顺手探测一次地址，返回在线状态"""
    def run():
        data = request.get_json(force=True) or {}
        if "comfy_base" in data:
            new_base = config.normalize_base(data.get("comfy_base") or "")
            if not new_base:
                return fail("请填写有效的 ComfyUI 地址，例如 http://127.0.0.1:8188")
            config.set_many({"comfy_base": new_base})
        if "comfy_dir" in data:
            # 图片选择弹窗要靠本地 input 目录列历史图；远程 ComfyUI 时留空即可
            d = str(data.get("comfy_dir") or "").strip().strip('"').strip("'")
            if d:
                # 粘贴进来的路径常有正反斜杠混写，统一一下再存
                d = os.path.normpath(d)
            config.set_many({"comfy_dir": d})
            comfy.reset_input_dir()
        if isinstance(data.get("llm"), dict):
            llm.save_settings(data["llm"])
        if isinstance(data.get("upscale"), dict):
            upscale.save_settings(data["upscale"])
        online = False
        stats = {}
        try:
            stats = comfy.system_stats()
            online = True
        except Exception as e:
            comfy.log("地址保存后探测失败: %s" % str(e)[:120], "WARN")
        cat = {}
        if online:
            # 只有改地址或还没有缓存时才强制重拉模型清单（object_info 有几 MB）
            if "comfy_base" in data or not comfy.cached_catalog():
                try:
                    cat = comfy.catalog(force=True)
                except Exception as e:
                    comfy.log("模型清单获取失败: %s" % e, "WARN")
            else:
                cat = comfy.cached_catalog()
        return ok(comfy_base=comfy.base(), online=online, stats=stats, catalog=cat,
                  comfy_dir=config.get("comfy_dir", ""),
                  llm=llm.settings(), upscale=upscale.settings())
    return _guard(run)


@bp.route("/api/status")
def status():
    def run():
        online = False
        stats = {}
        try:
            stats = comfy.system_stats()
            online = True
        except Exception:
            pass
        queue = {}
        if online:
            try:
                queue = comfy.queue_state()
            except Exception:
                pass
        return ok(
            online=online, stats=stats, queue=queue, logs=comfy.logs(40),
            base=comfy.base(),
            pending_jobs=pending_job_ids(), gallery_count=len(store.list_gallery(400)),
        )
    return _guard(run)


@bp.route("/api/catalog")
def catalog():
    return _guard(lambda: ok(catalog=comfy.catalog(force=request.args.get("force") == "1")))


UPLOADS_FILE = os.path.join(DATA_DIR, "uploads.json")
_THUMB_DIR = os.path.join(DATA_DIR, ".thumbs")
_UPLOADS_LOCK = threading.RLock()
_INPUTS_CACHE = {"ts": 0.0, "limit": 0, "source": "", "data": None}
INPUT_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")
SOURCE_NAMES = {"input": "历史输入", "result": "我的作品"}


def _load_uploads():
    out = []
    try:
        if os.path.exists(UPLOADS_FILE):
            with open(UPLOADS_FILE, "r", encoding="utf-8") as f:
                out = (json.load(f) or {}).get("items") or []
    except Exception as e:
        comfy.log("读取上传记录失败: %s" % str(e)[:80], "WARN")
    for it in out:
        if not isinstance(it, dict) or not it.get("name"):
            continue
        it.setdefault("url", "/api/image?type=input&filename=" + it["name"])
        it.setdefault("thumb", "/api/thumb?filename=" + it["name"])
        it.setdefault("source", "upload")
    return out


def _record_upload(info):
    """把本工具上传过的图片记一份到 data/uploads.json。

    本机 ComfyUI 会直接扫 input 目录，这份记录是给远程 ComfyUI 兜底的：
    那时读不到本地目录，只能靠「这个工具自己传过什么」来列历史输入。
    """
    try:
        with _UPLOADS_LOCK:
            items = [i for i in _load_uploads() if i.get("name") != info["name"]]
            items.insert(0, {
                "name": info["name"],
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "size": int(info.get("size") or 0),
                "original": info.get("original") or "",
                "mtime": int(time.time()),
                "url": info["url"],
                "thumb": "/api/thumb?filename=" + info["name"],
                "source": "upload",
            })
            tmp = UPLOADS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"items": items[:600]}, f, ensure_ascii=False)
            os.replace(tmp, UPLOADS_FILE)
            _INPUTS_CACHE["data"] = None
    except Exception as e:
        comfy.log("写入上传记录失败: %s" % str(e)[:80], "WARN")


def _image_size(path):
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return (0, 0)


def _scan_inputs(limit):
    """扫 ComfyUI input 目录，按修改时间倒序取最近 limit 张"""
    d = comfy.input_dir()
    if not d:
        return []
    rows = []
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if not e.is_file() or not e.name.lower().endswith(INPUT_EXTS):
                        continue
                    st = e.stat()
                except OSError:
                    continue
                rows.append((st.st_mtime, e.name, st.st_size))
    except Exception as ex:
        comfy.log("读取 input 目录失败: %s" % str(ex)[:90], "WARN")
        return []
    rows.sort(key=lambda r: r[0], reverse=True)
    out = []
    for mt, name, size in rows[:limit]:
        w, h = _image_size(os.path.join(d, name))
        out.append({
            "name": name,
            "url": "/api/image?type=input&filename=" + name,
            "thumb": "/api/thumb?filename=" + name,
            "width": w, "height": h,
            "size": size,
            "mtime": int(mt),
            "source": "input",
        })
    return out


def _scan_results(limit):
    """扫 data/results：本工具生成后落盘的作品，按修改时间倒序。

    生成时会把结果图回灌成 ComfyUI input 里的 cyui_res_<文件名>，所以多数作品
    可以直接当参考图用；回灌失败或 input 里那个文件被清掉的，标 need_convert，
    前端选中时再走一次 /api/assistant/image-to-input 现场转换。
    """
    if not os.path.isdir(RESULTS_DIR):
        return []
    indir = comfy.input_dir()
    rows = []
    try:
        with os.scandir(RESULTS_DIR) as it:
            for e in it:
                try:
                    if not e.is_file() or not e.name.lower().endswith(INPUT_EXTS):
                        continue
                    st = e.stat()
                except OSError:
                    continue
                rows.append((st.st_mtime, e.name, st.st_size))
    except Exception as ex:
        comfy.log("读取作品目录失败: %s" % str(ex)[:90], "WARN")
        return []
    rows.sort(key=lambda r: r[0], reverse=True)
    out = []
    for mt, local, size in rows[:limit]:
        w, h = _image_size(os.path.join(RESULTS_DIR, local))
        pub = "cyui_res_" + local
        has_input = bool(indir) and os.path.isfile(os.path.join(indir, pub))
        out.append({
            "name": pub if has_input else local,
            "label": local,
            "url": ("/api/image?type=input&filename=" + quote(pub)) if has_input
                   else ("/results/" + quote(local)),
            "thumb": "/api/thumb?src=result&filename=" + quote(local),
            "width": w, "height": h,
            "size": size,
            "mtime": int(mt),
            "source": "result",
            "need_convert": not has_input,
        })
    return out


def _thumb_name(kind, name, size):
    key = hashlib.md5(("%s|%s|%d" % (kind, name, size)).encode("utf-8")).hexdigest()[:20]
    return key + ".jpg"


@bp.route("/api/inputs")
def inputs():
    """图片选择弹窗的数据源：source=input 历史输入图，source=result 我的作品"""
    def run():
        try:
            limit = int(request.args.get("limit") or 180)
        except Exception:
            limit = 180
        limit = max(1, min(400, limit))
        source = (request.args.get("source") or "input").strip().lower()
        if source not in SOURCE_NAMES:
            source = "input"
        now = time.time()
        if (_INPUTS_CACHE["data"] is not None and _INPUTS_CACHE["limit"] == limit
                and _INPUTS_CACHE["source"] == source
                and now - _INPUTS_CACHE["ts"] < 8):
            return ok(images=_INPUTS_CACHE["data"], source=source,
                      source_name=SOURCE_NAMES[source], **comfy.input_dir_status())

        if source == "result":
            items = _scan_results(limit)
        else:
            d = comfy.input_dir()
            items = _scan_inputs(limit) if d else []
            if not items:
                items = _load_uploads()[:limit]
        _INPUTS_CACHE.update({"ts": now, "limit": limit, "source": source, "data": items})
        return ok(images=items, source=source, source_name=SOURCE_NAMES[source],
                  **comfy.input_dir_status())
    return _guard(run)


@bp.route("/api/thumb")
def thumb():
    """缩略图：历史输入动辄几百张，直接喂原图会把弹窗拖死

    src=result 时读本地 data/results（作品图），其余走 ComfyUI /view。
    """
    def run():
        name = comfy.safe_filename(request.args.get("filename", ""))
        src = (request.args.get("src") or "").strip().lower()
        kind = comfy.safe_kind(request.args.get("type", "input"))
        try:
            size = int(request.args.get("size") or 240)
        except Exception:
            size = 240
        size = max(64, min(512, size))
        if not name or (src != "result" and not kind):
            return fail("图片参数不合法", code=400)
        os.makedirs(_THUMB_DIR, exist_ok=True)
        fn = _thumb_name("result" if src == "result" else kind, name, size)
        path = os.path.join(_THUMB_DIR, fn)
        if not os.path.exists(path):
            if src == "result":
                local = os.path.join(RESULTS_DIR, name)
                if not os.path.isfile(local):
                    return fail("作品图不存在", code=404)
                with open(local, "rb") as f:
                    raw = f.read()
            else:
                raw = comfy.view(name, "", kind)
            with Image.open(io.BytesIO(raw)) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((size, size), Image.LANCZOS)
                tmp = path + ".%s.tmp" % uuid.uuid4().hex[:6]
                im.save(tmp, "JPEG", quality=86)
                os.replace(tmp, path)
        resp = send_from_directory(_THUMB_DIR, fn, mimetype="image/jpeg")
        resp.headers["Cache-Control"] = "public, max-age=604800"
        return resp
    return _guard(run)


@bp.route("/api/upload", methods=["POST"])
def upload():
    def run():
        files = request.files.getlist("image") or request.files.getlist("file")
        if not files:
            return fail("没有收到图片文件")
        out = []
        for f in files:
            raw = f.read()
            if not raw:
                continue
            orig = f.filename or ("upload_%s.png" % uuid.uuid4().hex[:6])
            safe = comfy.safe_filename(orig)
            if not safe:
                return fail("上传文件名不合法", code=400)
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", safe)[:80] or "image.png"
            if safe.startswith("."):
                safe = "image" + (os.path.splitext(safe)[1] or ".png")
            name = "cyui_%s_%s" % (uuid.uuid4().hex[:8], safe)
            # ComfyUI 对非 ascii 文件名兼容不稳定，统一转成 ascii
            if not all(ord(c) < 128 for c in name):
                ext = os.path.splitext(safe)[1].lower() or ".png"
                name = "cyui_%s%s" % (uuid.uuid4().hex[:10], ext)
            stored = comfy.upload_image(raw, name)
            w = h = 0
            try:
                im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
                w, h = im.size
            except Exception:
                pass
            info = {
                "name": stored,
                "url": "/api/image?type=input&filename=" + stored,
                "width": w,
                "height": h,
                "size": len(raw),
                "original": orig,
            }
            out.append(info)
            _record_upload(info)
            comfy.log("上传图片 %s (%d×%d, %.1f KB)" % (stored, w, h, len(raw) / 1024), "INFO")
        return ok(images=out)
    return _guard(run)


@bp.route("/api/image")
def proxy_image():
    def run():
        filename = comfy.safe_filename(request.args.get("filename", ""))
        subfolder = comfy.safe_subfolder(request.args.get("subfolder", ""))
        kind = comfy.safe_kind(request.args.get("type", "output"))
        if not filename or subfolder is None or kind is None:
            return fail("图片参数不合法", code=400)
        data = comfy.view(filename, subfolder, kind)
        ct = "image/png"
        if filename.lower().endswith((".jpg", ".jpeg")):
            ct = "image/jpeg"
        elif filename.lower().endswith(".webp"):
            ct = "image/webp"
        return Response(data, mimetype=ct)
    return _guard(run)


@bp.route("/api/generate", methods=["POST"])
def generate():
    def run():
        raw = request.get_json(force=True) or {}
        cfg = workflows.normalize(raw)
        errs = workflows.validate(cfg)
        if errs:
            return fail("；".join(errs))
        # GGUF 底模需要 ComfyUI-GGUF 插件提供加载器节点，缺插件时给出明确指引
        q = cfg["params"]
        need_unet_gguf = str(q.get("unet") or "").lower().endswith(".gguf")
        need_clip_gguf = str(q.get("clip") or "").lower().endswith(".gguf")
        if need_unet_gguf or need_clip_gguf:
            flags = (comfy.cached_catalog() or {}).get("gguf") or {}
            if not flags:
                try:
                    flags = comfy.catalog().get("gguf") or {}
                except Exception:
                    flags = {}
            if flags and ((need_unet_gguf and not flags.get("unet")) or
                          (need_clip_gguf and not flags.get("clip"))):
                return fail("当前 ComfyUI 未安装 GGUF 加载节点（ComfyUI-GGUF），无法使用 .gguf 底模。"
                            "请先在 ComfyUI-Manager 安装该插件并重启，详见「帮助」页。")

        # Viggle 5 步加速：需要 (1) 加速 LoRA 已在 ComfyUI 的 LoRA 清单里 (2) 底模是标准（非 turbo）权重。
        # 两个蒸馏 student 叠加会互相打架，所以 base 为 turbo 时自动换成同目录标准版。
        # 与 AI 助手共用 workflows.prepare_sampling，避免两条路径行为不一致。
        if q.get("sampling") == "viggle":
            cat = comfy.cached_catalog() or {}
            if not cat:
                try:
                    cat = comfy.catalog()
                except Exception:
                    cat = {}
            ok_v, err_v, notes_v = workflows.prepare_sampling(q, cat)
            if not ok_v:
                return fail(err_v)
            # 底模可能刚被换成标准版：重算一次「底模/方案是否匹配」的提示，别回传过期的
            q["unet_warn"] = workflows.unet_sampling_warning(q.get("sampling"), q.get("unet"))
            for n in notes_v:
                comfy.log("采样方案：" + n, "INFO")
        s = workflows.skill(cfg["mode"])
        sid = store.ensure_session(cfg["session_id"], cfg["title"] or cfg["prompt"][:24] or s["name"])
        cfg["session_id"] = sid
        cfg = _enrich_ref_size(cfg)
        prompt, meta = workflows.build(cfg, prefix="cyui/%s" % sid[:6])

        comfy.log(
            "提交任务 [%s] 参考图 %d 张 · %s · seed=%d"
            % (s["name"], len(cfg["images"]), meta["sampler"], cfg["params"]["seed"]),
            "INFO",
        )
        res = comfy.queue_prompt(prompt)
        pid = res.get("prompt_id")
        if not pid:
            return fail("ComfyUI 未返回 prompt_id", res)
        if res.get("node_errors"):
            comfy.log("节点校验警告: %s" % json.dumps(res["node_errors"], ensure_ascii=False)[:300], "WARN")

        user_msg = store.add_message(
            sid,
            {
                "role": "user",
                "content": cfg["prompt"],
                "mode": cfg["mode"],
                "skill": s["name"],
                "images": [
                    {"name": n, "url": "/api/image?type=input&filename=" + n} for n in cfg["images"]
                ],
                "mask": ("/api/image?type=input&filename=" + cfg["mask"]) if cfg["mask"] else None,
                "params": cfg["params"],
                "loras": cfg["loras"],
                "payload": raw,  # 供前端「重新生成」跨刷新复用
            },
            title=cfg["title"] or cfg["prompt"][:24] or s["name"],
        )
        asst_msg = store.add_message(
            sid,
            {
                "role": "assistant",
                "status": "pending",
                "job_id": pid,
                "mode": cfg["mode"],
                "skill": s["name"],
                "content": "",
                "images": [],
                "meta": meta,
                "prompt": cfg["prompt"],
                "final_prompt": cfg["final_prompt"],
            },
        )
        comfy.track(
            pid,
            {
                "session_id": sid,
                "assistant_mid": asst_msg["id"],
                "user_mid": user_msg["id"],
                "mode": cfg["mode"],
                "skill": s["name"],
                "prompt": cfg["prompt"],
                "final_prompt": cfg["final_prompt"],
                "params": cfg["params"],
                "loras": cfg["loras"],
                "workflow": prompt,
                "workflow_meta": meta,
                "images": cfg["images"],
            },
        )
        return ok(
            prompt_id=pid,
            session_id=sid,
            mode=cfg["mode"],
            skill=s["name"],
            final_prompt=cfg["final_prompt"],
            workflow=prompt,
            workflow_meta=meta,
            user_message=user_msg,
            assistant_message=asst_msg,
        )
    return _guard(run)


@bp.route("/api/upscale", methods=["POST"])
def upscale_image():
    """高清放大：图片 → SeedVR2 分块放大 → 结果进入当前会话与图库"""
    def run():
        data = request.get_json(force=True) or {}
        image = (data.get("image") or "").strip()
        if not image:
            return fail("请先选择要放大的图片")

        cat = comfy.cached_catalog() or {}
        if not (cat.get("seedvr2") or {}).get("ready"):
            try:
                cat = comfy.catalog(force=True)
            except Exception:
                cat = {}
            if not (cat.get("seedvr2") or {}).get("ready"):
                return fail("当前 ComfyUI 未安装 SeedVR2 或 TTP 分块节点，无法高清放大（详见「帮助」页）")

        cfg = upscale.settings()
        target = data.get("target", "default")
        try:
            scale, src, out = upscale.resolve(image, target, cfg)
        except Exception as e:
            return fail("读取图片尺寸失败：%s" % str(e)[:120])
        prompt = (data.get("prompt") or "").strip()
        name = (data.get("name") or prompt or "高清放大").strip()[:40]
        sid = store.ensure_session(data.get("session_id"), "高清放大 · " + name[:20])

        wf = upscale.build(image, scale, cfg, prefix="cyui/up_%s" % sid[:6])
        label = "×%.2f · %d×%d → %d×%d" % (scale, src[0], src[1], out[0], out[1])
        comfy.log("提交高清放大 [%s] %s" % (name, label), "INFO")
        res = comfy.queue_prompt(wf)
        pid = res.get("prompt_id")
        if not pid:
            return fail("ComfyUI 未返回 prompt_id", res)

        user_msg = store.add_message(sid, {
            "role": "user",
            "content": "高清放大 " + label,
            "mode": "upscale",
            "skill": "高清放大",
            "prompt": prompt,
            "images": [{"name": image, "url": "/api/image?type=input&filename=" + image}],
            "params": {"scale": scale, "target": target, "from": list(src), "to": list(out)},
            "payload": data,
        }, title="高清放大 · " + name[:20])
        asst_msg = store.add_message(sid, {
            "role": "assistant",
            "status": "pending",
            "job_id": pid,
            "mode": "upscale",
            "skill": "高清放大",
            "content": "",
            "images": [],
            "prompt": prompt,
            "final_prompt": prompt,
            "meta": {
                "sampler": "SeedVR2 " + label,
                "latent": "%d×%d" % (out[0], out[1]),
                "reference_images": 1,
                "loras": [],
                "upscale": True,
            },
        })
        comfy.track(pid, {
            "session_id": sid,
            "assistant_mid": asst_msg["id"],
            "user_mid": user_msg["id"],
            "mode": "upscale",
            "skill": "高清放大",
            "prompt": prompt or name,
            "final_prompt": prompt,
            "params": {"scale": scale, "target": target, "from": list(src), "to": list(out)},
            "loras": [],
            "workflow": wf,
            "workflow_meta": {},
            "images": [image],
        })
        return ok(prompt_id=pid, session_id=sid, scale=scale, src_size=src, out_size=out,
                  label=label, user_message=user_msg, assistant_message=asst_msg)
    return _guard(run)


_finalize_lock = threading.Lock()


def _finalize(pid):
    """轮询 /history，收拢结果图并落到本地。
    加锁：前端轮询请求线程与后台回收线程可能同时进入，造成图库重复记录。"""
    with _finalize_lock:
        return _finalize_locked(pid)


def _finalize_locked(pid):
    j = comfy.job(pid)
    if not j or j["finalized"]:
        return j
    meta = j["meta"]
    sid = meta["session_id"]

    if j["status"] == "error":
        comfy.patch_job(pid, finalized=True, finished_at=time.time())
        err = _humanize_error(j.get("error") or "生成失败")
        comfy.patch_job(pid, error=err)
        store.update_message(sid, meta["assistant_mid"], {"status": "error", "content": err})
        return comfy.job(pid)

    hist = {}
    try:
        hist = comfy.history(pid)
    except Exception as e:
        # 读不到 history（ComfyUI 重启 / 正在加载）时不能直接返回：
        # 否则「任务已被清掉」这种情况永远进不了下面的队列判定，进度条会一直转。
        comfy.log("读取 history 失败，转用队列判定：%s" % str(e)[:80], "WARN")
    rec = hist.get(pid)
    if not rec:
        # 任务既不在 /history 也不在 ComfyUI 队列里，说明它已被中断 / 清除
        # （用户点「中断」或「清空队列」后，ComfyUI 不会写 history）。
        # 旧逻辑一律干等 15 分钟，前端就一直显示「模型加载中…」的幽灵进度条。
        # 这里主动确认队列归属，确认已消失就立即收尾。
        queued_ids = None
        try:
            q = comfy.queue_state()
            queued_ids = set()
            for it in (q.get("queue_running") or []) + (q.get("queue_pending") or []):
                if isinstance(it, list) and len(it) > 1:
                    queued_ids.add(it[1])
        except Exception:
            queued_ids = None   # 队列读不到时不做判断，退回原来的超时兜底
        if queued_ids is not None and pid not in queued_ids and time.time() - j["started_at"] > 3:
            comfy.patch_job(pid, status="error", error="任务已中断或被清除", finalized=True,
                            finished_at=time.time())
            store.update_message(sid, meta["assistant_mid"],
                                 {"status": "error", "content": "任务已中断或被清除"})
            comfy.log("任务 %s 已不在队列也不在历史，判定为中断/清除" % pid[:8], "WARN")
            return comfy.job(pid)
        if time.time() - j["started_at"] > 900:
            comfy.patch_job(pid, status="error", error="等待 ComfyUI 结果超时（15 分钟）", finalized=True)
            store.update_message(sid, meta["assistant_mid"], {"status": "error", "content": "等待结果超时"})
        return comfy.job(pid)

    st = rec.get("status") or {}
    if st.get("status_str") == "error" or st.get("completed") is False:
        msgs = st.get("messages") or []
        detail = ""
        for m in msgs:
            if isinstance(m, list) and len(m) > 1 and isinstance(m[1], dict):
                detail = m[1].get("exception_message") or detail
        comfy.patch_job(pid, status="error", error=_humanize_error(detail or "ComfyUI 执行失败"), finalized=True)
        store.update_message(sid, meta["assistant_mid"],
                             {"status": "error", "content": _humanize_error(detail or "生成失败")})
        return comfy.job(pid)

    items = []
    for _nid, out in (rec.get("outputs") or {}).items():
        for img in out.get("images", []) or []:
            filename = img.get("filename")
            if not filename:
                continue
            sub = img.get("subfolder", "")
            kind = img.get("type", "output")
            try:
                data = comfy.view(filename, sub, kind)
            except Exception as e:
                comfy.log("结果图拉取失败 %s: %s" % (filename, e), "ERROR")
                continue
            ext = os.path.splitext(filename)[1].lower() or ".png"
            local = "%s_%d%s" % (pid[:8], len(items), ext)
            with open(os.path.join(RESULTS_DIR, local), "wb") as f:
                f.write(data)
            # 结果同时回灌 ComfyUI input：DeepSeek 后续可以直接把它当输入图继续处理
            try:
                in_name = assistant.publish_result_bytes(data, local)
            except Exception as e:
                comfy.log("结果图回灌 input 失败 %s: %s" % (local, e), "WARN")
                in_name = ""
            w = h = 0
            try:
                im = Image.open(io.BytesIO(data))
                w, h = im.size
            except Exception:
                pass
            items.append(
                {
                    "url": "/results/" + local,
                    "remote": filename,
                    "subfolder": sub,
                    "input_name": in_name,
                    "width": w,
                    "height": h,
                    "prompt_id": pid,
                    "mode": meta["mode"],
                    "skill": meta["skill"],
                    "prompt": meta["prompt"],
                    "name": (("放大 · " if meta.get("mode") == "upscale" else "")
                             + (meta["prompt"] or "未命名作品").strip().split("\n")[0])[:40],
                    "session_id": sid,
                    "params": meta["params"],
                    "ts": time.time(),
                }
            )

    elapsed = round(time.time() - j["started_at"], 1)
    if items:
        store.add_gallery(items)
        done_text = ("高清放大完成，共 %d 张" if meta.get("mode") == "upscale" else "生成完成，共 %d 张") % len(items)
        store.update_message(
            sid,
            meta["assistant_mid"],
            {"status": "done", "images": items, "elapsed": elapsed, "content": done_text},
        )
        comfy.patch_job(pid, status="done", finalized=True, results=items, elapsed=elapsed, progress=100)
        comfy.log("任务完成 %s · %d 张 · %.1fs" % (pid[:8], len(items), elapsed), "OK")
    elif st.get("completed"):
        comfy.patch_job(pid, status="error", error="ComfyUI 未返回图片", finalized=True, elapsed=elapsed)
        store.update_message(sid, meta["assistant_mid"], {"status": "error", "content": "未返回图片"})
    return comfy.job(pid)


@bp.route("/api/job/<pid>")
def job_status(pid):
    def run():
        j = _finalize(pid)
        if not j:
            return fail("任务不存在或已过期", code=404)
        j = dict(j)
        meta = dict(j.get("meta") or {})
        meta.pop("workflow", None)  # 轮询不回传完整工作流 JSON
        j["meta"] = meta
        return ok(job=j, message=store.get_session(j["meta"]["session_id"]) and _find_msg(j))
    return _guard(run)


def _find_msg(j):
    s = store.get_session(j["meta"]["session_id"]) or {}
    for m in s.get("messages", []):
        if m.get("job_id") == j["prompt_id"]:
            return m
    return None


@bp.route("/api/sessions")
def sessions():
    return _guard(lambda: ok(sessions=store.list_sessions()))


@bp.route("/api/sessions", methods=["POST"])
def create_session():
    def run():
        data = request.get_json(force=True) or {}
        raw_title = data.get("title")
        title = (raw_title.strip()[:40] if isinstance(raw_title, str) else "") or "新对话"
        return ok(session=store.new_session(title))
    return _guard(run)


@bp.route("/api/sessions/<sid>")
def session_detail(sid):
    return _guard(lambda: ok(session=store.get_session(sid)))


@bp.route("/api/sessions/<sid>/messages", methods=["POST"])
def session_add_message(sid):
    """通用消息追加：对话模式 / 无限画布 / DeepSeek 助手共用一条会话通路。

    助手把用户输入与最终回复都写进后端会话，对话模式即可看到 AI 的完整对话；
    人工侧的消息天然在会话里，助手面板合并渲染时也能看到。"""
    def run():
        data = request.get_json(force=True) or {}
        role = data.get("role")
        if role not in ("user", "assistant"):
            return fail("role 必须是 user 或 assistant")
        content = str(data.get("content") or "")[:8000]
        imgs = []
        for i in (data.get("images") or [])[:16]:
            if isinstance(i, dict) and str(i.get("url") or "").strip():
                try:
                    w = int(i.get("width") or 0); h = int(i.get("height") or 0)
                except Exception:
                    w = h = 0
                imgs.append({"name": str(i.get("name") or "")[:80],
                             "url": str(i.get("url"))[:300], "width": w, "height": h})
        msg = {
            "role": role, "content": content, "images": imgs,
            "source": str(data.get("source") or "assistant")[:20],
        }
        # 纯文本回复必须带终态：缺 status 会被前端当成 pending，渲染成一张永远
        # 「生成中」的空卡片（对话模式里那条多余的空创作任务就是这么来的）
        status = str(data.get("status") or "").strip()
        if status in ("done", "error", "pending", "running"):
            msg["status"] = status
        skill = str(data.get("skill") or "").strip()[:40]
        if skill:
            msg["skill"] = skill
        msg = store.add_message(sid, msg)
        if not msg:
            return fail("会话不存在：%s" % sid)
        return ok(message=msg)
    return _guard(run)


@bp.route("/api/sessions/batch-delete", methods=["POST"])
def sessions_batch_delete():
    """批量删除对话，联动删除这些对话在自由画布 / 图库里的作品（含两处文件）。"""
    def run():
        data = request.get_json(force=True) or {}
        res = store.delete_sessions(data.get("ids") or [])
        comfy_removed, comfy_failed = _drop_comfy_output(res.get("items") or [])
        return ok(deleted=len(res["sessions"]), gallery_removed=res["gallery"],
                  sessions_removed=res["sessions"], comfy_removed=comfy_removed,
                  failed_files=(res.get("failed_files") or []) + comfy_failed)
    return _guard(run)


@bp.route("/api/sessions/<sid>", methods=["DELETE"])
def session_delete(sid):
    def run():
        res = store.delete_session(sid)
        comfy_removed, comfy_failed = _drop_comfy_output(res.get("items") or [])
        return ok(deleted=res["session"], gallery_removed=res["gallery"],
                  comfy_removed=comfy_removed,
                  failed_files=(res.get("failed_files") or []) + comfy_failed)
    return _guard(run)


@bp.route("/api/sessions/<sid>/rename", methods=["POST"])
def session_rename(sid):
    def run():
        data = request.get_json(force=True) or {}
        raw_title = data.get("title")
        title = (raw_title.strip()[:40] if isinstance(raw_title, str) else "") or "新对话"
        return ok(renamed=store.rename_session(sid, title))
    return _guard(run)


@bp.route("/api/gallery")
def gallery():
    def run():
        return ok(gallery=store.list_gallery(_int_arg("limit", 160, 1, 400)))
    return _guard(run)


def _drop_comfy_output(items):
    """删除作品在 ComfyUI output 目录下的原图（送 Windows 回收站，可恢复）。

    gallery 条目的 remote / subfolder 记录了 ComfyUI 侧的文件位置
    （如 output/cyui/17a9f8_00049_.png）。用户要求：图库里删图 = 双侧都删
    （项目 data/results 副本 + ComfyUI output 原图）。

    comfy_dir 未配置时跳过（记日志）；路径做越界防护，只允许删 output 内的文件。
    返回 (删除数, failed_files)：失败（文件被占用等）汇总给前端弹窗提示。
    """
    base = str(config.get("comfy_dir") or "").strip()
    if not base:
        comfy.log("删除作品：未配置 ComfyUI 目录（comfy_dir），跳过 output 原图清理", "WARN")
        return 0, []
    out_root = os.path.abspath(os.path.join(base, "output"))
    n = 0
    failed = []
    for it in items or []:
        remote = str(it.get("remote") or "").strip()
        sub = str(it.get("subfolder") or "cyui").strip()
        if not remote:
            continue
        # 越界防护：remote / subfolder 都必须是纯相对路径
        if ".." in remote.replace("\\", "/").split("/") or ".." in sub.replace("\\", "/").split("/"):
            continue
        path = os.path.abspath(os.path.join(out_root, sub, remote))
        if not path.startswith(out_root + os.sep):
            continue
        if not os.path.isfile(path):
            continue                    # 本来就不存在：不算失败，保持安静
        ok, reason = store.to_recycle_bin(path)
        if ok:
            n += 1
        else:
            failed.append({"name": remote, "reason": reason})
            comfy.log("ComfyUI output 文件删除失败（%s）: %s" % (remote, reason or "未知"), "WARN")
    return n, failed


@bp.route("/api/gallery/batch-delete", methods=["POST"])
def gallery_batch_delete():
    """批量删除作品：图库 / 画布卡片 + data/results 副本 + ComfyUI output 原图。

    只删这几张图，不动所属对话。"""
    def run():
        data = request.get_json(force=True) or {}
        res = store.delete_gallery_items(data.get("ids") or [])
        comfy_removed, comfy_failed = _drop_comfy_output(res.get("items") or [])
        return ok(deleted=len(res["gallery"]), gallery_removed=res["gallery"],
                  files_removed=res["files"], sessions_removed=res["sessions"],
                  comfy_removed=comfy_removed,
                  failed_files=(res.get("failed_files") or []) + comfy_failed)
    return _guard(run)


@bp.route("/api/gallery/<gid>", methods=["DELETE"])
def gallery_delete(gid):
    """删除单张作品（同 batch-delete：只删图与两处文件，对话保留）"""
    def run():
        res = store.delete_gallery_item(gid)
        comfy_removed, comfy_failed = _drop_comfy_output(res.get("items") or [])
        return ok(deleted=bool(res["gallery"]), gallery_removed=res["gallery"],
                  files_removed=res["files"], sessions_removed=res["sessions"],
                  comfy_removed=comfy_removed,
                  failed_files=(res.get("failed_files") or []) + comfy_failed)
    return _guard(run)


@bp.route("/api/gallery/<gid>", methods=["POST"])
def gallery_update(gid):
    """自由画布：改名 / 拖拽坐标 / 卡片缩放"""
    def run():
        patch = request.get_json(force=True) or {}
        updated = store.update_gallery_item(gid, patch)
        if not updated:
            return fail("作品不存在", code=404)
        return ok(updated=True)
    return _guard(run)


@bp.route("/api/interrupt", methods=["POST"])
def interrupt():
    def run():
        comfy.interrupt()
        comfy.log("已发送中断请求", "WARN")
        return ok(interrupted=True)
    return _guard(run)


@bp.route("/api/polish", methods=["POST"])
def polish():
    """提示词润色：provider = local（ComfyUI TextGenerateV2）| deepseek（远程 API）。
    带参考图（图生图 / 图片编辑 / 局部重绘）时把图片与提示词一起传给模型。"""
    def run():
        data = request.get_json(force=True) or {}
        prompt = (data.get("prompt") or "").strip()
        if not prompt:
            return fail("提示词为空，无需润色")
        provider = data.get("provider") or "local"
        mode = data.get("mode") if data.get("mode") in ("img2img", "edit", "inpaint") else None
        images = []
        for x in (data.get("images") or [])[:4]:
            f = comfy.safe_filename(str(x or ""))
            if f:
                images.append(f)
        cfg = data.get("llm") if isinstance(data.get("llm"), dict) else None
        cost = None
        if provider == "deepseek":
            key = (data.get("api_key") or "").strip()
            if not key:
                return fail("请先在全局设置的「提示词润色 / 反推」里填写 DeepSeek API Key")
            text, cost = polish_svc.polish_deepseek(prompt, key, data.get("model") or "deepseek-chat",
                                                    cfg, images=images, mode=mode)
        else:
            text, cost = llm.polish(prompt, cfg, images=images, mode=mode)
        if not text:
            return fail("润色结果为空")
        return ok(polished=text, provider=provider, seconds=cost,
                  multimodal=bool(images and mode))
    return _guard(run)


@bp.route("/api/reverse", methods=["POST"])
def reverse_prompt():
    """提示词反推：单张参考图（ComfyUI input 里的文件名）→ 画面提示词
    provider = local（Qwen3-VL）| deepseek（视觉模型）"""
    def run():
        data = request.get_json(force=True) or {}
        image = (data.get("image") or "").strip()
        if not image:
            return fail("请先上传一张参考图，再进行反推")
        cfg = data.get("llm") if isinstance(data.get("llm"), dict) else None
        provider = data.get("provider") or "local"
        if provider == "deepseek":
            key = (data.get("api_key") or "").strip()
            if not key:
                return fail("请先在全局设置的「提示词润色 / 反推」里填写 DeepSeek API Key")
            text, cost = polish_svc.reverse_deepseek(
                image, key, data.get("vision_model") or "", cfg, data.get("hint") or "")
        else:
            text, cost = llm.reverse(image, data.get("hint") or "", cfg)
        return ok(text=text, seconds=cost, provider=provider)
    return _guard(run)


@bp.route("/api/polish/models", methods=["POST"])
def polish_models():
    """用 DeepSeek API Key 拉取可用模型列表，供用户自选"""
    def run():
        data = request.get_json(force=True) or {}
        key = (data.get("api_key") or "").strip()
        if not key:
            return fail("请先填写 DeepSeek API Key")
        return ok(models=polish_svc.list_deepseek_models(key))
    return _guard(run)


@bp.route("/api/assistant/chat", methods=["POST"])
def assistant_chat():
    """DeepSeek 助手：带工具调用的对话（生成 / 放大 / 提示词 / 批量）——旧接口，一次性返回"""
    def run():
        data = request.get_json(force=True) or {}
        res = assistant.chat(
            data.get("messages") or [],
            (data.get("api_key") or "").strip(),
            data.get("model") or "deepseek-chat",
            session_id=(data.get("session_id") or "").strip(),
            user_loras=data.get("loras") or [],
            sampling=(data.get("sampling") or "").strip(),
            workspace=data.get("workspace") or {},
        )
        return ok(reply=res.get("reply") or "", events=res.get("events") or [])
    return _guard(run)


@bp.route("/api/assistant/chat_stream", methods=["POST"])
def assistant_chat_stream():
    """DeepSeek 助手流式版（SSE）：步骤即时推送、支持中途停止、可连续多步工作"""
    data = request.get_json(force=True) or {}

    def gen():
        try:
            for ev in assistant.chat_stream(
                data.get("messages") or [],
                (data.get("api_key") or "").strip(),
                data.get("model") or "deepseek-chat",
                max_steps=data.get("max_steps") or 8,
                session_id=(data.get("session_id") or "").strip(),
                user_loras=data.get("loras") or [],
                sampling=(data.get("sampling") or "").strip(),
                workspace=data.get("workspace") or {},
            ):
                yield "data: %s\n\n" % json.dumps(ev, ensure_ascii=False)
        except Exception as e:
            # 生成器自身异常也要给前端一个终止事件
            yield "data: %s\n\n" % json.dumps({"type": "error", "error": str(e)[:200]},
                                              ensure_ascii=False)
        yield "data: {\"type\":\"done\"}\n\n"

    resp = Response(gen(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@bp.route("/api/assistant/loras")
def assistant_loras():
    """AI 助手用的 LoRA 清单（前端手选面板与 AI 搜索共用同一份）"""
    def run():
        q = request.args.get("q") or ""
        try:
            limit = int(request.args.get("limit") or 200)
        except Exception:
            limit = 200
        pool = assistant.lora_inventory()
        items = assistant.search_loras(q, limit) if q else [
            {"name": n, "hint": assistant.lora_hint(n)} for n in pool[:max(1, limit)]]
        return ok(total=len(pool), items=items,
                  accel_hint=list(workflows.VIGGLE_HINTS))
    return _guard(run)


@bp.route("/api/assistant/stop", methods=["POST"])
def assistant_stop():
    """停止 / 截断正在进行的 AI 思考与工具执行"""
    def run():
        data = request.get_json(force=True) or {}
        sid = (data.get("stream_id") or "").strip()
        if not sid:
            return fail("缺少 stream_id")
        assistant._CHAT_CANCELS[sid] = True
        return ok(stopped=sid)
    return _guard(run)


@bp.route("/api/assistant/image-to-input", methods=["POST"])
def assistant_image_to_input():
    """把任意图片地址（尤其是 /results/ 结果图）转成 ComfyUI input 文件名，供拖拽复用。"""
    def run():
        data = request.get_json(force=True) or {}
        return ok(**assistant.image_to_input(data.get("url") or ""))
    return _guard(run)


@bp.route("/api/assistant/batch/<bid>")
def assistant_batch(bid):
    return _guard(lambda: ok(**assistant.batch_status(bid)))


@bp.route("/api/assistant/skills")
def assistant_skills():
    return _guard(lambda: ok(skills=assistant.public_skills()))


@bp.route("/api/queue")
def queue():
    return _guard(lambda: ok(queue=comfy.queue_state()))


def _queue_row(item, status, now):
    """把 ComfyUI 的队列条目 [number, prompt_id, prompt, extra, outputs] 转成可读行"""
    try:
        number, pid = item[0], item[1]
    except Exception:
        return None
    j = comfy.job(pid) or {}
    meta = j.get("meta") or {}
    params = meta.get("params") or {}
    started = j.get("started_at")
    return {
        "number": number,
        "prompt_id": pid,
        "short_id": str(pid)[:8],
        "status": status,
        "skill": meta.get("skill") or "",
        "prompt": (meta.get("prompt") or "").strip()[:140],
        "seed": params.get("seed"),
        "batch": params.get("batch"),
        "sampling": params.get("sampling"),
        "steps": params.get("steps"),
        "progress": j.get("progress") or 0,
        "step": j.get("step") or 0,
        "total": j.get("total") or 0,
        "elapsed": round(now - started, 1) if started else None,
        "tracked": bool(j),
    }


@bp.route("/api/queue/detail")
def queue_detail():
    """队列小窗：运行中 / 排队中的任务明细（含本应用提交的参数摘要）"""
    def run():
        try:
            q = comfy.queue_state()
        except Exception as e:
            return ok(online=False, error=str(e)[:200], running=[], pending=[])
        now = time.time()
        running = [r for r in (_queue_row(it, "running", now) for it in (q.get("queue_running") or [])) if r]
        pending = [r for r in (_queue_row(it, "pending", now) for it in (q.get("queue_pending") or [])) if r]
        return ok(
            online=True,
            running=running,
            pending=pending,
            total=len(running) + len(pending),
            comfy_base=comfy.base(),
        )
    return _guard(run)


@bp.route("/api/queue/clear", methods=["POST"])
def queue_clear():
    """清空排队中的任务（不打断正在执行的那个）"""
    def run():
        q = comfy.queue_state()
        ids = [it[1] for it in (q.get("queue_pending") or []) if len(it) > 1]
        if ids:
            comfy.delete_queue(ids)
            comfy.log("已清空排队任务 %d 个" % len(ids), "WARN")
        return ok(cleared=len(ids))
    return _guard(run)


@bp.route("/api/logs")
def logs():
    return _guard(lambda: ok(logs=comfy.logs(_int_arg("limit", 200, 1, 1000))))


# ---------------------------------------------------------------------------
# 结果兜底回收：不依赖前端轮询
# 页面刷新、标签页关闭、服务重启都可能让前端丢掉 pending 集合，导致 ComfyUI
# 早已出图、会话却一直显示「生成中」。这里由服务端定时补齐。
# ---------------------------------------------------------------------------
def reconcile_pending():
    now = time.time()
    for s in store.list_sessions():
        full = store.get_session(s["id"]) or {}
        msgs = full.get("messages", [])
        for m in msgs:
            if m.get("role") != "assistant" or m.get("status") != "pending" or not m.get("job_id"):
                continue
            pid = m["job_id"]
            if not comfy.job(pid):
                # 服务重启后内存任务丢失：从上一条 user 消息的 payload 重建最小 meta
                payload = {}
                for u in msgs:
                    if u.get("role") == "user" and isinstance(u.get("payload"), dict):
                        payload = u["payload"]
                comfy.track(pid, {
                    "session_id": s["id"],
                    "assistant_mid": m["id"],
                    "mode": payload.get("mode") or m.get("mode") or "text2img",
                    "skill": m.get("skill") or "创作",
                    "prompt": payload.get("prompt") or "",
                    "params": payload.get("params") or {},
                    "loras": payload.get("loras") or [],
                    "workflow": None,
                    "workflow_meta": m.get("meta") or {},
                    "images": payload.get("images") or [],
                })
            _finalize(pid)
            j = comfy.job(pid)
            if j and not j.get("finalized") and now - (m.get("ts") or now) > 1200:
                # 任务确实找不回来了（通常是 ComfyUI 侧也重启过，history 已清）
                try:
                    comfy.system_stats()
                    online = True
                except Exception:
                    online = False
                detail = ("ComfyUI 重启过，这个任务的记录已不存在，请重新生成"
                          if online else "ComfyUI 未连接，无法确认任务状态；重新连接后如仍失败请重新生成")
                comfy.patch_job(pid, status="error", error=detail, finalized=True)
                store.update_message(
                    s["id"], m["id"],
                    {"status": "error", "content": detail},
                )


def start_reconciler():
    # 启动即恢复：CYUI 重启后，正在生成 / 刚生成完的任务消息还在 pending 状态，
    # 立刻对账一轮（ComfyUI history 里若仍有结果就能把图收回来），不等第一个 5s 周期
    def first_pass():
        try:
            pend = [m for s in store.list_sessions()
                    for m in (store.get_session(s["id"]) or {}).get("messages", [])
                    if m.get("role") == "assistant" and m.get("status") == "pending" and m.get("job_id")]
            if pend:
                comfy.log("发现 %d 条未完成任务消息，正在向 ComfyUI 对账恢复…" % len(pend), "INFO")
                reconcile_pending()
                comfy.log("未完成任务对账完成", "OK")
        except Exception as e:
            comfy.log("启动对账失败: %s" % e, "WARN")
    threading.Thread(target=first_pass, name="cyui-reconcile-first", daemon=True).start()

    def loop():
        while True:
            time.sleep(5)
            try:
                reconcile_pending()
            except Exception as e:
                comfy.log("结果回收异常: %s" % e, "WARN")
    threading.Thread(target=loop, name="cyui-reconcile", daemon=True).start()
    comfy.log("结果兜底回收线程已启动（5s）", "INFO")


# ---------- 版本与更新（帮助页「版本与更新」卡片） ----------
# 更新策略：帮助页放一个长期网盘链接，发布方往网盘传新版即可，应用内不做自动更新。

@bp.route("/api/version")
def api_version():
    return ok(version=version.APP_VERSION, download_url=version.DOWNLOAD_URL)
