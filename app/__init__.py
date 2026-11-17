# -*- coding: utf-8 -*-
"""CYUI 应用包"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 数据目录允许用环境变量顶掉：多开一个实例做验证时指向临时目录，
# 就不会和正在跑的实例抢同一份 history.json（这是踩过的真实事故）
DATA_DIR = os.environ.get("CYUI_DATA_DIR") or os.path.join(ROOT, "data")
RESULTS_DIR = os.path.join(DATA_DIR, "results")
TEMPLATES_DIR = os.path.join(ROOT, "templates")
STATIC_DIR = os.path.join(ROOT, "static")


def create_app():
    from flask import Flask
    from . import comfy, store

    for d in (DATA_DIR, RESULTS_DIR):
        os.makedirs(d, exist_ok=True)

    app = Flask(
        __name__,
        template_folder=TEMPLATES_DIR,
        static_folder=STATIC_DIR,
        static_url_path="/static",
    )
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024
    # session 密钥持久化：随机生成一次存进 config.json，重启后登录态不失效
    try:
        import secrets as _secrets
        _sk = config.get("flask_secret_key")
        if not _sk:
            _sk = _secrets.token_hex(32)
            config.set_many({"flask_secret_key": _sk})
        app.config["SECRET_KEY"] = _sk
    except Exception:
        pass
    # debug=False 时 Jinja 会缓存编译后的模板，改 index.html 必须重启才生效。
    # 这是本地开发型工具，开启自动重载，改完模板刷新即可看到。
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.jinja_env.auto_reload = True
    app.json.ensure_ascii = False

    store.init()
    comfy.init_app(app)

    from .routes import bp, start_reconciler
    app.register_blueprint(bp)
    start_reconciler()
    return app
