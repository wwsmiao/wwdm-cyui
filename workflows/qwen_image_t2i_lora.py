"""Qwen-Image 2.1 文生图（LoRA 版）：官方节点链 + KSampler 25 步，最多 5 个 LoRA。

节点分工（改映射前先看这里）：
  504 UNETLoader → 513~516 五个 LoraLoaderModelOnly → 510 QwenImage21Cache → 509 KSampler.model
  507 TextEncodeQwenImage21：prompt / negative_prompt / resolution（跟出图边长一致）
  508 EmptyLatentImage：宽高 / 张数       509 KSampler：seed / steps / cfg / 采样器 / 调度器
  511 VAEDecode → 461 SaveImageAdvanced
"""
from workflows.base import Workflow


class QwenImage21T2ILora(Workflow):
    id = "qwen-image-2.1-文生图-lora"
    name = "Qwen-Image 2.1 文生图"
    description = "Qwen 官方节点链 · 25 步采样 · 最多 5 个 LoRA"
    kind = "image"
    graph_file = "qwen-image-2.1-文生图-lora.json"

    mapping = {
        "prompt": ["507", "inputs", "prompt"],
        "negative": ["507", "inputs", "negative_prompt"],
        "width": ["508", "inputs", "width"],
        "height": ["508", "inputs", "height"],
        "batch": ["508", "inputs", "batch_size"],
        "seed": ["509", "inputs", "seed"],
        "steps": ["509", "inputs", "steps"],
        "cfg": ["509", "inputs", "cfg"],
        "sampler_name": ["509", "inputs", "sampler_name"],
        "scheduler": ["509", "inputs", "scheduler"],
        "denoise": ["509", "inputs", "denoise"],
        "resolution": ["507", "inputs", "resolution"],
        "unet": ["504", "inputs", "unet_name"],
        "clip": ["505", "inputs", "clip_name"],
        "vae": ["506", "inputs", "vae_name"],
    }

    param_map = {
        "negative": ["507", "inputs", "negative_prompt"],
        "seed": ["509", "inputs", "seed"],
        "steps": ["509", "inputs", "steps"],
        "cfg": ["509", "inputs", "cfg"],
        "sampler_name": ["509", "inputs", "sampler_name"],
        "scheduler": ["509", "inputs", "scheduler"],
        "denoise": ["509", "inputs", "denoise"],
        "resolution": ["507", "inputs", "resolution"],
        "unet": ["504", "inputs", "unet_name"],
        "clip": ["505", "inputs", "clip_name"],
        "vae": ["506", "inputs", "vae_name"],
    }

    # 五个 LoRA 槽位：504 → 513 → 514 → 515 → 517 → 516 → 510
    lora = {
        "nodes": ["513", "514", "515", "517", "516"],
        "source": ["504", 0],
        "target_node": "510",
        "target_input": "model",
        "strength_default": 1,
    }

    def values(self, prompt: str, params: dict, seed: int, negative: str | None) -> dict:
        result = super().values(prompt, params, seed, negative)
        width = int(result.get("width") or 1024)
        height = int(result.get("height") or 1024)
        result["resolution"] = max(width, height)
        return result


WORKFLOW = QwenImage21T2ILora()
