"""MiniMax H3 尾帧生视频：一张参考图（尾帧）+ 尺寸选择 → 带音频的短视频。

与首帧生视频（minimax_h3_i2v.py）的**唯一差异**：参考图接在 139.last_frame
（视频以这张图为终点生成动作），其余参数完全一致。
"""
from workflows.minimax_h3_i2v import MiniMaxH3FirstFrame


class MiniMaxH3LastFrame(MiniMaxH3FirstFrame):
    id = "minimax-h3-尾帧生视频"
    name = "MiniMax H3 尾帧生视频"
    description = "尾帧 + 提示词 → 视频（以参考图为终点）· 最多 3 个 LoRA"
    frame_input = "last_frame"
    graph_file = "minimax-h3-尾帧生视频.json"


WORKFLOW = MiniMaxH3LastFrame()
