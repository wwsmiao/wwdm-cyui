"""项目相关接口。"""
from flask import Blueprint, jsonify, request

from api import services

bp = Blueprint("projects_api", __name__, url_prefix="/api/projects")


@bp.get("")
def list_projects():
    svc = services()
    return jsonify({
        "projects": svc["projects"].list(),
        "active_id": svc["projects"].active()["id"],
    })


@bp.post("")
def create_project():
    data = request.get_json(silent=True) or {}
    return jsonify(svc_projects().create(data.get("name", "Untitled"))), 201


@bp.post("/batch-delete")
def batch_delete_projects():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    if not isinstance(ids, list):
        return jsonify({"error": "ids 格式不正确"}), 400
    count = services()["projects"].delete_batch(ids)
    try:
        services()["layouts"].drop_many(ids)
    except Exception:
        pass
    return jsonify({"ok": True, "deleted": count})


@bp.post("/<project_id>/duplicate")
def duplicate_project(project_id):
    result = svc_projects().duplicate(project_id)
    return jsonify(result or {"error": "项目不存在"}), 200 if result else 404


@bp.post("/<project_id>/activate")
def activate_project(project_id):
    result = svc_projects().set_active(project_id)
    return jsonify(result or {"error": "项目不存在"}), 200 if result else 404


@bp.patch("/<project_id>")
def rename_project(project_id):
    result = svc_projects().rename(project_id, (request.get_json(silent=True) or {}).get("name", ""))
    return jsonify(result or {"error": "项目不存在"}), 200 if result else 404


@bp.put("/<project_id>/notes")
def save_notes(project_id):
    """文本模式的笔记：整段覆盖保存。"""
    data = request.get_json(silent=True) or {}
    result = svc_projects().set_notes(project_id, data.get("notes", ""))
    return jsonify(result or {"error": "项目不存在"}), 200 if result else 404


@bp.get("/<project_id>/layout")
def get_layout(project_id):
    """画布布局：节点位置、连线、生成结果都存服务端，刷新/换浏览器不丢。"""
    store = services()["layouts"]
    return jsonify({"layout": store.get(project_id), "exists": store.has(project_id)})


@bp.put("/<project_id>/layout")
def save_layout(project_id):
    data = request.get_json(silent=True) or {}
    layout = data.get("layout")
    if not isinstance(layout, dict):
        return jsonify({"error": "layout 格式不正确"}), 400
    ok = services()["layouts"].save(project_id, layout)
    return jsonify({"ok": ok}), 200 if ok else 400


@bp.delete("/<project_id>")
def delete_project(project_id):
    svc_projects().delete(project_id)
    # 上传索引 / 画布布局里的该项目记录一并清掉
    try:
        services()["files"].uploads.drop_project(project_id)
    except Exception:
        pass
    try:
        services()["layouts"].drop(project_id)
    except Exception:
        pass
    return jsonify({"ok": True})


def svc_projects():
    return services()["projects"]
