"""AI Agent 接口：配置、模型列表、对话、连通性测试。"""
from flask import Blueprint, jsonify, request

from api import services
from core.agent import AgentError

bp = Blueprint("agent_api", __name__, url_prefix="/api/agent")

OVERRIDE_KEYS = ("base_url", "api_key", "model")


def _svc():
    return services()["agent"]


def _override(data: dict) -> dict:
    """允许「还没保存就先试」：只取接口地址 / Key / 模型三项。"""
    return {key: data[key] for key in OVERRIDE_KEYS if isinstance(data.get(key), str)}


@bp.get("/config")
def get_config():
    return jsonify(_svc().config())


@bp.post("/config")
def save_config():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(_svc().save(data))
    except AgentError as exc:
        return jsonify({"error": str(exc)}), 400


@bp.get("/models")
def list_models():
    try:
        return jsonify({"models": _svc().models()})
    except AgentError as exc:
        return jsonify({"error": str(exc)}), 400


@bp.post("/models")
def list_models_with_override():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify({"models": _svc().models(_override(data))})
    except AgentError as exc:
        return jsonify({"error": str(exc)}), 400


@bp.post("/chat")
def chat():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(_svc().chat(data.get("messages"), _override(data), data.get("tools")))
    except AgentError as exc:
        return jsonify({"error": str(exc)}), 400


@bp.post("/test")
def test_connection():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(_svc().test(_override(data)))
    except AgentError as exc:
        return jsonify({"error": str(exc)}), 400
