"""工作流、生成任务与作品接口。"""
import json
import time
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, request

from api import services
from config import DEFAULT_PROMPT_FUNCTION_TEMPLATES, DEFAULT_PROMPT_TEMPLATES
from core.comfy import ComfyError

bp = Blueprint("generate_api", __name__, url_prefix="/api")


@bp.get("/workflows")
def list_workflows():
    svc = services()
    items = svc["workflows"].list()
    # 当前实例跑不起来的工作流标成 available=False（前端从下拉里隐藏，设置里给原因）
    try:
        caps = svc["instance"].capabilities(svc["workflows"].all())
    except Exception:
        caps = {}
    for item in items:
        info = caps.get(item["id"]) or {}
        item["available"] = info.get("available", True)
        item["missing_nodes"] = info.get("missing_nodes") or []
        item["missing_models"] = info.get("missing_models") or []
        item["unavailable_reason"] = info.get("reason") or ""
    return jsonify(items)


def _combo_options(spec) -> list:
    """从 object_info 的输入定义里取可选值：兼容新旧两种写法。

    旧：[[a, b, c], {...}]      新：["COMBO", {"options": [a, b, c]}]
    """
    if not isinstance(spec, list) or not spec:
        return []
    if isinstance(spec[0], list):
        return list(spec[0])
    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return list(spec[1].get("options") or [])
    return []


def _input_options(info: dict, node: str, field: str) -> list:
    inputs = (info.get(node) or {}).get("input") or {}
    spec = ((inputs.get("required") or {}).get(field)
            or (inputs.get("optional") or {}).get(field))
    return _combo_options(spec)


@bp.get("/workflows/<path:workflow_id>/params")
def workflow_params(workflow_id):
    svc = services()
    if svc["workflows"].get_workflow(workflow_id) is None:
        return jsonify({"error": "工作流不存在"}), 404
    kind = svc["workflows"].kind_of(workflow_id)
    # 图片参数与提示词参数分开存储
    bucket = "prompt_params" if kind == "llm" else "workflow_params"
    saved = (svc["settings_store"].read().get(bucket) or {}).get(workflow_id, {})
    endpoints = {
        "unet": ("UNETLoader", "unet_name"),
        "clip": ("CLIPLoader", "clip_name"),
        "vae": ("VAELoader", "vae_name"),
        "sampler_name": ("KSampler", "sampler_name"),
        "scheduler": ("KSampler", "scheduler"),
    }
    if kind == "llm":
        endpoints = {"clip": ("CLIPLoader", "clip_name")}
    elif svc["workflows"].lora_slots_of(workflow_id):
        endpoints["lora"] = ("LoraLoaderModelOnly", "lora_name")
    # 工作流自己声明的额外下拉选项（比如 TTP 放大用的 SeedVR2 模型、放大算法）
    wf_obj = svc["workflows"].get_workflow(workflow_id)
    for key, (node, field) in (getattr(wf_obj, "option_sources", {}) or {}).items():
        endpoints[key] = (node, field)   # 工作流自己声明的优先（比如采样器来自 KSamplerSelect 而不是 KSampler）
    options = {}
    for key, (endpoint, field) in endpoints.items():
        # 先吃实例快照（整份 object_info 只拉一次），没有再单独问，避免 18 个工作流
        # 各发五次请求把设置面板卡住；单个节点缺失也只影响它自己那一栏
        try:
            cached = svc["instance"].cached_options(endpoint, field)
        except Exception:
            cached = None
        if cached:
            options[key] = cached
            continue
        try:
            info = svc["comfy"].object_info(endpoint, timeout=12)
            options[key] = _input_options(info, endpoint, field)
        except Exception:
            options[key] = []
    wf_obj = svc["workflows"].get_workflow(workflow_id)
    try:
        health = svc["instance"].inspect(wf_obj)
    except Exception:
        health = {"available": True, "missing_nodes": [], "missing_models": [], "reason": ""}
    return jsonify({
        "kind": kind,
        "workflow": wf_obj.list_item(),
        "defaults": svc["workflows"].defaults_of(workflow_id),
        "saved": saved,
        "options": options,
        "lora_slots": svc["workflows"].lora_slots_of(workflow_id),
        "param_map": svc["workflows"].param_map_of(workflow_id),
        "fields": getattr(wf_obj, "settings_fields", None),
        "available": health.get("available", True),
        "missing_nodes": health.get("missing_nodes") or [],
        "missing_models": health.get("missing_models") or [],
        "unavailable_reason": health.get("reason") or "",
    })


