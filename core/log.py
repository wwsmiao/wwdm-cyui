"""运行日志：只打印「用户操作」和「任务开始 / 结束」。

启动过程（事件总线连接、目录迁移、启动找回）、模型名适配、素材补录这些内部动静
全部不打印，控制台留给用户看得懂的两类信息：

    16:40:12 [操作] 提交生成任务（200）
    16:40:12 [任务] 开始 #t_ab12cd34「Z-Image Turbo 文生图」
    16:40:35 [任务] 完成 #t_ab12cd34「Z-Image Turbo 文生图」 23.4s · 1 个文件
    16:41:02 [任务] 失败 #t_deadbeef「MiniMax H3 首帧生视频」 5.1s · 模型不在列表里
"""
import time


def _emit(tag: str, text: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {tag} {text}", flush=True)


def action(text: str) -> None:
    _emit("[操作]", text)


def task_start(task_id: str, workflow: str) -> None:
    _emit("[任务]", f"开始 #{task_id}「{workflow}」")


def task_done(task_id: str, workflow: str, seconds: float, files: int = 0) -> None:
    tail = f"{files} 个文件" if files else "无产出文件"
    _emit("[任务]", f"完成 #{task_id}「{workflow}」 {seconds:.1f}s · {tail}")


def task_failed(task_id: str, workflow: str, seconds: float, error: str = "") -> None:
    reason = " ".join(str(error or "").split())[:160]
    _emit("[任务]", f"失败 #{task_id}「{workflow}」 {seconds:.1f}s · {reason or '未知错误'}")


def task_cancelled(task_id: str, workflow: str) -> None:
    _emit("[任务]", f"取消 #{task_id}「{workflow}」")


# ---------- 用户操作 ----------
# 只记「有实际动作」的写请求；轮询、静态资源、画布自动保存这些不打印
_ACTION_RULES = [
    ("POST", r"^/api/generate$", "提交生成任务"),
    ("POST", r"^/api/prompt/run$", "生成提示词"),
    ("POST", r"^/api/references/upload$", "上传素材"),
    ("POST", r"^/api/references/import$", "导入素材"),
    ("POST", r"^/api/images/edit$", "本地图片编辑"),
    ("POST", r"^/api/images/delete$", "删除图片"),
    ("POST", r"^/api/tasks/[^/]+/cancel$", "取消任务"),
    ("POST", r"^/api/tasks/[^/]+/reclaim$", "找回结果"),
    ("POST", r"^/api/tasks/[^/]+/media-name$", "重命名素材"),
    ("DELETE", r"^/api/tasks/[^/]+$", "删除作品记录"),
    ("POST", r"^/api/projects$", "新建项目"),
    ("POST", r"^/api/projects/batch-delete$", "批量删除项目"),
    ("POST", r"^/api/projects/[^/]+/duplicate$", "复制项目"),
    ("POST", r"^/api/projects/[^/]+/activate$", "切换项目"),
    ("PATCH", r"^/api/projects/[^/]+$", "重命名项目"),
    ("DELETE", r"^/api/projects/[^/]+$", "删除项目"),
    ("PUT", r"^/api/projects/[^/]+/notes$", "保存笔记"),
    ("POST", r"^/api/settings$", "保存设置"),
    ("POST", r"^/api/workflows/[^/]+/params$", "保存工作流参数"),
    ("POST", r"^/api/agent/chat$", "AI 对话"),
    ("POST", r"^/api/agent/config$", "保存 Agent 配置"),
    ("POST", r"^/api/agent/test$", "测试 Agent 连接"),
    ("POST", r"^/api/deepseek/models$", "获取模型列表"),
    ("PUT", r"^/api/prompt-templates$", "保存提示词模版"),
    ("POST", r"^/api/library", "资产库操作"),
    ("PATCH", r"^/api/library", "修改资产库"),
    ("DELETE", r"^/api/library", "删除资产库内容"),
    ("POST", r"^/api/comfy/interrupt$", "中断 ComfyUI"),
    ("POST", r"^/api/comfy/delete$", "删除素材文件"),
]

_ACTION_SKIP = (
    r"^/api/projects/[^/]+/layout$",   # 画布自动保存，拖一下节点就发一次
)


def action_label(method: str, path: str) -> str | None:
    """把请求翻译成一句人话；GET / 静态资源 / 自动保存返回 None（不打印）。"""
    import re

    if method in ("GET", "HEAD", "OPTIONS"):
        return None
    if any(re.match(pattern, path) for pattern in _ACTION_SKIP):
        return None
    for rule_method, pattern, label in _ACTION_RULES:
        if method == rule_method and re.match(pattern, path):
            return label
    return f"{method} {path}"
