"""素材库：ComfyUI 输入/输出浏览、本项目素材、参考图导入与本地直传。"""
import mimetypes
from urllib.parse import quote

from flask import Blueprint, Response, jsonify, request

from api import services
from core.comfy import ComfyError

bp = Blueprint("files_api", __name__, url_prefix="/api")


def _comfy_url(source: str, name: str) -> str:
    return f"/api/comfy/file?source={source}&name={quote(name)}"


def _kind_of(url: str) -> str:
    suffix = ("." + url.rsplit(".", 1)[-1].lower()) if "." in url else ""
    from core.comfy_files import MEDIA_KINDS
    return MEDIA_KINDS.get(suffix, "image")


def _project_assets(project_id: str) -> list:
    from pathlib import Path

    from core.naming import is_generic, safe_stem

    svc = services()
    items = []
    for task in svc["projects"].tasks_for(project_id):
        for url in task.get("images") or []:
            kind = _kind_of(url)
            if kind == "image" and task.get("kind") == "video":
                kind = "video"
            name = url.rsplit("/", 1)[-1]
            # 旧作品的 1.png / 2.png：用提示词摘要顶替，列表和下载都不再重名
            if is_generic(name):
                stem = safe_stem(task.get("prompt") or "", 24)
                if stem:
                    name = f"{stem}{Path(name).suffix}"
            items.append({
                "key": f"project:{url}",
                "name": name,
                "kind": kind,
                "source": "project",
                "url": url,
                "ref": {"source": "project", "name": url},
                "width": task.get("width") or 0,
                "height": task.get("height") or 0,
                "task_id": task.get("id", ""),
                "caption": task.get("prompt", ""),
                "mtime": task.get("created_at", 0),
            })
    # 作品目录里没有任务记录的文件（卡片删了但文件还在）也要列出来：
    # 这样「卡片只删显示、图库还看得到」才成立，图库里删掉才真正清文件
    items.extend(_orphan_assets(project_id, items))
    for entry in svc["files"].list_uploads(project_id):
        full = entry["prefix"] + entry["name"]
        items.append({
            "key": entry["key"],
            "name": entry["name"].rsplit("/", 1)[-1],
            "kind": entry["kind"],
            "source": "input",
            "url": _comfy_url("input", full),
            "ref": {"source": "input", "name": full},
            "width": entry.get("width", 0),
            "height": entry.get("height", 0),
            "caption": "本项目上传",
            "mtime": entry["mtime"],
        })
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def _orphan_assets(project_id: str, listed: list) -> list:
    """扫 <项目>_opt 目录，补上还没有任务记录的作品文件。"""
    from urllib.parse import quote, unquote

    from core.comfy_files import MEDIA_KINDS

    svc = services()
    try:
        base = svc["projects"].output_folder(project_id)
    except (KeyError, OSError):
        return []
    if not base.is_dir():
        return []

    def relative(url: str) -> str:
        if url.startswith("/api/output/"):
            parts = [unquote(part) for part in url[len("/api/output/"):].split("/") if part]
            return "/".join(parts[1:])          # 去掉项目目录名
        if url.startswith("/static/outputs/"):
            parts = [unquote(part) for part in url[len("/static/outputs/"):].split("/") if part]
            return "/".join(parts)
        return ""

    known = {relative(item["url"]) for item in listed if item.get("source") == "project"}
    rows = []
    for task_dir in sorted(base.iterdir()):
        if not task_dir.is_dir():
            continue
        for path in sorted(task_dir.iterdir()):
            if not path.is_file():
                continue
            kind = MEDIA_KINDS.get(path.suffix.lower())
            if not kind:
                continue
            rel = f"{task_dir.name}/{path.name}"
            if rel in known:
                continue
            url = (f"/api/output/{quote(base.name)}/{quote(task_dir.name)}/{quote(path.name)}")
            stat = path.stat()
            rows.append({
                "key": f"project:{url}",
                "name": path.name,
                "kind": kind,
                "source": "project",
                "url": url,
                "ref": {"source": "project", "name": url},
                "width": 0,
                "height": 0,
                "task_id": "",
                "caption": "无任务记录（卡片已移除，文件还在）",
                "mtime": int(stat.st_mtime),
            })
    return rows