@bp.post("/workflows/<path:workflow_id>/params")
def save_workflow_params(workflow_id):
    """保存单个工作流的参数（Agent 调整 LoRA / 步数 / 模型时用，不动其它工作流）。"""
    svc = services()
    wf = svc["workflows"].get_workflow(workflow_id)
    if wf is None:
        return jsonify({"error": "工作流不存在"}), 404
    data = request.get_json(silent=True) or {}
    values = data.get("params")
    if not isinstance(values, dict) or not values:
        return jsonify({"error": "没有要保存的参数"}), 400

    def edit(store):
        bucket = store.setdefault("workflow_params", {})
        current = dict(bucket.get(workflow_id) or {})
        for key, value in values.items():
            if isinstance(key, str) and key and not key.startswith("_"):
                current[key] = value
        bucket[workflow_id] = current

    svc["settings_store"].update(edit)
    saved = (svc["settings_store"].read().get("workflow_params") or {}).get(workflow_id, {})
    return jsonify({"ok": True, "workflow": workflow_id, "params": saved})


@bp.post("/generate")
def generate():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    workflow_id = data.get("workflow") or "z-image-turbo-文生图"
    wf = services()["workflows"].get_workflow(workflow_id)
    if not prompt and getattr(wf, "supports_prompt", True):
        return jsonify({"error": "请先描述要生成的图片"}), 400

    projects = services()["projects"]
    project_id = data.get("project_id") or projects.active()["id"]
    # workflow_params：可选参数快照，「按原图再生成一张」时带上，确保 LoRA / 模型 / 步数一致
    snapshot = data.get("workflow_params")
    if snapshot is not None and not isinstance(snapshot, dict):
        snapshot = None
    task = services()["tasks"].submit(
        project_id, prompt, workflow_id,
        data.get("params"),
        snapshot,
    )
    return jsonify(task), 202


@bp.post("/deepseek/models")
def deepseek_models():
    """代理拉取 DeepSeek 的模型列表（GET {base}/models），Key 存在后端不走前端。"""
    data = request.get_json(silent=True) or {}
    saved = (services()["settings_store"].read()
             .get("prompt_params") or {}).get("deepseek-api") or {}
    api_key = str(data.get("api_key") or saved.get("api_key") or "").strip()
    base = (str(data.get("base_url") or saved.get("base_url") or "https://api.deepseek.com")
            .strip().rstrip("/"))
    if not api_key:
        return jsonify({"error": "请先填写 API Key"}), 400
    try:
        request_obj = urllib.request.Request(
            f"{base}/models", headers={"Authorization": f"Bearer {api_key}"})
        with urllib.request.urlopen(request_obj, timeout=15) as response:
            payload = json.load(response)
        models = [item.get("id") for item in payload.get("data", []) if item.get("id")]
        return jsonify({"models": models})
    except urllib.error.HTTPError as exc:
        hint = {401: "API Key 无效", 404: "接口地址不对"}.get(exc.code, "")
        return jsonify({"error": f"获取模型列表失败：{exc.code} {hint}".strip()}), 502
    except Exception as exc:
        return jsonify({"error": f"获取模型列表失败：{exc}"}), 502


@bp.post("/video/last-frame")
def video_last_frame():
    """取视频最后一帧，存成一张新的图片作品（本地 ffmpeg，不走 ComfyUI）。"""
    from core.video_frames import VideoFrameError

    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "缺少视频地址"}), 400
    try:
        task = services()["frames"].last_frame(url, data.get("project_id") or "")
    except VideoFrameError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"取尾帧失败：{exc}"}), 500
    return jsonify({"ok": True, "task": task}), 201


@bp.post("/prompt/run")
def run_prompt():
    """四种提示词功能：润色 / 单图反推 / 图片编辑润色 / minimax 提示词。"""
    data = request.get_json(silent=True) or {}
    assets = data.get("assets") or []
    if not isinstance(assets, list):
        return jsonify({"error": "assets 格式不正确"}), 400
    try:
        result = services()["ai"].run(
            (data.get("function") or "polish").strip(),
            data.get("prompt") or "",
            [item for item in assets if isinstance(item, dict)],
            data.get("template_id") or "",
            (data.get("workflow") or "").strip(),
        )
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(result)


@bp.get("/prompt-templates")
def list_prompt_templates():
    svc = services()
    settings = svc["settings_store"].read()
    return jsonify({
        "templates": svc["ai"].templates(),
        "bindings": settings.get("prompt_function_templates") or DEFAULT_PROMPT_FUNCTION_TEMPLATES,
        "defaults": DEFAULT_PROMPT_TEMPLATES,
    })


