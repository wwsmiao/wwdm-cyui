"""MiniMax H3 首帧生视频：一张参考图（首帧）+ 尺寸选择 → 带音频的短视频。

节点分工（改映射前先看这里）：
  114 LoadImage → 139.first_frame（首帧，模型内部自己处理缩放）
  157 ResolutionSelector 视频尺寸：aspect_ratio(比例) + megapixels(百万像素)
      → 139.width / 139.height —— 所以比例和画质都走这个节点
  141 PrimitiveFloat 时长（秒） + 156 PrimitiveFloat 帧率
      → 140 数学表达式 max(5, round(秒*帧率)) 对齐 17 帧 → 139.length
  135 UNETLoader
      ├→ 142 turbo LoRA（147 加速开关为真时走这条）
      └→ 143 ComfySwitchNode ← 155 → 154 → 153 三个普通视频 LoRA（可留空，留空即从图里摘掉）
  143/153 → 132 BasicScheduler（步数由 144 开关：145=20 步 / 146=8 步）、134 BasicGuider
  136 CLIP / 127 视频 VAE / 128 音频 VAE
  133 SamplerCustomAdvanced → 130 VAEDecode（画面）+ 129 VAEDecodeAudio（声音）→ 138 CreateVideo → 92 SaveVideo

尾帧生视频（minimax_h3_last_frame.py）与本模块只差一个输入键：139.last_frame。
"""
from workflows.base import Workflow

MIN_DURATION, MAX_DURATION = 1.0, 15.0
MIN_QUALITY, MAX_QUALITY = 0.2, 2.0

# 界面比例 → ResolutionSelector 的选项全名
RATIO_OPTIONS = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}


def _clamp(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(low, min(high, number))


class MiniMaxH3FirstFrame(Workflow):
    id = "minimax-h3-首帧生视频"
    name = "MiniMax H3 首帧生视频"
    description = "首帧 + 提示词 → 视频 · 自带音频 · 最多 3 个 LoRA"
    kind = "video"
    needs_image = True
    supports_size = True    # 比例可用：走 157 ResolutionSelector
    supports_batch = False  # 每张参考图各出一个视频
    estimate_size = False   # 提交时的像素估算没意义（尺寸由比例+百万像素决定），留空等出图回填
    graph_file = "minimax-h3-首帧生视频.json"

    # 首帧 / 尾帧工作流的唯一差异：参考图接在 139 的哪个输入上
    frame_input = "first_frame"
    # 首/尾帧只用一张参考图：多出来的图会造出重复视频，直接限死
    max_images = 1

    mapping = {
        "prompt": ["139", "inputs", "prompt"],
        "seed": ["137", "inputs", "noise_seed"],
        "duration": ["141", "inputs", "value"],
        "quality": ["157", "inputs", "megapixels"],
        "aspect_ratio": ["157", "inputs", "aspect_ratio"],
    }

    # 设置面板里的基础配置（比例 / 画质 / 时长属于每次生成的参数，放在创作框）
    param_map = {
        # 142 是图里固定接好的加速 LoRA：换 ComfyUI 实例后文件名对不上要靠这里改写
        "turbo_lora": ["142", "inputs", "lora_name"],
        "seed": ["137", "inputs", "noise_seed"],
        "fps": ["156", "inputs", "value"],
        "steps_turbo": ["146", "inputs", "value"],
        "steps_full": ["145", "inputs", "value"],
        "turbo": ["147", "inputs", "value"],
        "multiple": ["157", "inputs", "multiple"],
        "sampler_name": ["131", "inputs", "sampler_name"],
        "scheduler": ["132", "inputs", "scheduler"],
        "unet": ["135", "inputs", "unet_name"],
        "clip": ["136", "inputs", "clip_name"],
        "vae": ["127", "inputs", "vae_name"],
        "audio_vae": ["128", "inputs", "vae_name"],
    }

    # 三个普通视频 LoRA：不选就直接把节点摘掉，模型从 143 直连调度器与引导器
    lora = {
        "nodes": ["153", "154", "155"],
        "source": ["143", 0],
        "targets": [["132", "model"], ["134", "model"]],
        "strength_default": 1,
    }

    def __init__(self):
        # 参考图写进 114 LoadImage 的 image 字段；
        # 接 139.first_frame / 139.last_frame 的线在 graph 里已经接好，不需要改 key
        self.mapping = {**type(self).mapping,
                        "image": ["114", "inputs", "image"]}

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        """比例 / 画质(百万像素) / 时长 每次生成可选，宽高交给 157 计算。"""
        ratio = RATIO_OPTIONS.get(str(params.get("video_ratio") or "16:9"),
                                  RATIO_OPTIONS["16:9"])
        duration = _clamp(params.get("duration", 3), MIN_DURATION, MAX_DURATION, 3)
        quality = _clamp(params.get("quality", 1), MIN_QUALITY, MAX_QUALITY, 1)
        return {
            "prompt": prompt,
            "seed": int(seed),
            "image": params.get("image"),
            "aspect_ratio": ratio,
            "quality": round(quality, 2),
            "duration": round(duration, 2),
        }


WORKFLOW = MiniMaxH3FirstFrame()
