# -*- coding: utf-8 -*-
"""CYUI - 对话式 ComfyUI 创作前端

启动（本机约定：一律使用 ComfyUI 内嵌 Python 环境）：
    C:\\ComfyUI\\python312\\python.exe D:\\wwdm-cyui\\run.py

浏览器访问： http://127.0.0.1:7871
"""
import os
import sys

# ComfyUI 内嵌 Python 处于 ._pth 安全路径模式，脚本目录不会自动进 sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    from app import comfy

    print("=" * 62)
    print("  CYUI  ·  对话式 ComfyUI 创作台")
    print("  网页   http://127.0.0.1:7871")
    print("  后端   " + comfy.base() + "   （可在设置页修改）")
    print("=" * 62)
    comfy.log("CYUI 服务启动", "INFO")
    app.run(host="127.0.0.1", port=7871, threaded=True, debug=False, use_reloader=False)
