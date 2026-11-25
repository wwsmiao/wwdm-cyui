"""创作台入口： flask --app app run 或直接 python app.py。

控制台只保留两类日志（见 core/log.py）：
  · 用户操作（提交生成、删作品、改设置……）
  · 任务开始 / 结束（含耗时与产出）
启动过程、事件总线、模型名适配这些内部动静一律不打印。
"""
import logging

from flask import Flask, render_template, request

from api import register_blueprints
from config import ensure_dirs
from core import build_services
from core.log import action, action_label


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

    @app.after_request
    def log_user_action(response):
        """用户操作日志：只记有实际动作的写请求，轮询和静态资源不打印。"""
        label = action_label(request.method, request.path)
        if label:
            action(f"{label}（{response.status_code}）")
        return response

    return app


app = create_app()

# werkzeug 默认每个请求打一行，任务进度轮询会刷屏；压到 WARNING 就够了
logging.getLogger("werkzeug").setLevel(logging.WARNING)

if __name__ == "__main__":
    from werkzeug.serving import make_server

    # 用 make_server 而不是 app.run：不打印 "Serving Flask app / Running on ..." 启动横幅
    server = make_server("127.0.0.1", 7860, app, threaded=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # 退出前把连到 ComfyUI 的 WebSocket 走一次关闭握手：
        # 否则 ComfyUI 的 sockets 里会留下"半开"连接，每次广播进度都刷
        # “send error: Cannot write to closing transport”
        bus = (app.extensions.get("services") or {}).get("bus")
        if bus:
            bus.stop()
            import time
            time.sleep(1.2)   # 给读循环一个超时周期去关连接