@bp.get("/assets")
def assets():
    """scope=all 全部可用（ComfyUI 输入+输出）；scope=project 只显示本项目。"""
    scope = request.args.get("scope", "all")
    project_id = request.args.get("project_id") or services()["projects"].active()["id"]
    if scope == "project":
        items = _project_assets(project_id)
        return jsonify({"scope": "project", "items": items, "total": len(items)})
    try:
        data = services()["files"].list_all()
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
    items = [{
        **entry,
        "url": _comfy_url(entry["source"], entry["name"]),
        "ref": {"source": entry["source"], "name": entry["name"]},
        "caption": "输入目录" if entry["source"] == "input" else "输出目录",
    } for entry in data["items"]]
    return jsonify({"scope": "all", "items": items, "total": data["total"],
                    "fallback": data.get("fallback", False)})


@bp.get("/output/<path:relative>")
def project_output(relative):
    """项目作品文件：data/<项目名>_opt/... 下的内容。"""
    from flask import send_file
    from config import DATA_DIR
    target = DATA_DIR.joinpath(*[p for p in relative.split("/") if p]).resolve()
    if DATA_DIR.resolve() not in target.parents or not target.is_file():
        return jsonify({"error": "找不到作品文件"}), 404
    return send_file(target)


@bp.get("/comfy/file")
def comfy_file():
    source = request.args.get("source", "input")
    name = request.args.get("name", "")
    if not name:
        return jsonify({"error": "缺少文件名"}), 400
    try:
        data = services()["files"].read_bytes(source, name)
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else "png"
    # 视频/音频素材要在画布节点和预览器里直接播放，不能一律当图片回
    mime = mimetypes.guess_type(name)[0] or f"image/{suffix}"
    return Response(data, mimetype=mime, headers={"Cache-Control": "max-age=600"})


@bp.post("/comfy/delete")
def comfy_delete():
    """删除 ComfyUI 输入/输出目录里的素材文件。"""
    data = request.get_json(silent=True) or {}
    source = str(data.get("source") or "input")
    name = str(data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "缺少文件名"}), 400
    try:
        services()["files"].delete_file(source, name)
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True})


@bp.post("/references/import")
def import_references():
    """把选中的素材准备成 LoadImage 能用的名字：非输入目录的会先传进 input。"""
    data = request.get_json(silent=True) or {}
    items = data.get("items") or []
    if not items:
        return jsonify({"error": "没有选择素材"}), 400
    project_id = data.get("project_id") or services()["projects"].active()["id"]
    files = services()["files"]
    library = services()["library"]
    result = []
    try:
        for item in items:
            source = str(item.get("source") or "input")
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            if source == "library":
                # 资产库文件：读出来再走 upload，返回可直接喂给 LoadImage 的 input 名
                category, _, filename = name.rpartition("/")
                raw = library.read_bytes(category, filename or name)
                prepared = files.upload_local(project_id, filename or name, raw)
                result.append({"name": prepared, "source": "input", "origin": name})
                continue
            prepared = files.prepare_reference(source, name, project_id)
            result.append({
                "name": prepared,
                # 返回的 name 一定是可以直接给 LoadImage 用的 input 路径，
                # 不能沿用原 source（否则前端再拿 source=output 去 /view 会 404）
                "source": "input",
                "origin": name,
            })
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"items": result})


@bp.post("/references/upload")
def upload_references():
    """本地上传：直接把用户选的文件送进 ComfyUI 的 input/wwdm_ref/<项目>。"""
    project_id = request.form.get("project_id") or services()["projects"].active()["id"]
    uploads = request.files.getlist("files") or request.files.getlist("file")
    if not uploads:
        return jsonify({"error": "没有收到文件"}), 400
    files = services()["files"]
    result = []
    try:
        for upload in uploads:
            if not upload.filename:
                continue
            data = upload.read()
            if not data:
                continue
            result.append({
                "name": files.upload_local(project_id, upload.filename, data),
                "source": "input",   # 上传后就落在 input/wwdm_ref/<项目> 下
                "origin": upload.filename,
            })
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"items": result})
