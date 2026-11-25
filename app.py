"""创作台入口： flask --app app run 或直接 python app.py。"""
from flask import Flask, render_template

from api import register_blueprints
from config import ensure_dirs
from core import build_services


def create_app() -> Flask:
    ensure_dirs()
    app = Flask(__name__, template_folder="templates", static_folder="static")
    # 开发期禁止静态资源强缓存，改了 css/js 刷新即生效
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.extensions["services"] = build_services()
    register_blueprints(app)

    @app.get("/")
    def index():
        return render_template("index.html")

    return app


app = create_app()

if __name__ == "__main__":
    try:
        app.run(host="127.0.0.1", port=7860, debug=False, threaded=True)
    finally:
        # 退出前把连到 ComfyUI 的 WebSocket 走一次关闭握手：
        # 否则 ComfyUI 的 sockets 里会留下"半开"连接，每次广播进度都刷
        # “send error: Cannot write to closing transport”
        bus = (app.extensions.get("services") or {}).get("bus")
        if bus:
            bus.stop()
            import time
            time.sleep(1.2)   # 给读循环一个超时周期去关连接
