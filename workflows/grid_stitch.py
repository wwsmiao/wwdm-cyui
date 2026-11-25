"""网格拼接：纯 Python 实现，不经过 ComfyUI。

把参考图按顺序（从左到右、从上到下）拼成 a×b 的网格长图，每张图都按原始像素贴上去，
不缩放、不重采样，所以画质不会被改动。行数 / 列数由创作区的「网格 a × b」决定，
比如 4 张图配 1×4 就是一行四列的横向长图。

格子大小怎么定（为了「不改画质」又不至于重叠）：
  · 第 c 列的宽度 = 这一列里最宽的那张图；第 r 行的高度 = 这一行里最高的那张图
  · 图在自己的格子里居中，尺寸不一的图会留出空白（透明），但绝不做缩放
  · 所有图尺寸一致时，结果就是标准等分网格

具体拼接逻辑在 core/grid_stitch.py；这个模块只负责声明能力，让工作流列表 / 创作区认得它。
"""
from workflows.base import Workflow


class GridStitch(Workflow):
    id = "grid-拼接"
    name = "网格拼接"
    description = "纯 Python 拼接 · 按行×列排图 · 原图像素不缩放"
    kind = "image"
    engine = "python"        # 后端自己算，不提交 ComfyUI
    needs_image = True
    min_images = 1
    max_images = 48
    images_per_task = 48     # 所有参考图一起拼，不按图拆任务
    supports_prompt = False  # 没有提示词，只排图
    supports_size = False    # 输出尺寸由图片和网格决定
    supports_batch = False
    estimate_size = False
    graph_file = ""          # 没有 ComfyUI 图

    # 创作区「生成参数」里只留这一组：行 × 列
    grid = {"rows": 1, "cols": 4, "max_rows": 6, "max_cols": 8}


WORKFLOW = GridStitch()
