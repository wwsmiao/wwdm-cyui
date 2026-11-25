"""Z-Image-Turbo 图生图：参考图 + 重绘，最多 5 个 LoRA。

和文生图的区别：
  · 尺寸由参考图决定，所以 supports_size=False（比例/分辨率/自定义宽高全部忽略）
  · 每张参考图各提交一个任务，所以 supports_batch=False（生成张数忽略）
  · 79 LoadImage 读参考图，denoise 决定改动幅度（默认 0.55，越小越像原图）
节点分工：
  66 UNETLoader → 73~77 LoRA → 69 ModelSamplingAuraFlow → 70 KSampler
  79 LoadImage → 78 VAEEncode → 70.latent_image；67/71 提示词；62 CLIP / 63 VAE
"""
from workflows.base import Workflow


class ZImageTurboI2I(Workflow):
    id = "z-image-turbo-图生图"
    name = "Z-Image-Turbo 图生图"
    description = "参考图重绘 · 8 步 · 最多 5 个 LoRA"
    kind = "image"
    needs_image = True
    supports_size = False
    supports_batch = False
    graph_file = "z-image-turbo-图生图.json"

    mapping = {
        "prompt": ["67", "inputs", "text"],
        "negative": ["71", "inputs", "text"],
        "seed": ["70", "inputs", "seed"],
        "steps": ["70", "inputs", "steps"],
        "cfg": ["70", "inputs", "cfg"],
        "sampler_name": ["70", "inputs", "sampler_name"],
        "scheduler": ["70", "inputs", "scheduler"],
        "denoise": ["70", "inputs", "denoise"],
        "unet": ["66", "inputs", "unet_name"],
        "clip": ["62", "inputs", "clip_name"],
        "vae": ["63", "inputs", "vae_name"],
        "image": ["79", "inputs", "image"],
    }

    param_map = {
        "negative": ["71", "inputs", "text"],
        "seed": ["70", "inputs", "seed"],
        "steps": ["70", "inputs", "steps"],
        "cfg": ["70", "inputs", "cfg"],
        "sampler_name": ["70", "inputs", "sampler_name"],
        "scheduler": ["70", "inputs", "scheduler"],
        "denoise": ["70", "inputs", "denoise"],
        "unet": ["66", "inputs", "unet_name"],
        "clip": ["62", "inputs", "clip_name"],
        "vae": ["63", "inputs", "vae_name"],
    }

    lora = {
        "nodes": ["73", "74", "75", "76", "77"],
        "source": ["66", 0],
        "target_node": "69",
        "target_input": "model",
        "strength_default": 1,
    }


WORKFLOW = ZImageTurboI2I()
