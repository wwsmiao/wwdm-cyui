"""API 蓝图统一注册处。"""
from flask import current_app


def services() -> dict:
    return current_app.extensions["services"]


def register_blueprints(app) -> None:
    from . import (agent_api, chat_api, files_api, generate_api, library_api,
                   projects_api, system_api)

    for module in (projects_api, generate_api, system_api, chat_api, files_api,
                   library_api, agent_api):
        app.register_blueprint(module.bp)
