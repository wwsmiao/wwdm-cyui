"""MiniMax H3 多参考生视频：最多 9 张参考图 + 3 个参考视频 + 3 段参考音频 → 带声音的视频。

节点分工（改映射前先看这里）：
  127 UNETLoader
    ├→ 145 turbo LoRA（146 加速开关为真时走这条）
    └→ 141 ComfySwitchNode ← 146 —— 再串 170 → 168 → 169 三个普通 LoRA
  141/169 → 124 BasicScheduler（步数由 142 开关：143=20 步 / 144=4 步）+ 126 BasicGuider
  128 CLIP（minimax）/ 119 视频 VAE / 120 音频 VAE
  136 MiniMaxH3ReferenceToVideo：prompt / width / height（115 ResolutionSelector）/
       length（= 时长 × 帧率，对齐 17 帧）/ ref_image_size /
       ref_images.ref_image_0..8 → LoadImage 137/139/154/155/158/159/160/161/162
       ref_videos.ref_video_0..2 + ref_video_audios.* → LoadVideo 151/163/165 + GetVideoComponents 152/164/166
       ref_audios.ref_audio_0..2 → LoadAudio 153/157/156
  125 SamplerCustomAdvanced（129 噪声 / 123 采样器 / 124 sigmas）→ 122 VAEDecode + 121 VAEDecodeAudio
      → 130 CreateVideo（fps 来自 132）→ 92 SaveVideo

和其他视频工作流的区别：
  · 参考素材是「多模态」的：图 9 / 视频 3 / 音频 3，全部塞进同一个任务（images_per_task=9，不按图拆）
  · 没用到的槽位必须从 136 的 ref_* 输入里摘掉、并把对应的 Load 节点删掉，
    否则空文件名会让 ComfyUI 直接报 Invalid image/video file
  · 视频槽的音频（GetVideoComponents 的第 2 个输出）会一起作为参考音轨传进去
"""
from workflows.base import Workflow

MIN_DURATION, MAX_DURATION = 1.0, 24.0
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

# 参考素材槽位：参数键 ↔ 图里的节点（顺序就是界面上的编号）
IMAGE_SLOTS = [
    ("image", "137"), ("image2", "139"), ("image3", "154"),
    ("image4", "155"), ("image5", "158"), ("image6", "159"),
    ("image7", "160"), ("image8", "161"), ("image9", "162"),
]
VIDEO_SLOTS = [
    ("video", ("151", "152")), ("video2", ("163", "164")), ("video3", ("165", "166")),
]
AUDIO_SLOTS = [("audio", "153"), ("audio2", "157"), ("audio3", "156")]


