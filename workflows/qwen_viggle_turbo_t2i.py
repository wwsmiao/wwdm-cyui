"""Qwen-Image 2.1 Viggle Turbo 文生图：6 步蒸馏 LoRA + 3 个附加 LoRA，无 CFG。

节点分工（改映射前先看这里）：
  2 UNETLoader → 3 ViggleTurboLora（v0.2.1 / 6 步）
      → 26 → 27 → 28 LoraLoaderModelOnly（附加 LoRA，可空）→ 19 BasicGuider.model
  4 CLIPLoader（qwen_image）→ 18 TextEncodeQwenImage21
  5 VAELoader → 18.vae / 24.vae
  6 用户提示词 → 18.prompt       8 EmptyLatentImage：宽高 / 张数（也给 22 提供 latent）
  18 文本编码 → 19 BasicGuider → 23 SamplerCustomAdvanced
      （20 噪声 / 21 采样器 / 22 ViggleTurboSigmas 六步 sigmas）
  23 → 24 VAEDecode → 25 SaveImage

和 Qwen-Image 2.1 Turbo 文生图的区别：
  · 不用 CFGGuider，走 BasicGuider + 手写 sigmas（6 步），必须配 viggle turbo LoRA
  · 有 3 个附加 LoRA 槽位（26/27/28），设置面板里选，不选就从图里摘掉；
    图里三个槽填的是同一份 xiaqian，实测叠 3 层会过曝发虚，所以默认只沿用 26 一个
  · 没有提示词改写链路，提示词原样进文本编码
"""
from workflows.base import Workflow, resolve_params_size


class QwenImage21ViggleTurbo(Workflow):
    id = "qwen-image-2.1-viggle-turbo-文生图"
    name = "Qwen-Image 2.1 Viggle Turbo 文生图"
    description = "6 步蒸馏 LoRA · 无 CFG · 最多 3 个附加 LoRA"
    kind = "image"
    graph_file = "qwen-image-2.1-viggle-turbo-文生图.json"

    mapping = {
        "prompt": ["6", "inputs", "value"],
        "negative": ["18", "inputs", "negative_prompt"],
        "width": ["8", "inputs", "width"],
        "height": ["8", "inputs", "height"],
        "batch": ["8", "inputs", "batch_size"],
        "seed": ["20", "inputs", "noise_seed"],
    }

    # 设置里能调的（比例 / 张数在创作区选，不放这里）
    param_map = {
        "unet": ["2", "inputs", "unet_name"],
        "clip": ["4", "inputs", "clip_name"],
        "clip_type": ["4", "inputs", "type"],
        "vae": ["5", "inputs", "vae_name"],
        "lora_name": ["3", "inputs", "lora_name"],
        "lora_strength": ["3", "inputs", "strength"],
        "sigmas": ["22", "inputs", "nodes"],
        "sampler_name": ["21", "inputs", "sampler_name"],
        "resolution": ["18", "inputs", "resolution"],
        "seed": ["20", "inputs", "noise_seed"],
    }

    option_sources = {
        "lora_name": ("ViggleTurboLora", "lora_name"),
        "sampler_name": ("KSamplerSelect", "sampler_name"),
        "clip_type": ("CLIPLoader", "type"),
    }

    # 三个附加 LoRA 槽位：3 → 26 → 27 → 28 → 19
    lora = {
        "nodes": ["26", "27", "28"],
        "source": ["3", 0],
        "target_node": "19",
        "target_input": "model",
        "strength_default": 1,
    }
    # 图里 26/27/28 都接的同一份 xiaqian：默认只沿用第 1 个
    # （实测三份同 LoRA 叠在一起画面会过曝发虚），后两个槽位留给用户放别的 LoRA
    lora_keep = ("26",)

    settings_fields = [
        {"key": "unet", "label": "UNet 模型", "type": "select", "full": True},
        {"key": "clip", "label": "CLIP 模型", "type": "select", "full": True},
        {"key": "clip_type", "label": "CLIP 类型", "type": "select"},
        {"key": "vae", "label": "VAE 模型", "type": "select"},
        {"key": "lora_name", "label": "Viggle 加速 LoRA（6 步）", "type": "select", "full": True},
        {"key": "lora_strength", "label": "加速 LoRA 强度", "type": "number"},
        {"key": "lora", "label": "附加 LoRA（最多 3 个，不选则跳过）", "type": "lora", "full": True},
        {"key": "sampler_name", "label": "采样器", "type": "select"},
        {"key": "sigmas", "label": "采样节点（逗号分隔，6 步）", "type": "text", "full": True},
        {"key": "resolution", "label": "文本编码分辨率", "type": "number"},
        {"key": "seed", "label": "种子（-1 = 每次随机）", "type": "number"},
    ]

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        """比例 / 分辨率 → 宽高（EmptyLatentImage 直接吃宽高）；宽高也用来估算作品卡。"""
        width, height = resolve_params_size(params)
        try:
            batch = max(1, int(params.get("batch", 1)))
        except (TypeError, ValueError):
            batch = 1
        return {
            "prompt": prompt,
            "negative": negative,
            "seed": int(seed),
            "width": width,
            "height": height,
            "batch": batch,
        }


WORKFLOW = QwenImage21ViggleTurbo()
