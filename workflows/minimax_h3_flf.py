"""MiniMax H3 首尾帧生视频：首帧 + 尾帧 + 提示词 → 带音频的短视频。

与首帧 / 尾帧生视频的区别：一次要吃两张图——
  158 LoadImage → 139.first_frame（首帧）
  114 LoadImage → 139.last_frame（尾帧）
其余节点（尺寸 157 / 时长 141 / 帧率 156 / LoRA 143·153·154·155）与首帧版完全一致。
"""
from workflows.minimax_h3_i2v import MiniMaxH3FirstFrame


class MiniMaxH3FirstLastFrame(MiniMaxH3FirstFrame):
    id = "minimax-h3-首尾帧生视频"
    name = "MiniMax H3 首尾帧生视频"
    description = "首帧 + 尾帧 + 提示词 → 视频（指定起止画面）· 自带音频 · 最多 3 个 LoRA"
    graph_file = "minimax-h3-首尾帧生视频.json"
    needs_image = True
    # 首帧 + 尾帧两张图，一次任务吃两张，不按图拆任务
    max_images = 2
    images_per_task = 2
    min_images = 2

    def __init__(self):
        # 138 是 139，先帧放 first_frame，尾帧放 last_frame，各自写进自己的 LoadImage
        self.mapping = {**type(self).mapping,
                        "image": ["158", "inputs", "image"],
                        "image2": ["114", "inputs", "image"]}

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        result = super().values(prompt, params, seed, negative)
        result["image2"] = params.get("image2")
        return result


WORKFLOW = MiniMaxH3FirstLastFrame()