def _clamp(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(low, min(high, number))


class MiniMaxH3MultiRef(Workflow):
    id = "minimax-h3-多参考生视频"
    name = "MiniMax H3 多参考生视频"
    description = "最多 9 图 + 3 视频 + 3 音频作参考 · 带配音 · 最多 3 个 LoRA"
    kind = "video"
    needs_image = True       # 至少要一张参考图（其余视频 / 音频可选）
    min_images = 1
    max_images = 9
    max_videos = 3
    max_audios = 3
    images_per_task = 9      # 所有参考素材一起进同一个任务，不按图拆
    supports_size = True     # 比例可用，走 115 ResolutionSelector
    supports_batch = False
    estimate_size = False    # 帧数/尺寸由工作流自己算，提交时的像素估算没意义
    graph_file = "minimax-h3-多参考生视频.json"

    mapping = {
        "prompt": ["138", "inputs", "value"],
        "seed": ["129", "inputs", "noise_seed"],
        "aspect_ratio": ["115", "inputs", "aspect_ratio"],
        "quality": ["115", "inputs", "megapixels"],
    }

    param_map = {
        "unet": ["127", "inputs", "unet_name"],
        "clip": ["128", "inputs", "clip_name"],
        "vae": ["119", "inputs", "vae_name"],
        "audio_vae": ["120", "inputs", "vae_name"],
        "sampler_name": ["123", "inputs", "sampler_name"],
        "scheduler": ["124", "inputs", "scheduler"],
        "steps_full": ["143", "inputs", "value"],
        "steps_turbo": ["144", "inputs", "value"],
        "turbo": ["146", "inputs", "value"],
        "turbo_lora": ["145", "inputs", "lora_name"],
        "turbo_strength": ["145", "inputs", "strength_model"],
        "fps": ["132", "inputs", "value"],
        "multiple": ["115", "inputs", "multiple"],
        "ref_image_size": ["136", "inputs", "ref_image_size"],
        "seed": ["129", "inputs", "noise_seed"],
    }

    option_sources = {
        "sampler_name": ("KSamplerSelect", "sampler_name"),
        "scheduler": ("BasicScheduler", "scheduler"),
        "turbo_lora": ("LoraLoaderModelOnly", "lora_name"),
        "ref_image_size": ("MiniMaxH3ReferenceToVideo", "ref_image_size"),
        "clip_type": ("CLIPLoader", "type"),
    }

    # 三个普通 LoRA：141 → 170 → 168 → 169 → 126
    lora = {
        "nodes": ["170", "168", "169"],
        "source": ["141", 0],
        "target_node": "126",
        "target_input": "model",
        "strength_default": 1,
    }
    # 图里本来接了 3 个 Kook_Zimage_瑶光（同一份叠 3 层加强角色），默认沿用；
    # 不想要就在设置里把槽位改成「不使用」，或者直接删掉这条声明
    lora_keep = ("170", "168", "169")

    settings_fields = [
        {"key": "unet", "label": "视频 UNet", "type": "select", "full": True},
        {"key": "clip", "label": "CLIP / 文本编码器", "type": "select", "full": True},
        {"key": "vae", "label": "视频 VAE", "type": "select"},
        {"key": "audio_vae", "label": "音频 VAE", "type": "select"},
        {"key": "turbo", "label": "加速 LoRA（4 步）", "type": "bool"},
        {"key": "steps_turbo", "label": "加速步数", "type": "number"},
        {"key": "steps_full", "label": "普通步数", "type": "number"},
        {"key": "turbo_lora", "label": "加速 LoRA 文件", "type": "select", "full": True},
        {"key": "turbo_strength", "label": "加速 LoRA 强度", "type": "number"},
        {"key": "sampler_name", "label": "采样器", "type": "select"},
        {"key": "scheduler", "label": "调度器", "type": "select"},
        {"key": "fps", "label": "帧率", "type": "number", "hint": "帧数 = 时长 × 帧率，再对齐到 17 帧"},
        {"key": "multiple", "label": "尺寸对齐步长", "type": "number"},
        {"key": "ref_image_size", "label": "参考图尺寸处理", "type": "select"},
        {"key": "lora", "label": "附加 LoRA（最多 3 个，不选则跳过）", "type": "lora", "full": True},
        {"key": "seed", "label": "种子（-1 = 每次随机）", "type": "number"},
    ]

    def __init__(self):
        # 参考素材：image→137 / image2→139 …… video→LoadVideo 151 / audio→LoadAudio 153
        mapping = dict(type(self).mapping)
        for key, node_id in IMAGE_SLOTS:
            mapping[key] = [node_id, "inputs", "image"]
        for key, (loader, _components) in VIDEO_SLOTS:
            mapping[key] = [loader, "inputs", "file"]
        for key, node_id in AUDIO_SLOTS:
            mapping[key] = [node_id, "inputs", "audio"]
        self.mapping = mapping

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        """比例 / 画质(百万像素) / 时长 每次生成可选；宽高交给 115，帧数在 build 里算。"""
        ratio = RATIO_OPTIONS.get(str(params.get("video_ratio") or "16:9"),
                                  RATIO_OPTIONS["16:9"])
        quality = _clamp(params.get("quality", 1), MIN_QUALITY, MAX_QUALITY, 1)
        result = {
            "prompt": prompt,
            "seed": int(seed),
            "aspect_ratio": ratio,
            "quality": round(quality, 2),
        }
        for key, _node in IMAGE_SLOTS + [(k, v[0]) for k, v in VIDEO_SLOTS] + AUDIO_SLOTS:
            value = params.get(key)
            if str(value or "").strip():
                result[key] = value
        return result

    def duration_of(self, params: dict) -> float:
        return _clamp((params or {}).get("duration", 3), MIN_DURATION, MAX_DURATION, 3)

    def build(self, prompt: str, params: dict | None = None, seed: int = 42,
              negative: str | None = None, workflow_params: dict | None = None) -> dict | None:
        graph = super().build(prompt, params, seed, negative, workflow_params)
        if graph is None:
            return None
        nodes = self.nodes_of(graph)
        params = params or {}
        encoder = nodes.get("136")
        if encoder is None:
            return graph
        inputs = encoder.setdefault("inputs", {})

        # 1) 帧数 = 时长 × 帧率，再对齐到 17 帧（同原图里那条数学表达式）
        try:
            fps = float(nodes["132"]["inputs"]["value"])
        except (KeyError, TypeError, ValueError):
            fps = 16.0
        fps = fps if fps > 0 else 16.0
        frames = max(5, int(round(self.duration_of(params) * fps)))
        frames += (5 - (frames % 17)) % 17
        inputs["length"] = frames

        # 2) 没用到的参考素材槽：从 136 上摘掉对应输入，并把 Load 节点删掉
        for index, (key, node_id) in enumerate(IMAGE_SLOTS):
            if str(params.get(key) or "").strip():
                continue
            inputs.pop(f"ref_images.ref_image_{index}", None)
            nodes.pop(node_id, None)

        for index, (key, (loader, components)) in enumerate(VIDEO_SLOTS):
            if str(params.get(key) or "").strip():
                continue
            inputs.pop(f"ref_videos.ref_video_{index}", None)
            inputs.pop(f"ref_video_audios.ref_video_audio_{index}", None)
            nodes.pop(components, None)
            nodes.pop(loader, None)

        for index, (key, node_id) in enumerate(AUDIO_SLOTS):
            if str(params.get(key) or "").strip():
                continue
            inputs.pop(f"ref_audios.ref_audio_{index}", None)
            nodes.pop(node_id, None)

        return graph


WORKFLOW = MiniMaxH3MultiRef()