@bp.put("/prompt-templates")
def save_prompt_templates():
    """整表保存：前端负责新建 / 改名 / 删除，这里只做校验与落盘。"""
    data = request.get_json(silent=True) or {}
    raw = data.get("templates")
    if not isinstance(raw, list):
        return jsonify({"error": "templates 格式不正确"}), 400

    templates = []
    used = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:40] or "未命名模版"
        identifier = str(item.get("id") or "").strip()
        if not identifier or identifier in used:
            identifier = "tpl_" + str(int(time.time() * 1000)) + str(len(templates))
        used.add(identifier)
        templates.append({
            "id": identifier,
            "name": name,
            "system": str(item.get("system") or "")[:4000],
            "user": str(item.get("user") or "")[:4000],
            "builtin": bool(item.get("builtin")),
        })
    if not templates:
        return jsonify({"error": "至少保留一个模版"}), 400

    ids = {item["id"] for item in templates}
    bindings = {}
    for key, value in (data.get("bindings") or {}).items():
        if key in DEFAULT_PROMPT_FUNCTION_TEMPLATES:
            bindings[key] = value if value in ids else templates[0]["id"]
    for key, value in DEFAULT_PROMPT_FUNCTION_TEMPLATES.items():
        bindings.setdefault(key, value if value in ids else templates[0]["id"])

    def edit(db):
        db["prompt_templates"] = templates
        db["prompt_function_templates"] = bindings

    services()["settings_store"].update(edit)
    return jsonify({"ok": True, "templates": templates, "bindings": bindings})


@bp.get("/projects/<project_id>/tasks")
def project_tasks(project_id):
    return jsonify(services()["projects"].tasks_for(project_id))


@bp.post("/projects/<project_id>/tasks/clear")
def clear_finished_tasks(project_id):
    count = services()["projects"].clear_finished_tasks(project_id)
    return jsonify({"ok": True, "cleared": count})


@bp.get("/tasks/<task_id>")
def task_detail(task_id):
    task = services()["projects"].get_task(task_id)
    return jsonify(task or {"error": "任务不存在"}), 200 if task else 404


@bp.post("/tasks/<task_id>/media-name")
def rename_media(task_id):
    """给作品里的某张图 / 视频 / 音频改显示名（存进 task.image_names，按地址索引）。"""
    projects = services()["projects"]
    task = projects.get_task(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    name = str(data.get("name") or "").strip()[:60]
    if not url:
        return jsonify({"error": "缺少素材地址"}), 400
    names = dict(task.get("image_names") or {})
    if name:
        names[url] = name
    else:
        names.pop(url, None)
    projects.update_task(task_id, image_names=names)
    return jsonify({"ok": True, "url": url, "name": name, "image_names": names})


@bp.post("/images/delete")
def delete_images():
    data = request.get_json(silent=True) or {}
    items = data.get("items") or []
    if not isinstance(items, list):
        return jsonify({"error": "items 格式不正确"}), 400
    count = services()["images"].delete(items)
    return jsonify({"ok": True, "deleted": count})


@bp.post("/images/edit")
def edit_image():
    """本地图片编辑（裁剪 / 旋转翻转 / 色调），直接生成一张新作品。"""
    from core.image_edit import ImageEditError

    data = request.get_json(silent=True) or {}
    url = data.get("url") or ""
    op = str(data.get("op") or "")
    if not url:
        return jsonify({"error": "缺少图片地址"}), 400
    try:
        task = services()["editor"].edit(url, op, data.get("options") or {})
    except ImageEditError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:                       # PIL 处理失败也要给出可读原因
        return jsonify({"error": f"图片处理失败：{exc}"}), 400
    return jsonify(task), 201


@bp.post("/tasks/<task_id>/reclaim")
def reclaim_task(task_id):
    """超时 / 中断任务的找回：ComfyUI 那边结果还在就直接落盘，仍在跑就重新挂上进度。"""
    result = services()["tasks"].reclaim(task_id)
    return jsonify(result), 200 if result.get("ok") else 400


@bp.post("/tasks/<task_id>/cancel")
def cancel_task(task_id):
    return jsonify({"ok": services()["tasks"].cancel(task_id)})


@bp.post("/comfy/interrupt")
def interrupt_comfy():
    """中断 ComfyUI 当前执行：停止提示词运行等没有任务号的工作流。"""
    return jsonify({"ok": services()["tasks"].interrupt()})


@bp.delete("/tasks/<task_id>")
def delete_task(task_id):
    services()["projects"].delete_task(task_id)
    return jsonify({"ok": True})
