"""Qwen-Image 2.1 Turbo 文生图：官方节点链，8 步采样（ManualSigmas），最多 5 个 LoRA。

节点分工（改映射前先看这里）：
  491 UNETLoader → 508~511 五个 LoraLoaderModelOnly → 507 QwenImage21Cache
  507 → 506 CFGGuider（cfg / 正负提示词）
  492 TextEncodeQwenImage21：prompt / negative_prompt / resolution（跟出图边长一致）
  495 EmptyLatentImage：宽高 / 张数       505 RandomNoise：seed
  502 ManualSigmas（固定 8 步）           504 KSamplerSelect：采样器
  503 SamplerCustomAdvanced → 496 VAEDecode → 461 SaveImageAdvanced
"""
from workflows.base import Workflow


class QwenImage21TurboT2I(Workflow):
    id = "qwen-image-2.1-文生图"
    name = "Qwen-Image 2.1 Turbo 文生图"
    description = "Qwen 官方节点链 · 8 步快速出图 · 最多 5 个 LoRA"
    kind = "image"
    graph_file = "qwen-image-2.1-文生图.json"

    mapping = {
        "prompt": ["492", "inputs", "prompt"],
        "negative": ["492", "inputs", "negative_prompt"],
        "width": ["495", "inputs", "width"],
        "height": ["495", "inputs", "height"],
        "batch": ["495", "inputs", "batch_size"],
        "seed": ["505", "inputs", "noise_seed"],
        "resolution": ["492", "inputs", "resolution"],
        "cfg": ["506", "inputs", "cfg"],
        "sampler_name": ["504", "inputs", "sampler_name"],
        "unet": ["491", "inputs", "unet_name"],
        "clip": ["493", "inputs", "clip_name"],
        "vae": ["494", "inputs", "vae_name"],
    }

    param_map = {
        "negative": ["492", "inputs", "negative_prompt"],
        "seed": ["505", "inputs", "noise_seed"],
        "cfg": ["506", "inputs", "cfg"],
        "sampler_name": ["504", "inputs", "sampler_name"],
        "resolution": ["492", "inputs", "resolution"],
        "unet": ["491", "inputs", "unet_name"],
        "clip": ["493", "inputs", "clip_name"],
        "vae": ["494", "inputs", "vae_name"],
    }

    # 五个 LoRA 槽位串成一条链：491 → 508 → 509 → 510 → 512 → 511 → 507
    lora = {
        "nodes": ["508", "509", "510", "512", "511"],
        "source": ["491", 0],
        "target_node": "507",
        "target_input": "model",
        "strength_default": 1,
    }

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        result = super().values(prompt, params, seed, negative)
        # TextEncodeQwenImage21 的 resolution 要跟实际出图边长对齐
        width = int(result.get("width") or 1024)
        height = int(result.get("height") or 1024)
        result["resolution"] = max(width, height)
        return result


WORKFLOW = QwenImage21TurboT2I()
