"""全屏 AI 对话弹窗接口。"""
from flask import Blueprint, jsonify, request

from api import services
from core.comfy import ComfyError

bp = Blueprint("chat_api", __name__, url_prefix="/api")


@bp.post("/chat")
def chat():
    data = request.get_json(silent=True) or {}
    messages = data.get("messages") or []
    if not isinstance(messages, list):
        return jsonify({"error": "messages 格式不正确"}), 400
    try:
        reply = services()["ai"].chat(messages)
        return jsonify({"reply": reply, "local": not services()["ai"].configured})
    except ComfyError as exc:
        return jsonify({"error": str(exc)}), 502
