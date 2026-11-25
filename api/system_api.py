"""系统状态、ComfyUI 连通性与设置接口。"""
from flask import Blueprint, jsonify, request

from api import services
from core.comfy import ComfyError

bp = Blueprint("system_api", __name__, url_prefix="/api")


@bp.get("/system/stats")
def system_stats():
    data = services()["monitor"].sample()
    # 提示词生成这类不落库的短任务也跟着返回，前端合成「生成进度」
    data["jobs"] = services()["tasks"].list_jobs()
    return jsonify(data)


@bp.get("/comfy/status")
def comfy_status():
    svc = services()
    try:
        data = {"online": True, **svc["comfy"].status()}
    except ComfyError as exc:
        return jsonify({"online": False, "error": str(exc)}), 503
    # 当前实例的能力：节点数 + 跑不起来的工作流（远程实例缺节点 / 缺模型时看这里）
    try:
        data["instance"] = svc["instance"].summary(svc["workflows"].all())
    except Exception:
        data["instance"] = {}
    return jsonify(data)


@bp.get("/manifest")
def project_manifest():
    """项目清单：本项目需要的 ComfyUI 版本、自定义节点与模型（含仓库 / 模型地址）。"""
    from core import manifest

    svc = services()
    data = manifest.build(svc["workflows"].all(), svc.get("instance"))
    return jsonify(data)


@bp.get("/settings")
def get_settings():
    settings = dict(services()["settings_store"].read())
    if settings.get("ai_api_key"):
        settings["ai_api_key"] = "******"
    return jsonify(settings)


@bp.post("/settings")
def update_settings():
    data = request.get_json(silent=True) or {}
    allowed = {"comfy_url", "comfy_dir", "client_id", "task_timeout", "poll_interval",
               "ai_api_url", "ai_api_key", "ai_model", "workflow_params",
               "prompt_workflow", "prompt_params"}
    # AI Agent 有自己的保存按钮，但设置页的总保存也带上，避免用户以为没存
    if isinstance(data.get("agent"), dict):
        try:
            services()["agent"].save(data["agent"])
        except Exception:
            pass
    changes = {k: v for k, v in data.items() if k in allowed}
    if changes.get("ai_api_key") == "******":
        changes.pop("ai_api_key")
    services()["settings_store"].update(
        lambda store: store.update(changes)
    )
    return jsonify({"ok": True, "updated": list(changes)})
