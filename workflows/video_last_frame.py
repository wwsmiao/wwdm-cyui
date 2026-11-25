"""视频尾帧（工具型工作流）：给作品记录一个像样的名字，本身不执行。

真正的提取在 core/video_frames.py 里（本地 ffmpeg 解一帧），这个模块只负责：
  · 卡片 / 画布里显示「视频尾帧」而不是一串 workflow id
  · 不出现在创作区 / 画布的工作流下拉里（category = tool）
"""
from workflows.base import Workflow


class VideoLastFrame(Workflow):
    id = "video-last-frame"
    name = "视频尾帧"
    description = "取视频最后一帧存成图片（本地 ffmpeg，不走 ComfyUI）"
    kind = "image"
    engine = "python"
    category = "tool"
    needs_image = False
    supports_prompt = False
    supports_size = False
    supports_batch = False
    estimate_size = False
    graph_file = ""


WORKFLOW = VideoLastFrame()
