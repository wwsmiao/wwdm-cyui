"""资产库接口：分类（文件夹）与资产的增删改查，以及文件读取。"""
import mimetypes

from flask import Blueprint, Response, jsonify, request

from core.comfy import ComfyError
from . import services

bp = Blueprint("library", __name__, url_prefix="/api/library")


def _library():
    return services()["library"]


def _guard(fn):
    """统一把 ComfyError 转成 400，前端直接提示。"""
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ComfyError as exc:
            return jsonify({"error": str(exc)}), 400
        except (ValueError, OSError) as exc:
            return jsonify({"error": str(exc)}), 400
    wrapper.__name__ = fn.__name__
    return wrapper


@bp.get("/assets")
def list_assets():
    category = request.args.get("category", "")
    lib = _library()
    items = lib.items(category)
    return jsonify({
        "categories": lib.categories(),
        "items": items,
        "total": len(items),
        "scope": "library",
    })


@bp.post("/categories")
@_guard
def create_category():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().create_category(data.get("name") or ""))


@bp.patch("/categories")
@_guard
def rename_category():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().rename_category(data.get("name") or "", data.get("to") or ""))


@bp.post("/categories/copy")
@_guard
def copy_category():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().copy_category(data.get("name") or "", data.get("to") or ""))


@bp.delete("/categories")
@_guard
def delete_category():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().delete_category(data.get("name") or ""))


@bp.post("/items")
@_guard
def add_item():
    data = request.get_json(silent=True) or {}
    source = str(data.get("source") or "project")
    name = str(data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "缺少素材地址"}), 400
    return jsonify(_library().add(source, name, data.get("category") or "",
                                  data.get("title") or ""))


@bp.patch("/items/rename")
@_guard
def rename_item():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().rename_item(
        data.get("category") or "", data.get("name") or "", data.get("to") or ""))


@bp.patch("/items")
@_guard
def move_item():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().move(
        data.get("category") or "", data.get("name") or "", data.get("to") or ""))


@bp.post("/items/copy")
@_guard
def copy_item():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().copy_item(
        data.get("category") or "", data.get("name") or "", data.get("to") or ""))


@bp.delete("/items")
@_guard
def delete_item():
    data = request.get_json(silent=True) or {}
    return jsonify(_library().remove(data.get("category") or "", data.get("name") or ""))


@bp.post("/prompts")
@_guard
def save_prompt():
    """提示词工作流生成的文本：每次存一份 .txt 到资产库「提示词」分类。"""
    data = request.get_json(silent=True) or {}
    return jsonify(_library().save_text(data.get("text") or "",
                                       data.get("title") or "")), 201


@bp.get("/file")
def library_file():
    category = request.args.get("category", "")
    name = request.args.get("name", "")
    try:
        path = _library().file_path(category, name)
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 404
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if mime.startswith("text/"):
        mime += "; charset=utf-8"      # 中文提示词不指定编码会乱码
    return Response(path.read_bytes(), mimetype=mime,
                    headers={"Cache-Control": "max-age=300"})
